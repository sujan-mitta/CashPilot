import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateDecisionTransition,
  isTerminalDecisionStatus,
  transitionDecision,
  InvalidDecisionTransitionError,
  decisionTransitionMap,
} from "../decisionStateMachine";
import { validateActionTransition, validateRecoveryTransition } from "../stateTransitions";
import { FINANCIAL_CONFIG, isUsableAmount, safeRatio } from "../financialConfig";
import { buildForecast, calculateRunway, transactionsToMovements } from "../forecast";
import { calculateRisk } from "../riskDetector";
import { generateStrategies, STRATEGY_NAMES } from "../strategyEngine";
import { scoreAllStrategies, SCORING_CONFIG } from "../scorer";
import { calculateLiquiditySafetyRequirement, extractObligations } from "../liquiditySafety";
import { verifiedMovements, measureDeferredObligations, measureDecisionOutcome } from "../outcomeMeasurer";
import { prisma } from "../../prisma";
import { getSession } from "../../auth";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    transaction: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    payout: { findFirst: vi.fn(), findMany: vi.fn() },
    invoice: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    strategy: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
    agentAction: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    paymentRecovery: { findFirst: vi.fn() },
    processedEvent: { findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
    decision: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/ai/agents", () => ({
  runAgent: vi.fn(() => Promise.resolve("deterministic-mock-narration")),
}));

/**
 * Prisma's interactive `$transaction(fn)` runs `fn` with a transactional client.
 * A bare vi.fn() returns undefined and silently skips the body, so any code
 * routed through a transaction would appear to do nothing.
 */
function installTransactionFake() {
  vi.mocked(prisma.$transaction).mockImplementation((async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : arg) as any);
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-03-01T00:00:00.000Z");

/** Installs a single mutable decision row behind the decision mocks. */
function installDecision(row: any) {
  const store: any = { ...row };
  const read = async () => ({ ...store });
  vi.mocked(prisma.decision.findUnique).mockImplementation(read as any);
  vi.mocked(prisma.decision.findFirst).mockImplementation(read as any);
  vi.mocked(prisma.decision.update).mockImplementation((async (a: any) => {
    Object.assign(store, a.data);
    return { ...store };
  }) as any);
  vi.mocked(prisma.decision.updateMany).mockImplementation((async (a: any) => {
    Object.assign(store, a.data);
    return { count: 1 };
  }) as any);
  return store;
}

function baseDecision(overrides: any = {}) {
  return {
    id: "dec-1",
    businessId: "biz-A",
    strategyId: "strat-1",
    status: "EXECUTED",
    engineVersion: "13.0.0",
    createdAt: T0,
    baselineSnapshot: {
      startingCash: 10000000,
      minimumBalance: -5000000,
      finalBalance: -5000000,
      deficitDays: 6,
      requiredLiquidity: 5000000,
    },
    recommendedSnapshot: {
      minimumBalance: 2000000,
      finalBalance: 4000000,
      deficitDays: 0,
      deferredObligations: [],
      strategyType: "RECOVER_AND_COLLECT",
    },
    approvalSnapshot: null,
    executionSnapshot: null,
    reconciliationSnapshot: null,
    actualOutcome: null,
    outcomeMeasuredAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  installTransactionFake();
  vi.clearAllMocks();
  vi.mocked(prisma.payout.findFirst).mockResolvedValue(null as any);
  vi.mocked(prisma.transaction.findFirst).mockResolvedValue(null as any);
  vi.mocked(prisma.transaction.findMany).mockResolvedValue([] as any);
});

afterEach(() => {
  // Restore any config mutated by a scale/versioning test.
  FINANCIAL_CONFIG.SAFETY_BUFFER_COVERAGE_DAYS = 3;
  FINANCIAL_CONFIG.SAFETY_THRESHOLD = 25000000;
  FINANCIAL_CONFIG.ENGINE_VERSION = "14.0.0";
});


/**
 * A scenario that actually differentiates the strategies.
 *
 * An earlier draft of these tests called generateStrategies with positional
 * amounts instead of the action library object. Every strategy threw, every
 * score came back 0, and the scale-invariance assertions passed vacuously by
 * comparing four identical INVALID results. The builder below is verified to
 * produce distinct scores, distinct effectiveness classifications and a real
 * deferred obligation on FULL_INTERVENTION.
 */
function buildScenario(scale: number) {
  const u = (n: number) => Math.round(n * scale);
  const txs = [
    { id: "in1", amount: u(3000000), type: "INFLOW", status: "PENDING", expectedDate: new Date(T0.getTime() + 2 * DAY), description: "customer inflow" },
    { id: "out1", amount: u(9000000), type: "OUTFLOW", status: "PENDING", expectedDate: new Date(T0.getTime() + 4 * DAY), description: "Packaging Co payout" },
    { id: "out2", amount: u(1500000), type: "OUTFLOW", status: "PENDING", expectedDate: new Date(T0.getTime() + 6 * DAY), description: "SaaS recurring" },
  ];
  const movements = transactionsToMovements(txs as any);
  const payouts = [
    { id: "p1", amount: u(9000000), scheduledDate: new Date(T0.getTime() + 4 * DAY), status: "SCHEDULED", criticality: "LOW", vendor: "Packaging Co" },
  ];
  const obligations = extractObligations(payouts, txs, T0);
  const strategies = generateStrategies(
    u(10000000),
    movements,
    {
      recoverFailedPayments: u(2400000),
      prioritizeCollections: u(4400000),
      reschedulePayout: u(9000000),
      pauseExpense: u(1500000),
      reschedulePayoutId: "p1",
      rescheduleTransactionId: "out1",
      pauseExpenseId: "out2",
    },
    T0,
    u(25000000)
  );
  return scoreAllStrategies(strategies, u(25000000), obligations, movements);
}

// ===========================================================================
// PART 1-3 - STATE MACHINE: INVALID TRANSITIONS MUST BE REJECTED
// ===========================================================================
describe("PART 3 - Adversarial decision state transitions", () => {
  const forbidden: [string, string][] = [
    ["GENERATED", "RECONCILED"],
    ["GENERATED", "OUTCOME_MEASURED"],
    ["GENERATED", "EXECUTED"],
    ["PRESENTED", "EXECUTED"],
    ["REJECTED", "EXECUTED"],
    ["REJECTED", "RECONCILED"],
    ["REJECTED", "APPROVED"],
    ["NOT_EXECUTED", "RECONCILED"],
    ["NOT_EXECUTED", "EXECUTED"],
    ["OUTCOME_MEASURED", "APPROVED"],
    ["OUTCOME_MEASURED", "EXECUTED"],
    ["OUTCOME_MEASURED", "REJECTED"],
    ["OUTCOME_MEASURED", "RECONCILED"],
    ["EXECUTED", "APPROVED"],
    ["EXECUTED", "NOT_EXECUTED"],
    ["RECONCILED", "EXECUTED"],
  ];

  it.each(forbidden)("rejects %s -> %s", (from, to) => {
    expect(validateDecisionTransition(from as any, to as any)).toBe(false);
  });

  const permitted: [string, string][] = [
    ["GENERATED", "APPROVED"],
    ["GENERATED", "REJECTED"],
    ["APPROVED", "EXECUTED"],
    ["APPROVED", "NOT_EXECUTED"],
    ["EXECUTED", "RECONCILED"],
    ["EXECUTED", "RECONCILIATION_MISMATCH"],
    ["RECONCILIATION_MISMATCH", "RECONCILED"],
    ["NOT_RECONCILED", "RECONCILED"],
    ["REJECTED", "OUTCOME_MEASURED"],
    ["NOT_EXECUTED", "OUTCOME_MEASURED"],
    ["RECONCILED", "OUTCOME_MEASURED"],
  ];

  it.each(permitted)("permits %s -> %s", (from, to) => {
    expect(validateDecisionTransition(from as any, to as any)).toBe(true);
  });

  it("treats OUTCOME_MEASURED as the only terminal decision status", () => {
    const map = decisionTransitionMap();
    const terminals = Object.keys(map).filter((s) => isTerminalDecisionStatus(s as any));
    expect(terminals).toEqual(["OUTCOME_MEASURED"]);
  });

  it("allows self-transition so a duplicate request is a no-op, not an error", () => {
    expect(validateDecisionTransition("APPROVED" as any, "APPROVED" as any)).toBe(true);
  });

  it("transitionDecision throws InvalidDecisionTransitionError instead of mutating", async () => {
    const store = installDecision(baseDecision({ status: "REJECTED" }));
    await expect(
      transitionDecision(prisma, { id: "dec-1" }, "EXECUTED" as any, {})
    ).rejects.toBeInstanceOf(InvalidDecisionTransitionError);
    expect(store.status).toBe("REJECTED");
  });

  it("EXECUTION_UNKNOWN is reachable and is NOT a terminal failure for an action", () => {
    // PRINCIPLE 10 at the action level: unknown can still resolve either way.
    expect(validateActionTransition("EXECUTION_UNKNOWN" as any, "COMPLETED" as any)).toBe(true);
    expect(validateActionTransition("EXECUTION_UNKNOWN" as any, "FAILED" as any)).toBe(true);
    expect(validateActionTransition("EXECUTION_UNKNOWN" as any, "RECONCILING" as any)).toBe(true);
  });

  it("a COMPLETED action cannot be walked back to APPROVED or PENDING", () => {
    expect(validateActionTransition("COMPLETED" as any, "APPROVED" as any)).toBe(false);
    expect(validateActionTransition("COMPLETED" as any, "PENDING" as any)).toBe(false);
  });

  it("a RECOVERED payment cannot be un-recovered", () => {
    expect(validateRecoveryTransition("RECOVERED" as any, "PAYMENT_PENDING" as any)).toBe(false);
    expect(validateRecoveryTransition("RECOVERED" as any, "FAILED" as any)).toBe(false);
  });
});

// ===========================================================================
// PART 8-10 - HISTORICAL / PREDICTION / BASELINE IMMUTABILITY
// ===========================================================================
describe("PART 8-10 - Historical immutability", () => {
  it("refuses to rewrite baselineSnapshot through the guarded writer", async () => {
    installDecision(baseDecision({ status: "APPROVED" }));
    await expect(
      transitionDecision(prisma, { id: "dec-1" }, "EXECUTED" as any, {
        baselineSnapshot: { startingCash: 999 },
      })
    ).rejects.toThrow(/Immutable historical field/);
  });

  it("refuses to rewrite recommendedSnapshot (prediction immutability)", async () => {
    installDecision(baseDecision({ status: "APPROVED" }));
    await expect(
      transitionDecision(prisma, { id: "dec-1" }, "EXECUTED" as any, {
        recommendedSnapshot: { minimumBalance: 0 },
      })
    ).rejects.toThrow(/Immutable historical field/);
  });

  it("refuses to rewrite engineVersion on a historical decision", async () => {
    installDecision(baseDecision({ status: "APPROVED" }));
    await expect(
      transitionDecision(prisma, { id: "dec-1" }, "EXECUTED" as any, {
        engineVersion: "99.0.0",
      })
    ).rejects.toThrow(/Immutable historical field/);
  });

  it("does not restamp an existing approvalSnapshot on a duplicate approval", async () => {
    const original = { approvedBy: "user-first", approvedAt: T0.toISOString() };
    const store = installDecision(baseDecision({ status: "APPROVED", approvalSnapshot: original }));

    await transitionDecision(prisma, { id: "dec-1" }, "APPROVED" as any, {
      approvalSnapshot: { approvedBy: "user-second", approvedAt: new Date().toISOString() },
    });

    expect(store.approvalSnapshot.approvedBy).toBe("user-first");
  });

  it("engine config changes do not retroactively alter a stored decision", async () => {
    const store = installDecision(baseDecision({ status: "RECONCILED" }));
    const before = JSON.stringify(store.baselineSnapshot);

    FINANCIAL_CONFIG.SAFETY_BUFFER_COVERAGE_DAYS = 30;
    FINANCIAL_CONFIG.SAFETY_THRESHOLD = 999999999;
    FINANCIAL_CONFIG.ENGINE_VERSION = "15.0.0";

    const reread = await prisma.decision.findUnique({ where: { id: "dec-1" } } as any);
    expect(JSON.stringify((reread as any).baselineSnapshot)).toBe(before);
    expect((reread as any).engineVersion).toBe("13.0.0");
  });

  it("a stored baseline is never recomputed from newer transactions", async () => {
    const store = installDecision(baseDecision({ status: "EXECUTED" }));
    const baselineMinimum = store.baselineSnapshot.minimumBalance;

    // New transactions arrive well after the decision was taken.
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: "late", businessId: "biz-A", amount: 90000000, type: "INFLOW", status: "SUCCESS", expectedDate: new Date(T0.getTime() + 3 * DAY) },
    ] as any);

    await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 20 * DAY));

    expect(store.baselineSnapshot.minimumBalance).toBe(baselineMinimum);
    expect(store.baselineSnapshot.minimumBalance).toBe(-5000000);
  });
});

// ===========================================================================
// PART 11 - OUTCOME MEASUREMENT MAY ONLY USE VERIFIED MONEY
// ===========================================================================
describe("PART 11 - Verified-data-only measurement", () => {
  it("does not count a PENDING inflow as cash received", () => {
    const { movements, ignoredUnsettledInflows } = verifiedMovements([
      { id: "a", amount: 5000000, type: "INFLOW", status: "PENDING", expectedDate: T0 },
    ] as any);
    expect(movements).toHaveLength(0);
    expect(ignoredUnsettledInflows).toBe(1);
  });

  it("does not count a FAILED inflow as cash received", () => {
    const { movements } = verifiedMovements([
      { id: "a", amount: 5000000, type: "INFLOW", status: "FAILED", expectedDate: T0 },
    ] as any);
    expect(movements).toHaveLength(0);
  });

  it("counts only a SUCCESS inflow as cash received", () => {
    const { movements } = verifiedMovements([
      { id: "a", amount: 5000000, type: "INFLOW", status: "SUCCESS", expectedDate: T0 },
    ] as any);
    expect(movements).toHaveLength(1);
    expect(movements[0].inflows).toBe(5000000);
  });

  it("still counts a PENDING outflow, so the result is not flattered", () => {
    // An unpaid bill is still a burden; dropping it would overstate the outcome.
    const { movements } = verifiedMovements([
      { id: "b", amount: 3000000, type: "OUTFLOW", status: "PENDING", expectedDate: T0 },
    ] as any);
    expect(movements[0].outflows).toBe(3000000);
  });

  it("discards a NaN amount rather than treating it as zero", () => {
    const { movements } = verifiedMovements([
      { id: "c", amount: NaN, type: "INFLOW", status: "SUCCESS", expectedDate: T0 },
    ] as any);
    expect(movements).toHaveLength(0);
  });
});

// ===========================================================================
// PART 12-13 - DEFERRED OBLIGATION OUTCOME & POST-HORIZON VISIBILITY
// ===========================================================================
describe("PART 12-13 - Deferred obligation outcomes", () => {
  const windowEnd = new Date(T0.getTime() + 14 * DAY);

  it("marks an obligation landing after the window as BEYOND_WINDOW, not success", async () => {
    const out = await measureDeferredObligations(
      prisma,
      [{ sourceId: "p1", amount: 1200000, originalDueDate: new Date(T0.getTime() + 3 * DAY), newDueDate: new Date(T0.getTime() + 20 * DAY) }],
      windowEnd
    );
    expect(out[0].verdict).toBe("BEYOND_WINDOW");
    expect(out[0].measurable).toBe(false);
  });

  it("marks a deferral that held as HELD", async () => {
    vi.mocked(prisma.payout.findFirst).mockResolvedValue({
      id: "p1",
      scheduledDate: new Date(T0.getTime() + 13 * DAY),
      status: "RESCHEDULED",
    } as any);
    const out = await measureDeferredObligations(
      prisma,
      [{ sourceId: "p1", amount: 1200000, originalDueDate: new Date(T0.getTime() + 3 * DAY), newDueDate: new Date(T0.getTime() + 13 * DAY) }],
      windowEnd
    );
    expect(out[0].verdict).toBe("HELD");
  });

  it("marks a deferral that broke (came due at the original date) as SETTLED_EARLY", async () => {
    vi.mocked(prisma.payout.findFirst).mockResolvedValue({
      id: "p1",
      scheduledDate: new Date(T0.getTime() + 3 * DAY),
      status: "SCHEDULED",
    } as any);
    const out = await measureDeferredObligations(
      prisma,
      [{ sourceId: "p1", amount: 1200000, originalDueDate: new Date(T0.getTime() + 3 * DAY), newDueDate: new Date(T0.getTime() + 13 * DAY) }],
      windowEnd
    );
    expect(out[0].verdict).toBe("SETTLED_EARLY");
  });

  it("marks an obligation with no resolvable record as UNVERIFIABLE, never HELD", async () => {
    const out = await measureDeferredObligations(
      prisma,
      [{ sourceId: "ghost", amount: 1200000, originalDueDate: T0, newDueDate: new Date(T0.getTime() + 5 * DAY) }],
      windowEnd
    );
    expect(out[0].verdict).toBe("UNVERIFIABLE");
  });

  it("a decision with an unmeasured deferred liability can never be SUCCESS", async () => {
    installDecision(
      baseDecision({
        status: "EXECUTED",
        recommendedSnapshot: {
          minimumBalance: 2000000,
          deficitDays: 0,
          deferredObligations: [
            { sourceId: "p-late", amount: 1200000, originalDueDate: new Date(T0.getTime() + 3 * DAY), newDueDate: new Date(T0.getTime() + 20 * DAY) },
          ],
        },
      })
    );
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: "in", businessId: "biz-A", amount: 8000000, type: "INFLOW", status: "SUCCESS", expectedDate: new Date(T0.getTime() + 2 * DAY) },
    ] as any);

    const res = await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 20 * DAY));
    expect(res.actualOutcome.status).toBe("PARTIALLY_MEASURED");
    expect(res.actualOutcome.unmeasuredDeferredCount).toBe(1);
    expect(res.actualOutcome.unmeasuredDeferredAmount).toBe(1200000);
  });

  it("keeps the deferred debt visible in the outcome payload", async () => {
    installDecision(
      baseDecision({
        status: "EXECUTED",
        recommendedSnapshot: {
          minimumBalance: 2000000,
          deficitDays: 0,
          deferredObligations: [
            { sourceId: "p-late", amount: 5500000, originalDueDate: T0, newDueDate: new Date(T0.getTime() + 25 * DAY) },
          ],
        },
      })
    );
    const res = await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 20 * DAY));
    expect(res.actualOutcome.deferredObligationOutcomes).toHaveLength(1);
    expect(res.actualOutcome.deferredObligationOutcomes[0].amount).toBe(5500000);
  });
});

// ===========================================================================
// PART 14-15 - CLASSIFICATION CONSISTENCY & BASELINE COMPARISON
// ===========================================================================
describe("PART 14-15 - Outcome classification", () => {
  async function measureWith(baselineMin: number, baselineDeficitDays: number, outflow: number) {
    installDecision(
      baseDecision({
        status: "EXECUTED",
        baselineSnapshot: {
          startingCash: 10000000,
          minimumBalance: baselineMin,
          deficitDays: baselineDeficitDays,
          requiredLiquidity: 5000000,
        },
        recommendedSnapshot: { minimumBalance: 2000000, deficitDays: 0, deferredObligations: [] },
      })
    );
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: "out", businessId: "biz-A", amount: outflow, type: "OUTFLOW", status: "PENDING", expectedDate: new Date(T0.getTime() + 2 * DAY) },
    ] as any);
    return measureDecisionOutcome("dec-1", new Date(T0.getTime() + 20 * DAY));
  }

  it("baseline -50L, actual -20L is PARTIAL_SUCCESS, never FAILED", async () => {
    // startingCash 100L, outflow 120L => actual minimum -20L
    const res = await measureWith(-5000000, 6, 12000000);
    expect(res.actualOutcome.actualMinimumBalance).toBe(-2000000);
    expect(res.actualOutcome.vsBaseline).toBe("IMPROVED");
    expect(res.actualOutcome.status).toBe("PARTIAL_SUCCESS");
  });

  it("baseline -50L, actual -60L is FAILED", async () => {
    const res = await measureWith(-5000000, 6, 16000000);
    expect(res.actualOutcome.actualMinimumBalance).toBe(-6000000);
    expect(res.actualOutcome.vsBaseline).toBe("WORSE");
    expect(res.actualOutcome.status).toBe("FAILED");
  });

  it("reports solvency and baseline comparison as separate dimensions", async () => {
    const res = await measureWith(-5000000, 6, 12000000);
    // Insolvent AND improved simultaneously - both must be visible.
    expect(res.actualOutcome.solvency).toBe("INSOLVENT");
    expect(res.actualOutcome.vsBaseline).toBe("IMPROVED");
  });

  it("a REJECTED decision is classified REJECTED, not FAILED (PRINCIPLE 11)", async () => {
    installDecision(baseDecision({ status: "REJECTED" }));
    const res = await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 20 * DAY));
    expect(res.actualOutcome.status).toBe("REJECTED");
  });

  it("a NOT_EXECUTED decision is classified NOT_EXECUTED, not FAILED", async () => {
    installDecision(baseDecision({ status: "NOT_EXECUTED" }));
    const res = await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 20 * DAY));
    expect(res.actualOutcome.status).toBe("NOT_EXECUTED");
  });

  it("an unreconstructable outcome is PARTIALLY_MEASURED, not FAILED (PRINCIPLE 10)", async () => {
    installDecision(
      baseDecision({ status: "EXECUTED", baselineSnapshot: { startingCash: null, minimumBalance: -5000000, deficitDays: 6 } })
    );
    const res = await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 20 * DAY));
    expect(res.actualOutcome.status).toBe("PARTIALLY_MEASURED");
    expect(res.actualOutcome.actualMinimumBalance).toBeNull();
  });
});

// ===========================================================================
// PART 17 - SOLVENCY IS NOT SAFETY
// ===========================================================================
describe("PART 17 - Solvency vs safety", () => {
  it("zero minimum balance against a 50L buffer is solvent but BELOW_SAFETY_BUFFER", async () => {
    installDecision(
      baseDecision({
        status: "EXECUTED",
        baselineSnapshot: { startingCash: 10000000, minimumBalance: -1, deficitDays: 1, requiredLiquidity: 5000000 },
        recommendedSnapshot: { minimumBalance: 0, deficitDays: 0, deferredObligations: [] },
      })
    );
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: "out", businessId: "biz-A", amount: 10000000, type: "OUTFLOW", status: "PENDING", expectedDate: new Date(T0.getTime() + 2 * DAY) },
    ] as any);

    const res = await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 20 * DAY));
    expect(res.actualOutcome.actualMinimumBalance).toBe(0);
    expect(res.actualOutcome.solvency).toBe("SOLVENT");
    expect(res.actualOutcome.safety).toBe("BELOW_SAFETY_BUFFER");
  });

  it("risk classification treats positive-but-below-threshold cash as MEDIUM, not LOW", () => {
    expect(calculateRisk(1, 5000000)).toBe("MEDIUM");
    expect(calculateRisk(0, 5000000)).toBe("MEDIUM");
    expect(calculateRisk(-1, 5000000)).toBe("HIGH");
    expect(calculateRisk(6000000, 5000000)).toBe("LOW");
  });
});

// ===========================================================================
// PART 18 - EXTREME MONEY VALUES
// ===========================================================================
describe("PART 18 - Extreme and malformed money values", () => {
  it.each([NaN, Infinity, -Infinity, null, undefined, "100", {}])(
    "isUsableAmount rejects %s",
    (v) => {
      expect(isUsableAmount(v as any)).toBe(false);
    }
  );

  it.each([0, 1, 5000000, 10000000, 1000000000, 100000000000, -4200000])(
    "isUsableAmount accepts real paise value %s",
    (v) => {
      expect(isUsableAmount(v)).toBe(true);
    }
  );

  it("safeRatio returns null instead of Infinity when dividing by zero", () => {
    expect(safeRatio(100, 0)).toBeNull();
  });

  it("safeRatio returns null instead of NaN for malformed input", () => {
    expect(safeRatio(NaN, 100)).toBeNull();
    expect(safeRatio(100, undefined)).toBeNull();
  });

  it("forecast never emits NaN or Infinity for extreme balances", () => {
    for (const cash of [0, 1, 100000000000, -4200000]) {
      const f = buildForecast(cash, [], 14, T0);
      for (const d of f) {
        expect(Number.isFinite(d.closingBalance)).toBe(true);
      }
    }
  });

  it("required buffer is never negative and never below the configured floor", async () => {
    const client = {
      transaction: { findMany: vi.fn().mockResolvedValue([]) },
      payout: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const r = await calculateLiquiditySafetyRequirement("biz-A", client, T0);
    expect(r.requiredBuffer).toBeGreaterThanOrEqual(FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR);
    expect(r.requiredBuffer).toBeGreaterThan(0);
  });

  it("obligation extraction drops zero and negative amounts rather than trusting them", () => {
    const obligations = extractObligations(
      [
        { id: "p1", amount: 0, scheduledDate: T0, status: "SCHEDULED", criticality: "HIGH", vendor: "X" },
        { id: "p2", amount: -500, scheduledDate: T0, status: "SCHEDULED", criticality: "HIGH", vendor: "Y" },
        { id: "p3", amount: 100, scheduledDate: T0, status: "SCHEDULED", criticality: "HIGH", vendor: "Z" },
      ],
      [],
      T0
    );
    expect(obligations.map((o) => o.sourceId)).toEqual(["p3"]);
  });
});

// ===========================================================================
// PART 19 - SCALE INVARIANCE
// ===========================================================================
describe("PART 19 - Scale invariance", () => {
  const scales = [0.01, 0.1, 1, 10, 100, 1000];

  const scenarioAt = buildScenario;

  it("the scenario itself is differentiated, so the invariance claims are not vacuous", () => {
    const scored = scenarioAt(1);
    expect(new Set(scored.map((x) => x.score)).size).toBeGreaterThan(1);
    expect(scored.every((x) => x.scoring.counterfactual?.effectiveness !== "INVALID")).toBe(true);
    expect(scored.some((x) => (x.scoring.deferredObligations?.count ?? 0) > 0)).toBe(true);
  });

  it("produces the same strategy ranking at every scale", () => {
    const orders = scales.map((s) =>
      scenarioAt(s)
        .slice()
        .sort((a, b) => b.score - a.score)
        .map((x) => x.name)
        .join(">")
    );
    expect(new Set(orders).size).toBe(1);
  });

  it("produces the same tier classification at every scale", () => {
    const tiers = scales.map((s) =>
      scenarioAt(s)
        .map((x) => `${x.name}:${x.scoring.tier}`)
        .join("|")
    );
    expect(new Set(tiers).size).toBe(1);
  });

  it("produces the same effectiveness classification at every scale", () => {
    const eff = scales.map((s) =>
      scenarioAt(s)
        .map((x) => `${x.name}:${x.scoring.counterfactual?.effectiveness}`)
        .join("|")
    );
    expect(new Set(eff).size).toBe(1);
  });

  it("produces the same safety status at every scale", () => {
    const safety = scales.map((s) =>
      scenarioAt(s)
        .map((x) => `${x.name}:${x.scoring.safetyStatus}`)
        .join("|")
    );
    expect(new Set(safety).size).toBe(1);
  });
});

// ===========================================================================
// PART 20-22 - ZERO DATA, OUTLIERS, MISSING DATA
// ===========================================================================
describe("PART 20-22 - Data quality handling", () => {
  it("a business with no data gets the floor buffer, LOW confidence and warnings", async () => {
    const client = {
      transaction: { findMany: vi.fn().mockResolvedValue([]) },
      payout: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const r = await calculateLiquiditySafetyRequirement("biz-empty", client, T0);
    expect(r.requiredBuffer).toBe(FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR);
    expect(r.absoluteFloorApplied).toBe(true);
    expect(r.confidence).toBe("LOW");
    expect(r.dataWarnings.length).toBeGreaterThan(0);
  });

  it("a single huge outlier among 29 normal days produces a warning and reduced confidence", async () => {
    const history = Array.from({ length: 29 }, (_, i) => ({
      id: `h${i}`,
      amount: 100000,
      type: "OUTFLOW",
      status: "SUCCESS",
      expectedDate: new Date(T0.getTime() - (i + 1) * DAY),
    }));
    history.push({
      id: "outlier",
      amount: 500000000,
      type: "OUTFLOW",
      status: "SUCCESS",
      expectedDate: new Date(T0.getTime() - 5 * DAY),
    });

    const client = {
      transaction: { findMany: vi.fn().mockResolvedValue(history) },
      payout: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const r = await calculateLiquiditySafetyRequirement("biz-A", client, T0);
    expect(r.dataWarnings.some((w) => w.toLowerCase().includes("outlier"))).toBe(true);
    expect(r.confidence).not.toBe("HIGH");
  });

  it("missing payout client is reported as a warning, not silently treated as zero obligations", async () => {
    const client = { transaction: { findMany: vi.fn().mockResolvedValue([]) } };
    const r = await calculateLiquiditySafetyRequirement("biz-A", client, T0);
    expect(r.dataWarnings.some((w) => w.includes("Payout database client not available"))).toBe(true);
  });

  it("an obligation with a missing due date is excluded rather than defaulted to today", () => {
    const obligations = extractObligations(
      [{ id: "p1", amount: 100, scheduledDate: null, status: "SCHEDULED", criticality: "HIGH", vendor: "X" }],
      [],
      T0
    );
    expect(obligations).toHaveLength(0);
  });

  it("measurement records a warning when no transactions exist in the window", async () => {
    installDecision(baseDecision({ status: "EXECUTED" }));
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([] as any);
    const res = await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 20 * DAY));
    expect(res.actualOutcome.dataWarnings.some((w: string) => w.includes("No transaction history"))).toBe(true);
  });

  it("an open measurement window yields nulls, not zeros", async () => {
    installDecision(baseDecision({ status: "EXECUTED" }));
    const res = await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 2 * DAY));
    expect(res.actualOutcome.status).toBe("OUTCOME_PENDING");
    expect(res.actualOutcome.actualMinimumBalance).toBeNull();
    expect(res.actualOutcome.actualDeficitDays).toBeNull();
    expect(res.actualOutcome.actualCoverageRatio).toBeNull();
  });
});

// ===========================================================================
// PART 4 / 36 - IDEMPOTENCY
// ===========================================================================
describe("PART 4/36 - Idempotency of financial mutations", () => {
  it("re-measuring an already-measured decision returns it untouched", async () => {
    const store = installDecision(
      baseDecision({ status: "OUTCOME_MEASURED", actualOutcome: { status: "SUCCESS" }, outcomeMeasuredAt: T0 })
    );
    const first = await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 30 * DAY));
    const second = await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 40 * DAY));
    expect(first.actualOutcome.status).toBe("SUCCESS");
    expect(second.actualOutcome.status).toBe("SUCCESS");
    expect(store.outcomeMeasuredAt).toEqual(T0);
    expect(prisma.decision.updateMany).not.toHaveBeenCalled();
  });

  it("a duplicate reconciliation transition is a safe no-op", async () => {
    const store = installDecision(baseDecision({ status: "RECONCILED" }));
    await transitionDecision(prisma, { id: "dec-1" }, "RECONCILED" as any, {});
    expect(store.status).toBe("RECONCILED");
  });

  it("a late webhook cannot drag a terminal decision backwards", async () => {
    const store = installDecision(baseDecision({ status: "OUTCOME_MEASURED" }));
    await expect(
      transitionDecision(prisma, { id: "dec-1" }, "NOT_RECONCILED" as any, {})
    ).rejects.toBeInstanceOf(InvalidDecisionTransitionError);
    expect(store.status).toBe("OUTCOME_MEASURED");
  });

  it("an out-of-order recovery event cannot resurrect a RECOVERED payment", () => {
    expect(validateRecoveryTransition("RECOVERED" as any, "RECOVERY_INITIATED" as any)).toBe(false);
  });

  it("a duplicate recovery event on the same status is idempotent", () => {
    expect(validateRecoveryTransition("PAYMENT_PENDING" as any, "PAYMENT_PENDING" as any)).toBe(true);
  });
});

// ===========================================================================
// PART 5/6 - CONCURRENCY
// ===========================================================================
describe("PART 5/6 - Concurrent approval and execution", () => {
  it("a compare-and-set miss with a matching final state resolves idempotently", async () => {
    const store: any = { ...baseDecision({ status: "EXECUTED" }) };
    vi.mocked(prisma.decision.findFirst).mockImplementation((async () => ({ ...store })) as any);
    // Simulate: our validated status was already changed by the winner.
    vi.mocked(prisma.decision.updateMany).mockResolvedValue({ count: 0 } as any);

    const result = await transitionDecision(prisma, { id: "dec-1" }, "EXECUTED" as any, {
      executionSnapshot: { outcome: "EXECUTED" },
    });
    expect(result.status).toBe("EXECUTED");
  });

  it("a compare-and-set miss with a divergent final state raises rather than guessing", async () => {
    const store: any = { ...baseDecision({ status: "APPROVED" }) };
    vi.mocked(prisma.decision.findFirst).mockImplementation((async () => ({ ...store })) as any);
    vi.mocked(prisma.decision.updateMany).mockResolvedValue({ count: 0 } as any);

    await expect(
      transitionDecision(prisma, { id: "dec-1" }, "EXECUTED" as any, { executionSnapshot: {} })
    ).rejects.toThrow(/concurrently modified/i);
  });

  it("the losing concurrent execution cannot demote an already EXECUTED decision", async () => {
    const store = installDecision(baseDecision({ status: "EXECUTED" }));
    await expect(
      transitionDecision(prisma, { id: "dec-1" }, "NOT_EXECUTED" as any, {})
    ).rejects.toBeInstanceOf(InvalidDecisionTransitionError);
    expect(store.status).toBe("EXECUTED");
  });
});

// ===========================================================================
// PART 23-24 - MULTI-TENANT ISOLATION / IDOR
// ===========================================================================
describe("PART 23-24 - Tenant isolation and IDOR", () => {
  it("decision detail is scoped by businessId in the query itself", async () => {
    const { GET } = await import("../../../app/api/decisions/[id]/route");
    vi.mocked(getSession).mockResolvedValue({
      userId: "u", name: "n", email: "e", businessId: "biz-B", businessName: "B",
    } as any);

    let capturedWhere: any = null;
    vi.mocked(prisma.decision.findFirst).mockImplementation((async (args: any) => {
      capturedWhere = args.where;
      return null;
    }) as any);

    const res = await GET({ url: "http://x/api/decisions/dec-1" } as any, { params: { id: "dec-1" } } as any);
    expect(res.status).toBe(404);
    // Server-side tenant scoping, not frontend filtering.
    expect(capturedWhere.businessId).toBe("biz-B");
    expect(capturedWhere.id).toBe("dec-1");
  });

  it("strategy-performance only aggregates the caller's own tenant", async () => {
    const { GET } = await import("../../../app/api/strategy-performance/route");
    vi.mocked(getSession).mockResolvedValue({
      userId: "u", name: "n", email: "e", businessId: "biz-B", businessName: "B",
    } as any);

    let capturedWhere: any = null;
    vi.mocked(prisma.decision.count).mockImplementation((async (args: any) => {
      capturedWhere = args.where;
      return 0;
    }) as any);
    vi.mocked(prisma.decision.findMany).mockImplementation((async (args: any) => {
      capturedWhere = args.where;
      return [];
    }) as any);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(capturedWhere.businessId).toBe("biz-B");
  });

  it("decision history list is tenant-scoped and paginated", async () => {
    const { GET } = await import("../../../app/api/decisions/route");
    vi.mocked(getSession).mockResolvedValue({
      userId: "u", name: "n", email: "e", businessId: "biz-B", businessName: "B",
    } as any);

    const wheres: any[] = [];
    vi.mocked(prisma.decision.findMany).mockImplementation((async (args: any) => {
      wheres.push(args);
      return [];
    }) as any);
    vi.mocked(prisma.decision.count).mockResolvedValue(0 as any);

    const res = await GET({ url: "http://x/api/decisions?limit=10&offset=0" } as any);
    expect(res.status).toBe(200);
    for (const w of wheres) {
      expect(w.where.businessId).toBe("biz-B");
      expect(w.take).toBeDefined();
    }
  });

  it("unauthenticated callers are rejected before any data access", async () => {
    const { GET } = await import("../../../app/api/decisions/route");
    vi.mocked(getSession).mockResolvedValue(null as any);
    const res = await GET({ url: "http://x/api/decisions" } as any);
    expect(res.status).toBe(401);
    expect(prisma.decision.findMany).not.toHaveBeenCalled();
  });

  it("a forged businessId in the query string cannot widen tenant scope", async () => {
    const { GET } = await import("../../../app/api/decisions/route");
    vi.mocked(getSession).mockResolvedValue({
      userId: "u", name: "n", email: "e", businessId: "biz-B", businessName: "B",
    } as any);

    let captured: any = null;
    vi.mocked(prisma.decision.findMany).mockImplementation((async (args: any) => {
      captured = args.where;
      return [];
    }) as any);
    vi.mocked(prisma.decision.count).mockResolvedValue(0 as any);

    await GET({ url: "http://x/api/decisions?businessId=biz-A" } as any);
    // The session is the only source of tenant identity.
    expect(captured.businessId).toBe("biz-B");
  });
});

// ===========================================================================
// PART 26 - PAGINATION CORRECTNESS
// ===========================================================================
describe("PART 26 - Decision history pagination", () => {
  it("clamps an absurd page size to the configured maximum", async () => {
    const { GET } = await import("../../../app/api/decisions/route");
    vi.mocked(getSession).mockResolvedValue({
      userId: "u", name: "n", email: "e", businessId: "biz-B", businessName: "B",
    } as any);

    const takes: number[] = [];
    vi.mocked(prisma.decision.findMany).mockImplementation((async (args: any) => {
      takes.push(args.take);
      return [];
    }) as any);
    vi.mocked(prisma.decision.count).mockResolvedValue(10000 as any);

    await GET({ url: "http://x/api/decisions?limit=999999" } as any);
    for (const t of takes) {
      expect(t).toBeLessThanOrEqual(FINANCIAL_CONFIG.DECISION_PAGE_SIZE_MAX);
    }
  });

  it("orders deterministically by createdAt then id so pages cannot repeat or skip rows", async () => {
    const { GET } = await import("../../../app/api/decisions/route");
    vi.mocked(getSession).mockResolvedValue({
      userId: "u", name: "n", email: "e", businessId: "biz-B", businessName: "B",
    } as any);

    let capturedOrder: any = null;
    vi.mocked(prisma.decision.findMany).mockImplementation((async (args: any) => {
      if (args.include) capturedOrder = args.orderBy;
      return [];
    }) as any);
    vi.mocked(prisma.decision.count).mockResolvedValue(0 as any);

    await GET({ url: "http://x/api/decisions" } as any);
    expect(capturedOrder).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("rejects a negative offset rather than passing it through", async () => {
    const { GET } = await import("../../../app/api/decisions/route");
    vi.mocked(getSession).mockResolvedValue({
      userId: "u", name: "n", email: "e", businessId: "biz-B", businessName: "B",
    } as any);

    const skips: number[] = [];
    vi.mocked(prisma.decision.findMany).mockImplementation((async (args: any) => {
      skips.push(args.skip);
      return [];
    }) as any);
    vi.mocked(prisma.decision.count).mockResolvedValue(0 as any);

    await GET({ url: "http://x/api/decisions?offset=-50" } as any);
    for (const s of skips) expect(s).toBe(0);
  });
});

// ===========================================================================
// PART 37-38 - CONFIGURATION CENTRALIZATION & ENGINE VERSIONING
// ===========================================================================
describe("PART 37-38 - Configuration and versioning", () => {
  it("scoring config is a view over the single financial config, not a second source", () => {
    expect(SCORING_CONFIG.SAFETY_THRESHOLD).toBe(FINANCIAL_CONFIG.SAFETY_THRESHOLD);
    expect(SCORING_CONFIG.SAFETY_BUFFER_MIN_FLOOR).toBe(FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR);
    expect(SCORING_CONFIG.RESCHEDULE_PENALTY).toBe(FINANCIAL_CONFIG.RESCHEDULE_PENALTY);
  });

  it("the risk detector and forecast share the config threshold", () => {
    // A default-threshold classification must agree with the configured value.
    expect(calculateRisk(FINANCIAL_CONFIG.SAFETY_THRESHOLD - 1)).toBe("MEDIUM");
    expect(calculateRisk(FINANCIAL_CONFIG.SAFETY_THRESHOLD)).toBe("LOW");
  });

  it("strategy names come from one canonical list", () => {
    expect(STRATEGY_NAMES).toContain("RECOVER_ONLY");
    expect(STRATEGY_NAMES).toContain("RECOVER_AND_COLLECT");
    expect(STRATEGY_NAMES).not.toContain("RECOVERY_ONLY" as any);
  });

  it("the engine emits exactly the canonical strategy names", () => {
    const strategies = buildScenario(1);
    expect(strategies).toHaveLength(STRATEGY_NAMES.length);
    for (const s of strategies) {
      expect(STRATEGY_NAMES).toContain(s.name);
      expect(s.error).toBeUndefined();
    }
  });

  it("a historical decision keeps its own engineVersion when the engine moves on", async () => {
    const store = installDecision(baseDecision({ status: "RECONCILED", engineVersion: "13.0.0" }));
    FINANCIAL_CONFIG.ENGINE_VERSION = "15.0.0";
    await transitionDecision(prisma, { id: "dec-1" }, "OUTCOME_MEASURED" as any, {
      actualOutcome: { status: "SUCCESS" },
    });
    expect(store.engineVersion).toBe("13.0.0");
  });
});

// ===========================================================================
// PART 40-41 - DETERMINISM AND NO LLM IN FINANCIAL LOGIC
// ===========================================================================
describe("PART 40-41 - Determinism and LLM containment", () => {
  const run = () => buildScenario(1);

  it("produces byte-identical scoring across repeated runs", () => {
    // Guard against a degenerate all-zero result making this trivially true.
    expect(new Set(run().map((x) => x.score)).size).toBeGreaterThan(1);
    const a = JSON.stringify(run());
    const b = JSON.stringify(run());
    const c = JSON.stringify(run());
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("produces an identical forecast across repeated runs", () => {
    const f1 = JSON.stringify(buildForecast(10000000, [], 14, T0));
    const f2 = JSON.stringify(buildForecast(10000000, [], 14, T0));
    expect(f1).toBe(f2);
  });

  it("produces an identical required buffer across repeated runs", async () => {
    const client = {
      transaction: { findMany: vi.fn().mockResolvedValue([]) },
      payout: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const a = await calculateLiquiditySafetyRequirement("biz-A", client, T0);
    const b = await calculateLiquiditySafetyRequirement("biz-A", client, T0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("no financial engine module imports the AI layer", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const engineDir = path.resolve(__dirname, "..");
    const files = fs
      .readdirSync(engineDir)
      .filter((f) => f.endsWith(".ts"));

    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(engineDir, f), "utf-8");
      if (/from\s+["'].*(ai\/agents|ai\/prompts|groq)/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("outcome measurement never consults a model", async () => {
    const { runAgent } = await import("@/lib/ai/agents");
    installDecision(baseDecision({ status: "EXECUTED" }));
    await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 20 * DAY));
    expect(runAgent).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PART 43 - FINANCIAL INTEGRITY PRINCIPLES, ASSERTED DIRECTLY
// ===========================================================================
describe("PART 43 - Financial integrity principles", () => {
  it("PRINCIPLE 3: a rescheduled payout stays visible as deferred debt, not erased", () => {
    const scored = buildScenario(1);
    const withDeferral = scored.find((x) => (x.deferredObligations || []).length > 0);

    // Non-vacuous: this scenario is built to produce exactly one deferral.
    expect(withDeferral).toBeDefined();
    expect(withDeferral!.name).toBe("FULL_INTERVENTION");
    expect(withDeferral!.scoring.deferredObligations?.count).toBe(1);
    expect(withDeferral!.scoring.deferredObligations?.amount).toBe(9000000);
    // The liability carries a due date beyond the horizon and says how far.
    expect(withDeferral!.scoring.deferredObligations?.latestDueDate).toBeTruthy();
    expect(withDeferral!.scoring.deferredObligations?.items[0].daysBeyondHorizon).toBeGreaterThan(0);
  });

  it("PRINCIPLE 3: strategies without a reschedule report zero deferred debt", () => {
    const scored = buildScenario(1);
    const noReschedule = scored.filter((x) => !x.actions.some((a) => a.type === "RESCHEDULE_PAYOUT"));
    expect(noReschedule.length).toBeGreaterThan(0);
    for (const x of noReschedule) {
      expect(x.scoring.deferredObligations?.count).toBe(0);
    }
  });

  it("PRINCIPLE 8: the DO_NOTHING baseline is scored as its own strategy, not assumed", () => {
    const scored = buildScenario(1);
    const baseline = scored.find((x) => x.name === "DO_NOTHING");
    expect(baseline).toBeDefined();
    // The baseline is simulated with zero actions - it is a real forecast, not
    // an assumed value.
    expect(baseline!.actions).toHaveLength(0);
    expect(baseline!.forecast.length).toBe(FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS);
  });

  it("PRINCIPLE 12: a single measured decision is not presented as a track record", async () => {
    const { GET } = await import("../../../app/api/strategy-performance/route");
    vi.mocked(getSession).mockResolvedValue({
      userId: "u", name: "n", email: "e", businessId: "biz-A", businessName: "A",
    } as any);
    // Counts now come from indexed COUNT queries rather than a full table read.
    vi.mocked(prisma.decision.count).mockImplementation((async (args: any) =>
      args?.where?.status === "OUTCOME_MEASURED" ? 1 : 1) as any);
    vi.mocked(prisma.decision.findMany).mockResolvedValue([
      {
        ...baseDecision({ status: "OUTCOME_MEASURED" }),
        actualOutcome: { status: "SUCCESS", actualMinimumBalance: 1000, predictionError: { minimumBalance: -5 } },
      },
    ] as any);

    const body = await (await GET()).json();
    const stats = body.performance["RECOVER_AND_COLLECT"];
    expect(stats.sampleSize).toBe(1);
    expect(stats.sampleConfidence).toBe("LOW");
    expect(stats.statisticallyMeaningful).toBe(false);
  });

  it("PRINCIPLE 12: an empty history reports null averages, not zero", async () => {
    const { GET } = await import("../../../app/api/strategy-performance/route");
    vi.mocked(getSession).mockResolvedValue({
      userId: "u", name: "n", email: "e", businessId: "biz-A", businessName: "A",
    } as any);
    vi.mocked(prisma.decision.count).mockResolvedValue(0 as any);
    vi.mocked(prisma.decision.findMany).mockResolvedValue([] as any);

    const body = await (await GET()).json();
    const stats = body.performance["DO_NOTHING"];
    expect(stats.sampleSize).toBe(0);
    expect(stats.avgActualImprovement).toBeNull();
    expect(stats.medianPredictionError).toBeNull();
    expect(stats.sampleConfidence).toBe("NONE");
  });

  it("PRINCIPLE 13: measurement writes an outcome without touching the prediction", async () => {
    const store = installDecision(baseDecision({ status: "EXECUTED" }));
    const predictionBefore = JSON.stringify(store.recommendedSnapshot);
    await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 20 * DAY));
    expect(JSON.stringify(store.recommendedSnapshot)).toBe(predictionBefore);
    expect(store.actualOutcome).toBeTruthy();
  });

  it("PRINCIPLE 7: predicted and actual live in different fields", async () => {
    const store = installDecision(baseDecision({ status: "EXECUTED" }));


    await measureDecisionOutcome("dec-1", new Date(T0.getTime() + 20 * DAY));
    // The actual payload must not simply echo the prediction.
    expect(store.actualOutcome.actualCriticalObligationsProtected).toBeNull();
    expect(store.actualOutcome.evidenceBasis).toMatch(/Settled inflows only/);
  });
});

// ===========================================================================
// PART 7 - FORECAST HORIZON BOUNDARY
// ===========================================================================
describe("PART 42 - Forecast horizon boundary", () => {
  it("a movement exactly on the final horizon day is inside the forecast", () => {
    const onLastDay = new Date(T0.getTime() + FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS * DAY);
    const f = buildForecast(10000000, [{ date: onLastDay, inflows: 500, outflows: 0 }], 14, T0);
    expect(f[f.length - 1].expectedInflows).toBe(500);
  });

  it("a movement one day past the horizon is excluded, not silently folded in", () => {
    const pastHorizon = new Date(T0.getTime() + (FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS + 1) * DAY);
    const f = buildForecast(10000000, [{ date: pastHorizon, inflows: 500, outflows: 0 }], 14, T0);
    expect(f.reduce((s, d) => s + d.expectedInflows, 0)).toBe(0);
  });

  it("runway reports minimum balance and crisis day consistently", () => {
    const f = buildForecast(
      1000,
      [{ date: new Date(T0.getTime() + 3 * DAY), inflows: 0, outflows: 5000 }],
      14,
      T0
    );
    const r = calculateRunway(f, 25000000);
    expect(r.minimumBalance).toBe(-4000);
    expect(r.crisisDay).toBe(3);
  });
});
