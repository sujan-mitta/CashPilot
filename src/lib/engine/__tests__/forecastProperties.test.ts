import { describe, it, expect } from "vitest";
import { buildForecast, calculateRunway, DailyMovement } from "../forecast";

/**
 * TRANCHE 1 + 2 — forecast/runway correctness by property.
 *
 * The forecast is the base of every downstream decision, so its arithmetic must
 * hold not just for hand-picked cases but for arbitrary inputs. These tests
 * assert mathematical INVARIANTS over thousands of seeded-random scenarios, so
 * a regression in the running-balance chain is caught regardless of the exact
 * numbers.
 *
 * Reproducibility: a deterministic mulberry32 PRNG seeded per case. A failure
 * prints its seed, and the seed can be pinned as a fixture.
 */

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Amounts are integer paise, mirroring the app's exact-money representation. */
function randomScenario(rng: () => number, startUtc: Date, horizon: number) {
  const currentCash = Math.floor((rng() - 0.3) * 5_000_000_00); // may be negative
  const n = Math.floor(rng() * 12);
  const movements: DailyMovement[] = [];
  for (let i = 0; i < n; i++) {
    // Some movements land outside the horizon on purpose.
    const dayOffset = Math.floor(rng() * (horizon + 6)) + 1;
    const d = new Date(startUtc.getTime() + dayOffset * 86400000);
    const isInflow = rng() > 0.5;
    const amt = Math.floor(rng() * 2_000_000_00);
    movements.push({
      date: d,
      inflows: isInflow ? amt : 0,
      outflows: isInflow ? 0 : amt,
    });
  }
  return { currentCash, movements };
}

const START = new Date(Date.UTC(2026, 0, 1));
const HORIZON = 14;

describe("forecast invariants (property-based)", () => {
  it("closing = opening + inflows - outflows, every day, every scenario", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const rng = mulberry32(seed);
      const { currentCash, movements } = randomScenario(rng, START, HORIZON);
      const f = buildForecast(currentCash, movements, HORIZON, START);
      for (const day of f) {
        expect(
          day.closingBalance,
          `seed ${seed}: closing != opening + in - out`
        ).toBe(day.openingBalance + day.expectedInflows - day.expectedOutflows);
      }
    }
  });

  it("day N opening equals day N-1 closing (the running-balance chain)", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const rng = mulberry32(seed);
      const { currentCash, movements } = randomScenario(rng, START, HORIZON);
      const f = buildForecast(currentCash, movements, HORIZON, START);
      expect(f[0].openingBalance, `seed ${seed}: day1 opening != currentCash`).toBe(currentCash);
      for (let i = 1; i < f.length; i++) {
        expect(f[i].openingBalance, `seed ${seed}: chain broken at day ${i + 1}`).toBe(
          f[i - 1].closingBalance
        );
      }
    }
  });

  it("final closing = currentCash + (inflows - outflows) that fall INSIDE the horizon", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const rng = mulberry32(seed);
      const { currentCash, movements } = randomScenario(rng, START, HORIZON);
      const f = buildForecast(currentCash, movements, HORIZON, START);
      const insideNet = f.reduce((s, d) => s + d.expectedInflows - d.expectedOutflows, 0);
      expect(f[f.length - 1].closingBalance, `seed ${seed}`).toBe(currentCash + insideNet);
    }
  });

  it("crisisDay is exactly the first day with a negative closing balance", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const rng = mulberry32(seed);
      const { currentCash, movements } = randomScenario(rng, START, HORIZON);
      const f = buildForecast(currentCash, movements, HORIZON, START);
      const { crisisDay } = calculateRunway(f, 0);
      const firstNeg = f.findIndex((d) => d.closingBalance < 0);
      expect(crisisDay, `seed ${seed}`).toBe(firstNeg === -1 ? null : firstNeg + 1);
    }
  });

  it("minimumBalance is <= every closing balance in the horizon", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const rng = mulberry32(seed);
      const { currentCash, movements } = randomScenario(rng, START, HORIZON);
      const f = buildForecast(currentCash, movements, HORIZON, START);
      const { minimumBalance } = calculateRunway(f);
      for (const d of f) expect(minimumBalance, `seed ${seed}`).toBeLessThanOrEqual(d.closingBalance);
    }
  });

  it("no forecast value is ever NaN or Infinity, even with extreme inputs", () => {
    const extremes = [0, -1, 1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER];
    for (const cash of extremes) {
      const f = buildForecast(cash, [], HORIZON, START);
      for (const d of f) {
        expect(Number.isFinite(d.closingBalance)).toBe(true);
        expect(Number.isFinite(d.openingBalance)).toBe(true);
      }
    }
  });
});

describe("forecast edge cases (explicit)", () => {
  it("zero transactions: balance stays flat at currentCash", () => {
    const f = buildForecast(100_000_00, [], HORIZON, START);
    expect(f.every((d) => d.closingBalance === 100_000_00)).toBe(true);
    expect(f).toHaveLength(HORIZON);
  });

  it("income only: balance rises and never falls", () => {
    const movements: DailyMovement[] = [{ date: new Date(START.getTime() + 3 * 86400000), inflows: 50_000_00, outflows: 0 }];
    const f = buildForecast(100_000_00, movements, HORIZON, START);
    expect(f[f.length - 1].closingBalance).toBe(150_000_00);
    for (let i = 1; i < f.length; i++) expect(f[i].closingBalance).toBeGreaterThanOrEqual(f[i - 1].closingBalance);
  });

  it("expenses only: balance declines correctly and can go negative", () => {
    const movements: DailyMovement[] = [{ date: new Date(START.getTime() + 2 * 86400000), inflows: 0, outflows: 150_000_00 }];
    const f = buildForecast(100_000_00, movements, HORIZON, START);
    expect(f[f.length - 1].closingBalance).toBe(-50_000_00);
    expect(calculateRunway(f, 0).crisisDay).toBe(2);
  });

  it("same-day inflow and outflow net correctly", () => {
    const day = new Date(START.getTime() + 1 * 86400000);
    const movements: DailyMovement[] = [
      { date: day, inflows: 30_000_00, outflows: 0 },
      { date: day, inflows: 0, outflows: 20_000_00 },
    ];
    const f = buildForecast(100_000_00, movements, HORIZON, START);
    expect(f[0].closingBalance).toBe(110_000_00); // +30 -20
  });

  it("movements outside the horizon are excluded", () => {
    const movements: DailyMovement[] = [{ date: new Date(START.getTime() + 999 * 86400000), inflows: 0, outflows: 500_000_00 }];
    const f = buildForecast(100_000_00, movements, HORIZON, START);
    expect(f.every((d) => d.closingBalance === 100_000_00)).toBe(true);
  });

  it("zero-day horizon yields an empty forecast, not a crash", () => {
    expect(buildForecast(100_000_00, [], 0, START)).toHaveLength(0);
    // Runway on an empty forecast is well-defined, not NaN.
    const r = calculateRunway([], 0);
    expect(r.crisisDay).toBeNull();
    expect(Number.isFinite(r.minimumBalance)).toBe(true);
  });
});
