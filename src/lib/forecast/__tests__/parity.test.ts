import { describe, it, expect } from "vitest";
import {
  buildMovements,
  transactionsToForecastEvents,
  forecastEventsToMovements,
  applyExpectedTiming,
  FORECAST_EVENT_PIPELINE,
  type ForecastEvent,
} from "../forecastEvent";
import { transactionsToMovements, buildForecast, calculateRunway } from "@/lib/engine/forecast";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import type { TransactionRecord } from "@/lib/db/records";

/**
 * Phase 8 parity suite.
 *
 * The event pipeline is a seam, not a behaviour change. These tests are the
 * evidence for that claim: for every input shape, routing through ForecastEvents
 * must produce movements STRICTLY equal to the path the product has always run -
 * same values, same keys, same order.
 *
 * `toStrictEqual` is deliberate. `toEqual` ignores keys whose value is
 * undefined, which would let the event path quietly grow an extra field.
 */

const T0 = new Date("2026-09-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (d: number) => new Date(T0.getTime() + d * DAY);

function tx(over: Partial<TransactionRecord> & { id: string }): TransactionRecord {
  return {
    amount: 100_00,
    type: "INFLOW",
    status: "PENDING",
    expectedDate: at(3),
    description: null,
    ...over,
  };
}

/** Every input shape that has ever mattered to this mapping. */
const CASES: Array<{ name: string; transactions: TransactionRecord[] }> = [
  { name: "empty ledger", transactions: [] },
  { name: "single pending inflow", transactions: [tx({ id: "t1" })] },
  { name: "single outflow", transactions: [tx({ id: "t1", type: "OUTFLOW" })] },
  {
    name: "failed transactions are excluded",
    transactions: [tx({ id: "t1", status: "FAILED" }), tx({ id: "t2" })],
  },
  {
    name: "all failed",
    transactions: [tx({ id: "t1", status: "FAILED" }), tx({ id: "t2", status: "FAILED" })],
  },
  {
    name: "settled and pending mixed",
    transactions: [
      tx({ id: "t1", status: "SUCCESS" }),
      tx({ id: "t2", status: "PENDING" }),
      tx({ id: "t3", status: "FAILED" }),
    ],
  },
  {
    name: "descriptions present, empty and null",
    transactions: [
      tx({ id: "t1", description: "Retail Chain A" }),
      tx({ id: "t2", description: "" }),
      tx({ id: "t3", description: null }),
    ],
  },
  {
    name: "same-day collisions",
    transactions: [
      tx({ id: "t1", expectedDate: at(2) }),
      tx({ id: "t2", expectedDate: at(2), type: "OUTFLOW" }),
      tx({ id: "t3", expectedDate: at(2) }),
    ],
  },
  {
    name: "dates as ISO strings, as they arrive from Json snapshots",
    transactions: [tx({ id: "t1", expectedDate: at(4).toISOString() })],
  },
  {
    name: "zero and negative amounts",
    transactions: [
      tx({ id: "t1", amount: 0 }),
      tx({ id: "t2", amount: -500 }),
      tx({ id: "t3", amount: -500, type: "OUTFLOW" }),
    ],
  },
  {
    name: "dates outside the horizon",
    transactions: [tx({ id: "t1", expectedDate: at(-30) }), tx({ id: "t2", expectedDate: at(400) })],
  },
  {
    name: "an unrecognised type contributes nothing, as before",
    transactions: [tx({ id: "t1", type: "WEIRD" }), tx({ id: "t2", type: "" })],
  },
  {
    name: "large ledger",
    transactions: Array.from({ length: 200 }, (_, i) =>
      tx({
        id: `t${i}`,
        amount: (i + 1) * 137,
        type: i % 3 === 0 ? "OUTFLOW" : "INFLOW",
        status: i % 7 === 0 ? "FAILED" : "PENDING",
        expectedDate: at(i % 30),
        description: i % 5 === 0 ? `movement ${i}` : null,
      })
    ),
  },
];

describe("movement parity: event pipeline vs the current path", () => {
  for (const c of CASES) {
    it(`produces strictly identical movements — ${c.name}`, () => {
      const current = transactionsToMovements(
        c.transactions.map((t) => ({
          id: t.id,
          amount: t.amount,
          type: t.type as "INFLOW" | "OUTFLOW",
          status: t.status,
          expectedDate: new Date(t.expectedDate),
          description: t.description ?? null,
        }))
      );
      const viaEvents = buildMovements(c.transactions, { useEventPipeline: true });

      expect(viaEvents).toStrictEqual(current);
    });
  }

  it("produces identical movements with the flag off, by definition", () => {
    for (const c of CASES) {
      expect(buildMovements(c.transactions, { useEventPipeline: false })).toStrictEqual(
        buildMovements(c.transactions, { useEventPipeline: true })
      );
    }
  });

  it("carries exactly the keys the existing mapping produces", () => {
    const viaEvents = buildMovements([tx({ id: "t1" })], { useEventPipeline: true });
    expect(Object.keys(viaEvents[0]).sort()).toEqual([
      "date",
      "description",
      "inflows",
      "outflows",
      "transactionId",
    ]);
  });

  it("preserves input order", () => {
    const txs = [tx({ id: "a" }), tx({ id: "b" }), tx({ id: "c" })];
    expect(
      buildMovements(txs, { useEventPipeline: true }).map((m) => m.transactionId)
    ).toEqual(["a", "b", "c"]);
  });
});

describe("forecast parity: the numbers a CFO sees", () => {
  const CASH = 1000000_00;

  for (const c of CASES) {
    it(`produces an identical forecast — ${c.name}`, () => {
      const current = buildForecast(
        CASH,
        transactionsToMovements(
          c.transactions.map((t) => ({
            id: t.id,
            amount: t.amount,
            type: t.type as "INFLOW" | "OUTFLOW",
            status: t.status,
            expectedDate: new Date(t.expectedDate),
            description: t.description ?? null,
          }))
        ),
        FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
        T0
      );
      const viaEvents = buildForecast(
        CASH,
        buildMovements(c.transactions, { useEventPipeline: true }),
        FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
        T0
      );

      expect(viaEvents).toStrictEqual(current);
      // And the derived risk metrics a decision actually rests on.
      expect(calculateRunway(viaEvents, 700000_00)).toStrictEqual(
        calculateRunway(current, 700000_00)
      );
    });
  }
});

describe("ForecastEvent shape (spec §22)", () => {
  it("does not invent an expectation the evidence cannot support", () => {
    const [e] = transactionsToForecastEvents([tx({ id: "t1", expectedDate: at(5) })]);

    // Until the behaviour model exists, the contractual date IS the
    // expectation, the band is collapsed, and nothing claims otherwise.
    expect(e.expectedDate).toStrictEqual(e.contractualDate);
    expect(e.earliestDate).toStrictEqual(e.contractualDate);
    expect(e.latestDate).toStrictEqual(e.contractualDate);
    expect(e.probability).toBe(1);
    expect(e.timingBasis).toEqual([]);
    expect(e.evidenceIds).toEqual([]);
  });

  it("keeps contractual and expected as separate fields even while equal", () => {
    // The split is the point: P9 moves one and not the other.
    const [e] = transactionsToForecastEvents([tx({ id: "t1" })]);
    expect(Object.keys(e)).toContain("contractualDate");
    expect(Object.keys(e)).toContain("expectedDate");
  });

  it("records source provenance from the Phase 3 reliability model", () => {
    const [e] = transactionsToForecastEvents([tx({ id: "t1" })]);
    expect(e.sourceType).toBe("BANK");
    expect(e.sourceConfidence).toBeGreaterThan(0.9);
  });

  it("excludes failed transactions, exactly as the current mapping does", () => {
    const events = transactionsToForecastEvents([
      tx({ id: "t1", status: "FAILED" }),
      tx({ id: "t2" }),
    ]);
    expect(events.map((e) => e.id)).toEqual(["t2"]);
  });

  it("marks an unrecognised type UNKNOWN rather than guessing a direction", () => {
    // Guessing OUTFLOW here would invent an outflow the ledger never recorded.
    const [e] = transactionsToForecastEvents([tx({ id: "t1", type: "WEIRD" })]);
    expect(e.kind).toBe("UNKNOWN");

    const [m] = forecastEventsToMovements([e]);
    expect(m.inflows).toBe(0);
    expect(m.outflows).toBe(0);
  });
});

describe("the P9 extension point", () => {
  it("is the identity function today", () => {
    const [e] = transactionsToForecastEvents([tx({ id: "t1" })]);
    expect(applyExpectedTiming(e)).toStrictEqual(e);
  });

  it("is what the movements actually follow, so P9 flows through automatically", () => {
    // Prove the pipe is wired to expectedDate, not contractualDate: move one
    // and the movement moves with it. This is the change P9 will make.
    const [e] = transactionsToForecastEvents([tx({ id: "t1", expectedDate: at(3) })]);
    const shifted: ForecastEvent = {
      ...e,
      expectedDate: at(9),
      latestDate: at(12),
      timingBasis: ["historical: customer pays ~6 days late"],
    };

    const [movement] = forecastEventsToMovements([shifted]);
    expect(movement.date).toStrictEqual(at(9));
    expect(movement.date).not.toStrictEqual(e.contractualDate);
  });

  it("shifts the forecast when expected timing moves", () => {
    const [e] = transactionsToForecastEvents([
      tx({ id: "t1", amount: 500_00, expectedDate: at(3) }),
    ]);
    const onTime = buildForecast(0, forecastEventsToMovements([e]), 14, T0);
    const late = buildForecast(
      0,
      forecastEventsToMovements([{ ...e, expectedDate: at(9) }]),
      14,
      T0
    );

    expect(onTime[2].expectedInflows).toBe(500_00);
    expect(late[2].expectedInflows).toBe(0);
    expect(late[8].expectedInflows).toBe(500_00);
  });
});

describe("the flag", () => {
  it("is off by default, so no call site changes behaviour by importing this", () => {
    expect(FORECAST_EVENT_PIPELINE.enabled).toBe(false);
  });

  it("defaults to the flag when no override is supplied", () => {
    const txs = [tx({ id: "t1" })];
    expect(buildMovements(txs)).toStrictEqual(buildMovements(txs, { useEventPipeline: false }));
  });
});
