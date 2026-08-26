import { describe, it, expect } from "vitest";
import { buildForecast, calculateRunway, DailyMovement } from "../forecast";

/**
 * TRANCHE 15 — GOLDEN DATASET (permanent regression benchmark).
 *
 * Every expected value below is computed BY HAND from the business rules, NOT
 * by calling the implementation and asserting its output against itself. The
 * arithmetic rule is fixed and simple, which is exactly why it can be verified
 * independently:
 *
 *   closingBalance[day] = openingBalance[day] + inflows[day] - outflows[day]
 *   openingBalance[1]   = currentCash
 *   openingBalance[n]   = closingBalance[n-1]
 *   crisisDay           = first day whose closing < 0        (else null)
 *   firstDayBelowSafety = first day whose closing < threshold (else null)
 *   minimumBalance      = min(openingBalance[1], all closings)
 *
 * Amounts are integer paise. Horizon 14, forecast starts at day 1 (tomorrow).
 * If a later engine change breaks any of these, the change is wrong until
 * proven otherwise - these are the reference truths.
 */

const START = new Date(Date.UTC(2026, 0, 1));
const H = 14;
const day = (n: number) => new Date(START.getTime() + n * 86400000);
const L = (rupees: number) => Math.round(rupees * 100); // rupees -> paise
const SAFETY = L(428571); // ₹4,28,571 reference safety threshold

interface Golden {
  name: string;
  cash: number;
  movements: DailyMovement[];
  threshold?: number;
  expect: {
    finalClosing: number;
    crisisDay: number | null;
    firstDayBelowSafety: number | null;
    minimumBalance: number;
    deficitDays: number; // count of days with closing < 0
  };
}

const SCENARIOS: Golden[] = [
  {
    // 1. Healthy: ₹10L, nothing happens. Flat.
    name: "healthy business",
    cash: L(1_000_000),
    movements: [],
    expect: { finalClosing: L(1_000_000), crisisDay: null, firstDayBelowSafety: null, minimumBalance: L(1_000_000), deficitDays: 0 },
  },
  {
    // 2. Cash shortage: ₹5L, ₹8L outflow on day 3 -> -₹3L from day 3 onward.
    name: "cash shortage / crisis",
    cash: L(500_000),
    movements: [{ date: day(3), inflows: 0, outflows: L(800_000) }],
    // days 1-2: 500000; day 3-14: -300000. crisis day 3. 12 deficit days.
    expect: { finalClosing: L(-300_000), crisisDay: 3, firstDayBelowSafety: 3, minimumBalance: L(-300_000), deficitDays: 12 },
  },
  {
    // 3. Large upcoming expense but covered: ₹20L, ₹15L outflow day 5.
    name: "large upcoming expense, covered",
    cash: L(2_000_000),
    movements: [{ date: day(5), inflows: 0, outflows: L(1_500_000) }],
    // -> ₹5L from day 5. Never negative. Below safety from day 5 (500000 > 428571? yes 500000>428571 so NOT below). Stays safe.
    expect: { finalClosing: L(500_000), crisisDay: null, firstDayBelowSafety: null, minimumBalance: L(500_000), deficitDays: 0 },
  },
  {
    // 4. Recoverable position: ₹5L, ₹8L out day 3, ₹6L in day 6.
    name: "shortage then recovery",
    cash: L(500_000),
    movements: [
      { date: day(3), inflows: 0, outflows: L(800_000) },
      { date: day(6), inflows: L(600_000), outflows: 0 },
    ],
    // day1-2:500000; day3-5:-300000; day6-14:+300000. crisis day3. min -300000. deficit days = 3,4,5 = 3.
    expect: { finalClosing: L(300_000), crisisDay: 3, firstDayBelowSafety: 3, minimumBalance: L(-300_000), deficitDays: 3 },
  },
  {
    // 5. Multiple obligations same day net.
    name: "multiple same-day obligations",
    cash: L(1_000_000),
    movements: [
      { date: day(2), inflows: L(300_000), outflows: 0 },
      { date: day(2), inflows: 0, outflows: L(500_000) },
      { date: day(4), inflows: 0, outflows: L(200_000) },
    ],
    // day1:1000000; day2:1000000+300000-500000=800000; day3:800000; day4:600000; ...
    expect: { finalClosing: L(600_000), crisisDay: null, firstDayBelowSafety: null, minimumBalance: L(600_000), deficitDays: 0 },
  },
  {
    // 6. Exact liquidity boundary: cash == threshold, flat.
    // closing < threshold is STRICT, so == is NOT below.
    name: "exact liquidity boundary (== threshold)",
    cash: SAFETY,
    movements: [],
    threshold: SAFETY,
    expect: { finalClosing: SAFETY, crisisDay: null, firstDayBelowSafety: null, minimumBalance: SAFETY, deficitDays: 0 },
  },
  {
    // 7. One paise below threshold -> below on day 1.
    name: "one paise below threshold",
    cash: SAFETY - 1,
    movements: [],
    threshold: SAFETY,
    expect: { finalClosing: SAFETY - 1, crisisDay: null, firstDayBelowSafety: 1, minimumBalance: SAFETY - 1, deficitDays: 0 },
  },
  {
    // 8. One paise above threshold -> never below.
    name: "one paise above threshold",
    cash: SAFETY + 1,
    movements: [],
    threshold: SAFETY,
    expect: { finalClosing: SAFETY + 1, crisisDay: null, firstDayBelowSafety: null, minimumBalance: SAFETY + 1, deficitDays: 0 },
  },
  {
    // 9. Zero cash, ₹1L outflow day 2 -> negative day 2.
    name: "zero cash then outflow",
    cash: 0,
    movements: [{ date: day(2), inflows: 0, outflows: L(100_000) }],
    expect: { finalClosing: L(-100_000), crisisDay: 2, firstDayBelowSafety: 1, minimumBalance: L(-100_000), deficitDays: 13 },
  },
  {
    // 10. Negative starting cash -> crisis day 1.
    name: "negative starting cash",
    cash: L(-50_000),
    movements: [],
    expect: { finalClosing: L(-50_000), crisisDay: 1, firstDayBelowSafety: 1, minimumBalance: L(-50_000), deficitDays: 14 },
  },
  {
    // 11. Zero burn, zero income -> flat at cash.
    name: "zero burn zero income",
    cash: L(750_000),
    movements: [],
    expect: { finalClosing: L(750_000), crisisDay: null, firstDayBelowSafety: null, minimumBalance: L(750_000), deficitDays: 0 },
  },
  {
    // 12. Large financial values, no overflow. ₹9,00,00,00,000 (90 crore rupees).
    name: "large values no overflow",
    cash: L(9_000_000_000),
    movements: [{ date: day(7), inflows: 0, outflows: L(1_000_000_000) }],
    // -> ₹8,00,00,00,000 from day 7.
    expect: { finalClosing: L(8_000_000_000), crisisDay: null, firstDayBelowSafety: null, minimumBalance: L(8_000_000_000), deficitDays: 0 },
  },
];

describe("GOLDEN DATASET — forecast/runway independently verified", () => {
  it.each(SCENARIOS)("$name", (sc) => {
    const forecast = buildForecast(sc.cash, sc.movements, H, START);
    const runway = calculateRunway(forecast, sc.threshold ?? SAFETY);

    expect(forecast, `${sc.name}: horizon`).toHaveLength(H);
    expect(forecast[forecast.length - 1].closingBalance, `${sc.name}: final closing`).toBe(sc.expect.finalClosing);
    expect(runway.crisisDay, `${sc.name}: crisisDay`).toBe(sc.expect.crisisDay);
    expect(runway.firstDayBelowSafety, `${sc.name}: firstDayBelowSafety`).toBe(sc.expect.firstDayBelowSafety);
    expect(runway.minimumBalance, `${sc.name}: minimumBalance`).toBe(sc.expect.minimumBalance);

    const deficitDays = forecast.filter((d) => d.closingBalance < 0).length;
    expect(deficitDays, `${sc.name}: deficitDays`).toBe(sc.expect.deficitDays);

    // No value is ever NaN/Infinity.
    for (const d of forecast) expect(Number.isFinite(d.closingBalance)).toBe(true);
  });

  it("the dataset is deterministic: a second run matches the first exactly", () => {
    for (const sc of SCENARIOS) {
      const a = buildForecast(sc.cash, sc.movements, H, START).map((d) => d.closingBalance);
      const b = buildForecast(sc.cash, sc.movements, H, START).map((d) => d.closingBalance);
      expect(b).toEqual(a);
    }
  });
});
