import { describe, it, expect } from "vitest";
import { buildScenarios } from "../scenarios";
import { transactionsToForecastEvents, applyExpectedTiming } from "../forecastEvent";
import { computePaymentBehavior, type PaymentBehavior } from "@/lib/behavior/paymentBehavior";
import { buildForecast } from "@/lib/engine/forecast";
import type { TransactionRecord } from "@/lib/db/records";

const NOW = new Date("2026-09-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (d: number) => new Date(NOW.getTime() + d * DAY);

function tx(over: Partial<TransactionRecord> & { id: string }): TransactionRecord {
  return {
    amount: 500000_00,
    type: "INFLOW",
    status: "PENDING",
    expectedDate: at(3),
    description: null,
    ...over,
  };
}

/** Behaviour from `count` payments, each `delay` days late with `jitter` spread. */
function behavior(delay: number, jitter = 0, count = 8): PaymentBehavior {
  return computePaymentBehavior(
    Array.from({ length: count }, (_, i) => {
      const paidDate = at(-(5 + i * 10));
      const d = delay + (i % 2 === 0 ? jitter : -jitter);
      return {
        id: `p${i}`,
        amount: 100_00,
        dueDate: new Date(paidDate.getTime() - d * DAY),
        paidDate,
      };
    }),
    { now: NOW }
  );
}

const CASH = 1000000_00;
const opts = { startDate: NOW, horizonDays: 14, requiredBuffer: 700000_00 };

describe("with no behaviour, all three scenarios coincide", () => {
  const events = transactionsToForecastEvents([
    tx({ id: "t1" }),
    tx({ id: "t2", type: "OUTFLOW", expectedDate: at(5) }),
  ]);

  it("is degenerate and identical to the ordinary forecast", () => {
    const s = buildScenarios(CASH, events, opts);

    expect(s.degenerate).toBe(true);
    expect(s.optimistic.days).toStrictEqual(s.base.days);
    expect(s.conservative.days).toStrictEqual(s.base.days);

    // And identical to what buildForecast produces on its own.
    const plain = buildForecast(
      CASH,
      events.map((e) => ({
        date: e.expectedDate,
        inflows: e.kind === "INFLOW" ? e.amount : 0,
        outflows: e.kind === "OUTFLOW" ? e.amount : 0,
        description: e.description || undefined,
        transactionId: e.id,
      })),
      14,
      NOW
    );
    expect(s.base.days).toStrictEqual(plain);
  });

  it("reports LOW confidence, not HIGH — a zero spread is ignorance, not certainty", () => {
    // The single most important assertion in this file. A tidy single-line
    // forecast built entirely on contractual dates must not look confident.
    const s = buildScenarios(CASH, events, opts);

    expect(s.confidence.level).toBe("LOW");
    expect(s.confidence.eventsWithMeasuredTiming).toBe(0);
    expect(s.confidence.reasons[0]).toMatch(/no payment history has been measured/);
  });

  it("reports UNKNOWN when there is nothing in the horizon at all", () => {
    const s = buildScenarios(CASH, [], opts);
    expect(s.confidence.level).toBe("UNKNOWN");
    expect(s.confidence.eventsTotal).toBe(0);
  });
});

describe("with measured behaviour, the scenarios separate", () => {
  const measured = () => {
    const [e] = transactionsToForecastEvents([tx({ id: "t1", expectedDate: at(3) })]);
    return [applyExpectedTiming(e, behavior(6, 3))];
  };

  it("brackets the base case on both sides", () => {
    const s = buildScenarios(CASH, measured(), opts);

    expect(s.degenerate).toBe(false);
    // Optimistic is never worse than base; conservative is never better.
    expect(s.optimistic.minimumBalance).toBeGreaterThanOrEqual(s.base.minimumBalance);
    expect(s.conservative.minimumBalance).toBeLessThanOrEqual(s.base.minimumBalance);
  });

  it("takes an inflow LATE in the conservative case and EARLY in the optimistic", () => {
    const [event] = measured();
    const s = buildScenarios(0, [event], opts);

    // Cash arrives on the early edge in the optimistic world...
    const earlyDay = Math.round((event.earliestDate.getTime() - NOW.getTime()) / DAY);
    const lateDay = Math.round((event.latestDate.getTime() - NOW.getTime()) / DAY);
    expect(s.optimistic.days[earlyDay - 1].expectedInflows).toBe(500000_00);
    // ...and on the late edge in the conservative one.
    expect(s.conservative.days[lateDay - 1].expectedInflows).toBe(500000_00);
    expect(s.conservative.days[earlyDay - 1].expectedInflows).toBe(0);
  });

  it("mirrors the rule for outflows — early when conservative, late when optimistic", () => {
    const [out] = transactionsToForecastEvents([
      tx({ id: "t1", type: "OUTFLOW", expectedDate: at(6) }),
    ]);
    // Outflows are never behaviour-shifted, so widen the band by hand to prove
    // the scenario rule itself.
    const banded = { ...out, earliestDate: at(4), latestDate: at(8) };
    const s = buildScenarios(CASH, [banded], opts);

    expect(s.conservative.days[3].expectedOutflows).toBe(500000_00);
    expect(s.optimistic.days[7].expectedOutflows).toBe(500000_00);
  });

  it("can turn a comfortable base case into a conservative shortfall", () => {
    // The reason scenarios exist: the base line clears the buffer, the
    // conservative one does not, and only one of those is worth acting on.
    const [inflow] = transactionsToForecastEvents([
      tx({ id: "in", amount: 400000_00, expectedDate: at(3) }),
    ]);
    const shifted = applyExpectedTiming(inflow, behavior(4, 4));
    const [outflow] = transactionsToForecastEvents([
      tx({ id: "out", amount: 600000_00, type: "OUTFLOW", expectedDate: at(8) }),
    ]);

    const s = buildScenarios(300000_00, [shifted, outflow], {
      ...opts,
      requiredBuffer: 100000_00,
    });

    expect(s.base.minimumBalance).toBeGreaterThan(s.conservative.minimumBalance);
    expect(s.conservative.minimumBalance).toBeLessThan(s.optimistic.minimumBalance);
  });

  it("reports the outcome spread the three scenarios imply", () => {
    const s = buildScenarios(CASH, measured(), opts);
    expect(s.confidence.outcomeSpread).toBe(
      Math.abs(s.optimistic.minimumBalance - s.conservative.minimumBalance)
    );
  });
});

describe("confidence tracks how much is actually measured (spec §29)", () => {
  function eventsWithCoverage(measuredCount: number, total: number, jitter = 0) {
    return Array.from({ length: total }, (_, i) => {
      const [e] = transactionsToForecastEvents([tx({ id: `t${i}`, expectedDate: at(3) })]);
      return i < measuredCount ? applyExpectedTiming(e, behavior(4, jitter)) : e;
    });
  }

  it("is HIGH when nearly everything is measured and the band is tight", () => {
    const s = buildScenarios(CASH, eventsWithCoverage(5, 5, 1), opts);
    expect(s.confidence.level).toBe("HIGH");
    expect(s.confidence.eventsWithMeasuredTiming).toBe(5);
  });

  it("falls to MEDIUM when much of the forecast is still assumed", () => {
    const s = buildScenarios(CASH, eventsWithCoverage(3, 6, 1), opts);
    expect(s.confidence.level).toBe("MEDIUM");
    expect(s.confidence.reasons[0]).toMatch(/the rest assume contractual dates/);
  });

  it("falls to LOW when almost nothing is measured", () => {
    const s = buildScenarios(CASH, eventsWithCoverage(1, 10, 1), opts);
    expect(s.confidence.level).toBe("LOW");
  });

  it("is not HIGH when behaviour is measured but wildly inconsistent", () => {
    // Full coverage, but a customer whose timing swings by 12 days is not a
    // confident forecast.
    const s = buildScenarios(CASH, eventsWithCoverage(5, 5, 6), opts);
    expect(s.confidence.level).not.toBe("HIGH");
    expect(s.confidence.widestBandDays).toBeGreaterThan(6);
    expect(s.confidence.reasons.some((r) => /varies by up to/.test(r))).toBe(true);
  });

  it("gives reasons a person could act on", () => {
    const s = buildScenarios(CASH, eventsWithCoverage(5, 5, 1), opts);
    expect(s.confidence.reasons.length).toBeGreaterThan(0);
    for (const r of s.confidence.reasons) expect(r.length).toBeGreaterThan(20);
  });
});

describe("determinism and invariants", () => {
  const events = [
    applyExpectedTiming(
      transactionsToForecastEvents([tx({ id: "t1" })])[0],
      behavior(5, 2)
    ),
    transactionsToForecastEvents([tx({ id: "t2", type: "OUTFLOW", expectedDate: at(7) })])[0],
  ];

  it("produces the same set on repeated calls", () => {
    const first = buildScenarios(CASH, events, opts);
    for (let i = 0; i < 3; i++) expect(buildScenarios(CASH, events, opts)).toEqual(first);
  });

  it("is independent of event order", () => {
    const a = buildScenarios(CASH, events, opts);
    const b = buildScenarios(CASH, [...events].reverse(), opts);
    expect(a.base.minimumBalance).toBe(b.base.minimumBalance);
    expect(a.conservative.minimumBalance).toBe(b.conservative.minimumBalance);
  });

  it("orders the minimum balance consistently for any input", () => {
    for (const jitter of [0, 1, 3, 7]) {
      const s = buildScenarios(
        CASH,
        [applyExpectedTiming(transactionsToForecastEvents([tx({ id: "x" })])[0], behavior(4, jitter))],
        opts
      );
      expect(s.optimistic.minimumBalance).toBeGreaterThanOrEqual(s.conservative.minimumBalance);
    }
  });

  it("can push an event out of the horizon entirely at a band edge", () => {
    // A wide band on an early event puts its optimistic edge BEFORE day 1, so
    // that cash is simply not in a forward 14-day window. Closing balances are
    // therefore not comparable across scenarios in general - only the minimum
    // ordering is. Documented rather than asserted away.
    const wide = applyExpectedTiming(
      transactionsToForecastEvents([tx({ id: "x", expectedDate: at(3) })])[0],
      behavior(4, 7)
    );
    expect(wide.earliestDate.getTime()).toBeLessThanOrEqual(NOW.getTime());

    const s = buildScenarios(CASH, [wide], opts);
    expect(s.optimistic.closingBalance).toBeLessThan(s.base.closingBalance);
    // The money is not lost - it landed before the window opened.
    expect(s.base.closingBalance).toBe(CASH + 500000_00);
  });

  it("keeps the closing balance identical across scenarios inside the horizon", () => {
    // Timing moves WHEN cash lands, not how much. Anything else would mean a
    // scenario had invented or destroyed money.
    const s = buildScenarios(CASH, events, opts);
    expect(s.optimistic.closingBalance).toBe(s.base.closingBalance);
    expect(s.conservative.closingBalance).toBe(s.base.closingBalance);
  });
});
