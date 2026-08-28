import { describe, it, expect } from "vitest";
import {
  computeFinancialState,
  isSameState,
  changedComponents,
  type FinancialStateInputs,
} from "../financialState";
import { extractObligations } from "@/lib/engine/liquiditySafety";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";

const TODAY = new Date("2026-09-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(TODAY.getTime() + days * DAY);

function inputs(overrides: Partial<FinancialStateInputs> = {}): FinancialStateInputs {
  return {
    currentCash: 1000000_00,
    requiredBuffer: 700000_00,
    today: TODAY,
    transactions: [],
    invoices: [],
    payouts: [],
    ...overrides,
  };
}

const payout = (id: string, amount: number, day: number, status = "SCHEDULED") => ({
  id,
  amount,
  scheduledDate: at(day),
  status,
  vendor: "Packaging Co",
  criticality: "LOW",
});

const tx = (id: string, amount: number, type: string, day: number, status = "PENDING") => ({
  id,
  amount,
  type,
  status,
  expectedDate: at(day),
  description: null,
});

const invoice = (id: string, amount: number, status = "PENDING") => ({
  id,
  amount,
  status,
  dueDate: at(5),
});

describe("computeFinancialState - aggregates", () => {
  it("reports cash straight from the ledger", () => {
    expect(computeFinancialState(inputs({ currentCash: 42 })).cashPosition).toBe(42);
  });

  it("counts every unpaid invoice as a receivable and no paid one", () => {
    const s = computeFinancialState(
      inputs({
        invoices: [
          invoice("i1", 300_00, "PENDING"),
          invoice("i2", 200_00, "OVERDUE"),
          invoice("i3", 999_00, "PAID"),
        ],
      })
    );
    expect(s.receivables).toBe(500_00);
  });

  it("ignores zero and negative invoice amounts rather than letting them net out", () => {
    const s = computeFinancialState(
      inputs({ invoices: [invoice("i1", 300_00), invoice("i2", 0), invoice("i3", -500_00)] })
    );
    expect(s.receivables).toBe(300_00);
  });

  it("takes payables from the engine's own obligation definition, not its own rule", () => {
    const payouts = [
      payout("p1", 400_00, 3, "SCHEDULED"),
      payout("p2", 100_00, 4, "RESCHEDULED"),
      payout("p3", 900_00, 5, "PAID"), // settled - not an obligation
    ];
    const transactions = [tx("t1", 50_00, "OUTFLOW", 2, "PENDING")];

    const s = computeFinancialState(inputs({ payouts, transactions }));
    const engineTotal = extractObligations(payouts, transactions, TODAY).reduce(
      (sum, o) => sum + o.amount,
      0
    );

    // The assertion that matters: the state agrees with the engine BY
    // CONSTRUCTION, because it calls the same function.
    expect(s.payables).toBe(engineTotal);
    expect(s.activeCommitments).toBe(extractObligations(payouts, transactions, TODAY).length);
  });

  it("sums expected flows over the forecast horizon", () => {
    const s = computeFinancialState(
      inputs({
        transactions: [
          tx("t1", 200_00, "INFLOW", 2),
          tx("t2", 50_00, "OUTFLOW", 3),
          // Beyond the 14-day horizon: excluded, like the forecast excludes it.
          tx("t3", 999_00, "INFLOW", 90),
        ],
      })
    );
    expect(s.expectedInflows).toBe(200_00);
    expect(s.expectedOutflows).toBe(50_00);
    expect(s.horizonDays).toBe(FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS);
  });

  it("excludes failed transactions, as the forecast does", () => {
    const s = computeFinancialState(
      inputs({ transactions: [tx("t1", 200_00, "INFLOW", 2, "FAILED")] })
    );
    expect(s.expectedInflows).toBe(0);
  });
});

describe("computeFinancialState - risk state", () => {
  it("is OK when the projected minimum stays above the buffer", () => {
    const s = computeFinancialState(inputs({ currentCash: 1000000_00, requiredBuffer: 100_00 }));
    expect(s.riskState).toBe("OK");
    expect(s.projectedMinimumBalance).toBe(1000000_00);
  });

  it("is AT_RISK when the projection dips below the buffer", () => {
    const s = computeFinancialState(
      inputs({
        currentCash: 100000_00,
        requiredBuffer: 90000_00,
        transactions: [tx("t1", 50000_00, "OUTFLOW", 3)],
      })
    );
    expect(s.riskState).toBe("AT_RISK");
    expect(s.projectedMinimumBalance).toBe(50000_00);
  });

  it("is INCOMPLETE when an input could not be read, even if the numbers look fine", () => {
    // A partial state must not report a confident OK (spec §64).
    const s = computeFinancialState(
      inputs({ currentCash: 1000000_00, requiredBuffer: 1_00, incomplete: true })
    );
    expect(s.riskState).toBe("INCOMPLETE");
  });

  it("is UNKNOWN when no horizon could be projected", () => {
    const s = computeFinancialState(inputs({ horizonDays: 0 }));
    expect(s.riskState).toBe("UNKNOWN");
    expect(s.projectedMinimumBalance).toBeNull();
  });
});

describe("stateHash", () => {
  it("is stable for identical inputs", () => {
    const a = computeFinancialState(inputs({ invoices: [invoice("i1", 100_00)] }));
    const b = computeFinancialState(inputs({ invoices: [invoice("i1", 100_00)] }));
    expect(a.stateHash).toBe(b.stateHash);
    expect(isSameState(a, b)).toBe(true);
  });

  it("does NOT change when only the clock advances", () => {
    // The critical property: a periodic recompute must not mint a new version.
    const a = computeFinancialState(inputs({ today: TODAY }));
    const b = computeFinancialState(inputs({ today: new Date(TODAY.getTime() + 36e5) }));
    expect(a.asOf).not.toBe(b.asOf);
    expect(a.stateHash).toBe(b.stateHash);
  });

  it("changes when cash changes", () => {
    const a = computeFinancialState(inputs({ currentCash: 100 }));
    const b = computeFinancialState(inputs({ currentCash: 101 }));
    expect(a.stateHash).not.toBe(b.stateHash);
    expect(changedComponents(a, b)).toContain("cash");
  });

  it("changes when an obligation appears", () => {
    const a = computeFinancialState(inputs());
    const b = computeFinancialState(inputs({ payouts: [payout("p1", 400_00, 3)] }));
    expect(a.stateHash).not.toBe(b.stateHash);
    expect(changedComponents(a, b)).toContain("payables");
  });

  it("changes when the reconciliation rollup changes", () => {
    const a = computeFinancialState(inputs());
    const b = computeFinancialState(
      inputs({ reconciliation: { total: 3, reconciled: 2, conflicts: 1, missing: 0, unknown: 0 } })
    );
    expect(a.stateHash).not.toBe(b.stateHash);
    expect(changedComponents(a, b)).toEqual(["reconciliation"]);
  });

  it("is independent of the order rows arrive in", () => {
    const p = [payout("p1", 400_00, 3), payout("p2", 100_00, 4)];
    const t = [tx("t1", 200_00, "INFLOW", 2), tx("t2", 50_00, "OUTFLOW", 3)];
    const forward = computeFinancialState(inputs({ payouts: p, transactions: t }));
    const backward = computeFinancialState(inputs({ payouts: [...p].reverse(), transactions: [...t].reverse() }));
    expect(forward.stateHash).toBe(backward.stateHash);
  });

  it("reports exactly which components differ", () => {
    const a = computeFinancialState(inputs({ currentCash: 100, requiredBuffer: 50 }));
    const b = computeFinancialState(inputs({ currentCash: 100, requiredBuffer: 60 }));
    const changed = changedComponents(a, b);
    expect(changed).toContain("buffer");
    expect(changed).not.toContain("payables");
  });

  it("sorts evidence references so their order cannot affect identity", () => {
    const a = computeFinancialState(inputs({ evidenceRefs: ["b", "a"] }));
    expect(a.evidenceRefs).toEqual(["a", "b"]);
  });
});
