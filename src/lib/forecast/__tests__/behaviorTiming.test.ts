import { describe, it, expect } from "vitest";
import {
  buildMovements,
  transactionsToForecastEvents,
  applyExpectedTiming,
} from "../forecastEvent";
import { computePaymentBehavior, type PaymentBehavior } from "@/lib/behavior/paymentBehavior";
import { transactionsToMovements, buildForecast } from "@/lib/engine/forecast";
import type { TransactionRecord } from "@/lib/db/records";

/**
 * Phase 9 integration: behaviour actually moving a forecast.
 *
 * Two obligations to hold at once:
 *   - with no behaviour, Phase 8's parity must still hold EXACTLY
 *   - with sufficient behaviour, the forecast must genuinely move
 */

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

/** A counterparty that reliably pays `delay` days late, from `count` payments. */
function behaviorFor(delay: number, count = 8): PaymentBehavior {
  return computePaymentBehavior(
    Array.from({ length: count }, (_, i) => {
      const paidDate = at(-(5 + i * 10));
      return {
        id: `p${i}`,
        amount: 100_00,
        dueDate: new Date(paidDate.getTime() - delay * DAY),
        paidDate,
      };
    }),
    { now: NOW }
  );
}

const CASH = 1000000_00;

describe("no behaviour means no change (Phase 8 parity preserved)", () => {
  const transactions = [
    tx({ id: "t1", counterpartyId: "cp_1" }),
    tx({ id: "t2", type: "OUTFLOW", expectedDate: at(5) }),
    tx({ id: "t3", status: "FAILED" }),
  ];

  it("matches the current path when no behaviour map is supplied", () => {
    const current = transactionsToMovements(
      transactions.map((t) => ({
        id: t.id,
        amount: t.amount,
        type: t.type as "INFLOW" | "OUTFLOW",
        status: t.status,
        expectedDate: new Date(t.expectedDate),
        description: t.description ?? null,
      }))
    );
    expect(buildMovements(transactions, { useEventPipeline: true })).toStrictEqual(current);
  });

  it("matches when the map has no entry for this counterparty", () => {
    const withMap = buildMovements(transactions, {
      useEventPipeline: true,
      behaviorByCounterparty: new Map([["someone_else", behaviorFor(6)]]),
    });
    expect(withMap).toStrictEqual(buildMovements(transactions, { useEventPipeline: true }));
  });

  it("matches when the transaction carries no counterparty link", () => {
    const unlinked = [tx({ id: "t1" })];
    const withMap = buildMovements(unlinked, {
      useEventPipeline: true,
      behaviorByCounterparty: new Map([["cp_1", behaviorFor(6)]]),
    });
    expect(withMap).toStrictEqual(buildMovements(unlinked, { useEventPipeline: true }));
  });

  it("matches when the behaviour is merely SPARSE", () => {
    // Three payments is observable but not actionable.
    const sparse = behaviorFor(6, 3);
    expect(sparse.sufficiency).toBe("SPARSE");

    const withSparse = buildMovements([tx({ id: "t1", counterpartyId: "cp_1" })], {
      useEventPipeline: true,
      behaviorByCounterparty: new Map([["cp_1", sparse]]),
    });
    expect(withSparse).toStrictEqual(
      buildMovements([tx({ id: "t1", counterpartyId: "cp_1" })], { useEventPipeline: true })
    );
  });

  it("matches when the expected delay rounds to zero days", () => {
    // A sub-day adjustment cannot survive day bucketing, so it must not
    // manufacture churn or evidence-free precision.
    const nearlyOnTime = behaviorFor(0.2);
    expect(nearlyOnTime.sufficiency).toBe("SUFFICIENT");

    const withIt = buildMovements([tx({ id: "t1", counterpartyId: "cp_1" })], {
      useEventPipeline: true,
      behaviorByCounterparty: new Map([["cp_1", nearlyOnTime]]),
    });
    expect(withIt).toStrictEqual(
      buildMovements([tx({ id: "t1", counterpartyId: "cp_1" })], { useEventPipeline: true })
    );
  });
});

describe("sufficient behaviour moves the forecast (spec §23, §24)", () => {
  it("shifts an inflow from a reliably-late customer", () => {
    const behavior = behaviorFor(6);
    expect(behavior.sufficiency).toBe("SUFFICIENT");

    const [event] = transactionsToForecastEvents(
      [tx({ id: "t1", counterpartyId: "cp_1", expectedDate: at(3) })],
      new Map([["cp_1", behavior]])
    );

    // Contractual date is preserved, expectation moves off it.
    expect(event.contractualDate).toStrictEqual(at(3));
    expect(event.expectedDate).toStrictEqual(at(9));
    expect(event.earliestDate.getTime()).toBeLessThanOrEqual(event.expectedDate.getTime());
    expect(event.latestDate.getTime()).toBeGreaterThanOrEqual(event.expectedDate.getTime());
  });

  it("moves the cash into a later forecast day", () => {
    const movements = buildMovements([tx({ id: "t1", counterpartyId: "cp_1" })], {
      useEventPipeline: true,
      behaviorByCounterparty: new Map([["cp_1", behaviorFor(6)]]),
    });
    const days = buildForecast(CASH, movements, 14, NOW);

    // Contractual day 3 is now empty; the money lands on day 9 instead.
    expect(days[2].expectedInflows).toBe(0);
    expect(days[8].expectedInflows).toBe(500000_00);
  });

  it("pulls an early payer forward", () => {
    const [event] = transactionsToForecastEvents(
      [tx({ id: "t1", counterpartyId: "cp_1", expectedDate: at(10) })],
      new Map([["cp_1", behaviorFor(-4)]])
    );
    expect(event.expectedDate).toStrictEqual(at(6));
  });

  it("changes the projected minimum when a receivable slips past an obligation", () => {
    // The reason this phase matters: cash that used to arrive before a payout
    // now arrives after it, and the trough is real rather than hypothetical.
    const transactions = [
      tx({ id: "in", amount: 400000_00, counterpartyId: "cp_1", expectedDate: at(3) }),
      tx({ id: "out", amount: 600000_00, type: "OUTFLOW", expectedDate: at(5) }),
    ];

    const naive = buildForecast(
      300000_00,
      buildMovements(transactions, { useEventPipeline: true }),
      14,
      NOW
    );
    const behavioural = buildForecast(
      300000_00,
      buildMovements(transactions, {
        useEventPipeline: true,
        behaviorByCounterparty: new Map([["cp_1", behaviorFor(6)]]),
      }),
      14,
      NOW
    );

    const naiveMin = Math.min(...naive.map((d) => d.closingBalance));
    const behaviouralMin = Math.min(...behavioural.map((d) => d.closingBalance));

    expect(naiveMin).toBeGreaterThanOrEqual(0);
    expect(behaviouralMin).toBeLessThan(naiveMin);
  });

  it("does NOT shift outflows - a payout date is our decision, not theirs", () => {
    const [event] = transactionsToForecastEvents(
      [tx({ id: "t1", type: "OUTFLOW", counterpartyId: "cp_1", expectedDate: at(3) })],
      new Map([["cp_1", behaviorFor(6)]])
    );
    expect(event.expectedDate).toStrictEqual(at(3));
    expect(event.timingBasis).toEqual([]);
  });

  it("records why, in language a person can read (spec §58)", () => {
    const [event] = transactionsToForecastEvents(
      [tx({ id: "t1", counterpartyId: "cp_1" })],
      new Map([["cp_1", behaviorFor(6)]])
    );

    expect(event.timingBasis[0]).toMatch(/expected 6 day\(s\) later than the contractual date/);
    expect(event.timingBasis.join(" ")).toMatch(/8 settled payments/);
    // A shifted event is attributed to the model that shifted it.
    expect(event.sourceType).toBe("HISTORICAL");
  });

  it("leaves timingBasis empty whenever the date was not moved", () => {
    // So a non-empty basis is a guarantee that an adjustment happened.
    const [unshifted] = transactionsToForecastEvents([tx({ id: "t1" })]);
    expect(unshifted.timingBasis).toEqual([]);
    expect(unshifted.expectedDate).toStrictEqual(unshifted.contractualDate);
  });
});

describe("applyExpectedTiming directly", () => {
  const [base] = transactionsToForecastEvents([tx({ id: "t1", expectedDate: at(3) })]);

  it("is the identity when given no behaviour", () => {
    expect(applyExpectedTiming(base)).toStrictEqual(base);
    expect(applyExpectedTiming(base, null)).toStrictEqual(base);
  });

  it("widens the band by the observed spread", () => {
    const erratic = computePaymentBehavior(
      Array.from({ length: 10 }, (_, i) => {
        const paidDate = at(-(5 + i * 10));
        const delay = i % 2 === 0 ? 2 : 10;
        return {
          id: `p${i}`,
          amount: 100_00,
          dueDate: new Date(paidDate.getTime() - delay * DAY),
          paidDate,
        };
      }),
      { now: NOW }
    );

    const adjusted = applyExpectedTiming(base, erratic);
    const spreadDays =
      (adjusted.latestDate.getTime() - adjusted.earliestDate.getTime()) / DAY;

    // An unpredictable payer gets a wide band, not a confident point estimate.
    expect(spreadDays).toBeGreaterThan(0);
    expect(erratic.behaviorStability!).toBeLessThan(0.5);
  });
});
