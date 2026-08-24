import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildDecisionContext, buildObligationSnapshot } from "../decisionContext";
import { classifyStaleness, computeContextFingerprint } from "../strategyFreshness";
import { FINANCIAL_CONFIG } from "../financialConfig";

/**
 * PART 13 - the twenty adversarial staleness cases, each an explicit fixture.
 *
 * Every case mutates ONE thing about the world between decision time and
 * approval time, then asserts the classification. The final case changes
 * nothing and must remain FRESH - without it the suite would pass just as well
 * if the gate blocked everything.
 */

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-05-01T00:00:00.000Z");
const iso = (offsetDays: number) => new Date(T0.getTime() + offsetDays * DAY);

interface World {
  cash: number;
  transactions: any[];
  payouts: any[];
}

function baseWorld(): World {
  return {
    cash: 10000000, // Rs 1,00,000
    transactions: [
      { id: "tx_in", businessId: "biz", amount: 3000000, type: "INFLOW", status: "PENDING", expectedDate: iso(2), description: "customer" },
      { id: "tx_out", businessId: "biz", amount: 2000000, type: "OUTFLOW", status: "PENDING", expectedDate: iso(3), description: "Packaging Co" },
    ],
    payouts: [
      { id: "po_1", businessId: "biz", vendor: "Packaging Co", amount: 2000000, scheduledDate: iso(3), criticality: "LOW", status: "SCHEDULED" },
    ],
  };
}

function clientFor(world: World): any {
  return {
    business: { findUnique: vi.fn(async () => ({ id: "biz", currentCash: world.cash })) },
    transaction: { findMany: vi.fn(async () => world.transactions) },
    payout: { findMany: vi.fn(async () => world.payouts) },
  };
}

const ACTIONS = [
  { type: "RESCHEDULE_PAYOUT", amount: 2000000, targetPayoutId: "po_1", targetTransactionId: "tx_out" },
];

/** Builds the decision-time fingerprint, mutates the world, returns the verdict. */
async function verdictAfter(mutate: (w: World) => void) {
  const world = baseWorld();
  const before = await buildDecisionContext(clientFor(world), "biz", {
    strategyType: "FULL_INTERVENTION",
    actions: ACTIONS,
    today: T0,
  });

  mutate(world);

  const after = await buildDecisionContext(clientFor(world), "biz", {
    strategyType: "FULL_INTERVENTION",
    actions: ACTIONS,
    today: T0,
  });

  return classifyStaleness(before, after);
}

beforeEach(() => {
  FINANCIAL_CONFIG.ENGINE_VERSION = "15.0.0";
  FINANCIAL_CONFIG.SCORING_CONFIG_VERSION = "15.0.0";
  FINANCIAL_CONFIG.LIQUIDITY_CONFIG_VERSION = "15.0.0";
  FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR = 5000000;
});

describe("PART 13 - Strategy freshness, twenty adversarial cases", () => {
  it("1. cash changes by more than 5% -> MATERIAL", async () => {
    const v = await verdictAfter((w) => {
      w.cash = 11000000; // +10%
    });
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.blocksExecution).toBe(true);
    expect(v.changes.some((c) => c.field === "startingCash" && c.severity === "MATERIAL")).toBe(true);
  });

  it("2. cash changes by less than 5% -> MINOR, still executable", async () => {
    const v = await verdictAfter((w) => {
      w.cash = 10200000; // +2%
    });
    expect(v.classification).toBe("MINOR_CHANGE");
    expect(v.blocksExecution).toBe(false);
  });

  it("3. a new Rs 5,00,000 payout appears -> MATERIAL (the Phase 14 blind spot)", async () => {
    const v = await verdictAfter((w) => {
      w.payouts.push({
        id: "po_huge", businessId: "biz", vendor: "Urgent", amount: 50000000,
        scheduledDate: iso(1), criticality: "HIGH", status: "SCHEDULED",
      });
    });
    // Cash did not move at all - the old drift check saw nothing.
    expect(v.changes.some((c) => c.field === "startingCash")).toBe(false);
    expect(v.classification).toBe("MATERIAL_CHANGE");
  });

  it("4. a new small payout above the materiality floor -> MATERIAL", async () => {
    const v = await verdictAfter((w) => {
      w.payouts.push({
        id: "po_small", businessId: "biz", vendor: "Small", amount: 1000000,
        scheduledDate: iso(5), criticality: "LOW", status: "SCHEDULED",
      });
    });
    expect(v.classification).toBe("MATERIAL_CHANGE");
  });

  it("5. a payout amount changes materially -> MATERIAL", async () => {
    const v = await verdictAfter((w) => {
      w.payouts[0].amount = 9000000;
      w.transactions[1].amount = 9000000;
    });
    expect(v.classification).toBe("MATERIAL_CHANGE");
  });

  it("6. a payout due date moves -> MATERIAL", async () => {
    const v = await verdictAfter((w) => {
      w.payouts[0].scheduledDate = iso(9);
    });
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.some((c) => c.field.startsWith("obligation:dueDate"))).toBe(true);
  });

  it("7. a critical obligation is added -> MATERIAL", async () => {
    const v = await verdictAfter((w) => {
      w.payouts.push({
        id: "po_payroll", businessId: "biz", vendor: "Payroll", amount: 4000000,
        scheduledDate: iso(6), criticality: "HIGH", status: "SCHEDULED",
      });
    });
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.some((c) => c.reason.includes("critical obligation"))).toBe(true);
  });

  it("8. a critical obligation is removed -> MATERIAL", async () => {
    const world = baseWorld();
    world.payouts.push({
      id: "po_payroll", businessId: "biz", vendor: "Payroll", amount: 4000000,
      scheduledDate: iso(6), criticality: "HIGH", status: "SCHEDULED",
    });
    const before = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    world.payouts = world.payouts.filter((p) => p.id !== "po_payroll");
    const after = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    const v = classifyStaleness(before, after);
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.some((c) => c.field.startsWith("obligation:removed"))).toBe(true);
  });

  it("9. an inflow settles (invoice paid) -> MATERIAL", async () => {
    const v = await verdictAfter((w) => {
      w.transactions[0].status = "SUCCESS";
    });
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.some((c) => c.field.startsWith("movement:status"))).toBe(true);
  });

  it("10. an expected inflow is cancelled -> MATERIAL", async () => {
    const v = await verdictAfter((w) => {
      w.transactions = w.transactions.filter((t) => t.id !== "tx_in");
    });
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.some((c) => c.field.startsWith("movement:removed"))).toBe(true);
  });

  it("11. a large new inflow appears -> MATERIAL", async () => {
    const v = await verdictAfter((w) => {
      w.transactions.push({
        id: "tx_windfall", businessId: "biz", amount: 20000000, type: "INFLOW",
        status: "PENDING", expectedDate: iso(4), description: "windfall",
      });
    });
    expect(v.classification).toBe("MATERIAL_CHANGE");
  });

  it("12. a large new outflow appears -> MATERIAL", async () => {
    const v = await verdictAfter((w) => {
      w.transactions.push({
        id: "tx_bill", businessId: "biz", amount: 30000000, type: "OUTFLOW",
        status: "PENDING", expectedDate: iso(4), description: "tax",
      });
    });
    expect(v.classification).toBe("MATERIAL_CHANGE");
  });

  it("13. the safety buffer floor changes -> MATERIAL", async () => {
    const world = baseWorld();
    const before = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR = 50000000;
    const after = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    const v = classifyStaleness(before, after);
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.some((c) => c.field === "requiredBuffer")).toBe(true);
  });

  it("14. the engine version changes -> MATERIAL", async () => {
    const world = baseWorld();
    const before = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    FINANCIAL_CONFIG.ENGINE_VERSION = "16.0.0";
    const after = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    const v = classifyStaleness(before, after);
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.some((c) => c.field === "engineVersion")).toBe(true);
  });

  it("15. the scoring configuration version changes -> MATERIAL", async () => {
    const world = baseWorld();
    const before = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    FINANCIAL_CONFIG.SCORING_CONFIG_VERSION = "16.0.0";
    const after = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    const v = classifyStaleness(before, after);
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.some((c) => c.field === "scoringConfigVersion")).toBe(true);
  });

  it("16. the action's target payout is deleted -> MATERIAL", async () => {
    const v = await verdictAfter((w) => {
      w.payouts = [];
    });
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.some((c) => c.reason.includes("no longer exists"))).toBe(true);
  });

  it("17. the target payout has already been paid -> MATERIAL", async () => {
    const v = await verdictAfter((w) => {
      w.payouts[0].status = "PAID";
    });
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.some((c) => c.reason.includes("already changed state"))).toBe(true);
  });

  it("18. the forecast horizon changes -> MATERIAL", async () => {
    const world = baseWorld();
    const before = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS = 21;
    const after = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS = 14;
    const v = classifyStaleness(before, after);
    expect(v.classification).toBe("MATERIAL_CHANGE");
  });

  it("19. irrelevant metadata changes -> FRESH (no false positives)", async () => {
    const v = await verdictAfter((w) => {
      // Vendor name and description are not financial facts.
      w.payouts[0].vendor = "Packaging Company Limited";
      w.transactions[0].description = "renamed";
    });
    expect(v.classification).toBe("NO_CHANGE");
    expect(v.blocksExecution).toBe(false);
  });

  it("20. an exactly unchanged world stays FRESH", async () => {
    const v = await verdictAfter(() => {});
    expect(v.classification).toBe("NO_CHANGE");
    expect(v.fresh).toBe(true);
    expect(v.blocksExecution).toBe(false);
    expect(v.changes).toHaveLength(0);
  });
});

describe("Freshness fingerprint properties", () => {
  it("is deterministic for identical input", async () => {
    const world = baseWorld();
    const a = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    const b = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("is insensitive to the ORDER records arrive in", async () => {
    const world = baseWorld();
    const a = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    world.transactions.reverse();
    world.payouts.reverse();
    const b = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("does NOT drift merely because the clock advanced", async () => {
    // The first design hashed rolling-window aggregates, so a strategy went
    // stale overnight with no money having moved. This is the regression guard.
    const world = baseWorld();
    const atT0 = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    const tenDaysLater = new Date(T0.getTime() + 10 * DAY);
    const later = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: tenDaysLater,
    });
    expect(later.fingerprint).toBe(atT0.fingerprint);
  });

  it("a missing decision fingerprint is UNKNOWN and blocks, never silently fresh", () => {
    const current = computeContextFingerprint({
      strategyType: "X", startingCash: 1, requiredBuffer: 1, forecastHorizonDays: 14,
      movements: [], obligations: [], actionTargets: [],
      engineVersion: "15.0.0", scoringConfigVersion: "15.0.0", liquidityConfigVersion: "15.0.0",
    });
    const v = classifyStaleness(null, current);
    expect(v.classification).toBe("UNKNOWN");
    expect(v.blocksExecution).toBe(true);
  });

  it("incomplete input forces UNKNOWN rather than a freshness claim", () => {
    const ctx = {
      strategyType: "X", startingCash: 1, requiredBuffer: 1, forecastHorizonDays: 14,
      movements: [], obligations: [], actionTargets: [],
      engineVersion: "15.0.0", scoringConfigVersion: "15.0.0", liquidityConfigVersion: "15.0.0",
    };
    const before = computeContextFingerprint(ctx);
    const after = computeContextFingerprint({ ...ctx, startingCash: 2, incomplete: true });
    const v = classifyStaleness(before, after);
    expect(v.classification).toBe("UNKNOWN");
    expect(v.blocksExecution).toBe(true);
  });

  it("snapshots critical obligations with stable identity and intent", async () => {
    const world = baseWorld();
    world.payouts.push({
      id: "po_payroll", businessId: "biz", vendor: "Payroll", amount: 4000000,
      scheduledDate: iso(6), criticality: "HIGH", status: "SCHEDULED",
    });
    const fp = await buildDecisionContext(clientFor(world), "biz", {
      strategyType: "FULL_INTERVENTION", actions: ACTIONS, today: T0,
    });
    const snapshot = buildObligationSnapshot(fp.context);

    expect(snapshot.length).toBeGreaterThan(0);
    const payroll = snapshot.find((o) => o.sourceId === "po_payroll");
    expect(payroll).toBeDefined();
    expect(payroll!.expectedAction).toBe("PROTECT");
    expect(payroll!.amount).toBe(4000000);
    expect(payroll!.statusAtDecision).toBe("SCHEDULED");
  });
});
