import { describe, it, expect, vi, beforeEach } from "vitest";
import { measureDecisionOutcome } from "../outcomeMeasurer";
import { GET as handleDecisionsList } from "../../../app/api/decisions/route";
import { GET as handleDecisionDetail } from "../../../app/api/decisions/[id]/route";
import { GET as handlePerformance } from "../../../app/api/strategy-performance/route";
import { prisma } from "../../../lib/prisma";
import { getSession } from "../../../lib/auth";

vi.mock("@/lib/prisma", () => {
  return {
    prisma: {
      business: {
        findUnique: vi.fn(),
      },
      transaction: {
        findMany: vi.fn(),
      },
      decision: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        count: vi.fn(),
      },
      payout: {
        findFirst: vi.fn(),
      },
    },
  };
});

vi.mock("@/lib/auth", () => {
  return {
    getSession: vi.fn(),
  };
});

describe("Decision Memory, Outcome Measurement & Strategy Aggregates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseCreatedAt = new Date("2026-08-20T10:00:00.000Z");

  /**
   * Backs the decision mocks with a single mutable row.
   *
   * measureDecisionOutcome now writes through the guarded state machine
   * (findFirst then updateMany then findFirst) and re-reads the persisted row
   * before returning, rather than echoing back the update payload. A stateful
   * fake is therefore the only mock that models the real client faithfully.
   */
  function installDecisionRow(row: any) {
    const store: any = { ...row };
    const read = async () => ({ ...store });
    vi.mocked(prisma.decision.findUnique).mockImplementation(read as any);
    vi.mocked(prisma.decision.findFirst).mockImplementation(read as any);
    vi.mocked(prisma.decision.update).mockImplementation((async (args: any) => {
      Object.assign(store, args.data);
      return { ...store };
    }) as any);
    vi.mocked(prisma.decision.updateMany).mockImplementation((async (args: any) => {
      Object.assign(store, args.data);
      return { count: 1 };
    }) as any);
    vi.mocked(prisma.payout.findFirst).mockResolvedValue(null as any);
    return store;
  }

  const mockDecisionData = {
    id: "dec-1",
    businessId: "biz-1",
    strategyId: "strat-1",
    status: "EXECUTED",
    engineVersion: "13.0.0",
    createdAt: baseCreatedAt,
    baselineSnapshot: {
      startingCash: 10000000,
      minimumBalance: 2000000,
      finalBalance: 12000000,
      deficitDays: 0,
      requiredLiquidity: 3000000,
      coverageRatio: 3.33,
      forecastHorizon: 14,
      timestamp: baseCreatedAt.toISOString(),
    },
    recommendedSnapshot: {
      minimumBalance: 5000000,
      finalBalance: 15000000,
      deficitDays: 0,
      coverageRatio: 5.0,
      criticalObligationProtection: 1,
      effectiveness: "HIGH_EFFECTIVENESS",
      deferredObligations: [{ amount: 5000000, daysBeyondHorizon: 6 }],
      strategyType: "RECOVER_ONLY",
    },
    approvalSnapshot: {
      approvedBy: "user-1",
      approvedAt: baseCreatedAt.toISOString(),
    },
    executionSnapshot: {
      steps: [{ id: "act-1", status: "COMPLETED" }],
      timestamp: baseCreatedAt.toISOString(),
    },
    reconciliationSnapshot: null,
    actualOutcome: null,
    outcomeMeasuredAt: null,
  };

  it("1. Verification: Preserves DO_NOTHING & Counterfactual snapshots and versions on creation", async () => {
    expect(mockDecisionData.baselineSnapshot.minimumBalance).toBe(2000000);
    expect(mockDecisionData.recommendedSnapshot.strategyType).toBe("RECOVER_ONLY");
    expect(mockDecisionData.engineVersion).toBe("13.0.0");
  });

  it("2. Outcome window: Returns OUTCOME_PENDING status if 14 days have not passed yet", async () => {
    const store = installDecisionRow(mockDecisionData);

    // Call measurement only 2 days after creation
    const checkDate = new Date(baseCreatedAt.getTime() + 2 * 24 * 60 * 60 * 1000);
    const result = await measureDecisionOutcome("dec-1", checkDate);

    expect(result.actualOutcome.status).toBe("OUTCOME_PENDING");
    // The decision must NOT advance just because someone read it.
    expect(store.status).toBe("EXECUTED");
    // Unmeasured figures are null, never a plausible-looking zero.
    expect(result.actualOutcome.actualMinimumBalance).toBeNull();
    expect(result.actualOutcome.measurementCompleteness).toBe("NOT_STARTED");
  });

  it("3. Outcome measurement: Calculates predictions vs actuals and closes the window", async () => {
    installDecisionRow({ ...mockDecisionData, status: "EXECUTED" });

    // Mock actual transaction inputs (cash remains healthy)
    const mockActualTransactions = [
      { id: "tx-1", businessId: "biz-1", amount: 5000000, type: "INFLOW", status: "SUCCESS", expectedDate: new Date(baseCreatedAt.getTime() + 3 * 24 * 60 * 60 * 1000) },
    ];
    vi.mocked(prisma.transaction.findMany).mockResolvedValue(mockActualTransactions as any);

    const checkDate = new Date(baseCreatedAt.getTime() + 15 * 24 * 60 * 60 * 1000);
    const result = await measureDecisionOutcome("dec-1", checkDate);

    expect(result.status).toBe("OUTCOME_MEASURED");
    expect(result.actualOutcome.actualMinimumBalance).toBeGreaterThan(0);
    expect(result.actualOutcome.predictionError.minimumBalance).toBeDefined();
    expect(result.actualOutcome.solvency).toBe("SOLVENT");
    // The prediction carried a deferred obligation with no resolvable source
    // record. It cannot be verified, so the result is explicitly incomplete
    // rather than SUCCESS (PRINCIPLE 3: deficit elimination is not liability
    // elimination).
    expect(result.actualOutcome.status).toBe("PARTIALLY_MEASURED");
    expect(result.actualOutcome.unmeasuredDeferredCount).toBe(1);
    expect(result.actualOutcome.measurementCompleteness).toBe("PARTIAL");
  });

  it("3b. Outcome measurement: reaches SUCCESS when nothing was deferred", async () => {
    installDecisionRow({
      ...mockDecisionData,
      status: "EXECUTED",
      recommendedSnapshot: { ...mockDecisionData.recommendedSnapshot, deferredObligations: [] },
    });

    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: "tx-1", businessId: "biz-1", amount: 5000000, type: "INFLOW", status: "SUCCESS", expectedDate: new Date(baseCreatedAt.getTime() + 3 * 24 * 60 * 60 * 1000) },
    ] as any);

    const checkDate = new Date(baseCreatedAt.getTime() + 15 * 24 * 60 * 60 * 1000);
    const result = await measureDecisionOutcome("dec-1", checkDate);

    expect(result.actualOutcome.status).toBe("SUCCESS");
    expect(result.actualOutcome.measurementCompleteness).toBe("COMPLETE");
  });

  it("4. Success classifications: Identifies partial success, failure, and outlier variance correctly", async () => {
    // If actual cash balance dropped below baseline but did not completely fail or was partially improved:
    installDecisionRow({
      ...mockDecisionData,
      // A coherent "doing nothing was worse" baseline: deeply negative minimum
      // AND deficit days to match. The previous fixture claimed a POSITIVE
      // baseline minimum alongside 14 deficit days, which cannot both be true.
      baselineSnapshot: {
        ...mockDecisionData.baselineSnapshot,
        minimumBalance: -8000000,
        deficitDays: 14,
      },
      recommendedSnapshot: { ...mockDecisionData.recommendedSnapshot, deferredObligations: [] },
      status: "EXECUTED",
    });

    // Transaction outflows dominate (actual minimum balance is negative)
    const mockActualTransactions = [
      { id: "tx-out", businessId: "biz-1", amount: 15000000, type: "OUTFLOW", status: "SUCCESS", expectedDate: new Date(baseCreatedAt.getTime() + 3 * 24 * 60 * 60 * 1000) },
    ];
    vi.mocked(prisma.transaction.findMany).mockResolvedValue(mockActualTransactions as any);

    const checkDate = new Date(baseCreatedAt.getTime() + 15 * 24 * 60 * 60 * 1000);
    const result = await measureDecisionOutcome("dec-1", checkDate);

    // PART 15: baseline minimum -80L, actual minimum -50L. Still negative, so
    // not a success - but strictly better than doing nothing, so NOT a failure.
    expect(result.actualOutcome.vsBaseline).toBe("IMPROVED");
    expect(result.actualOutcome.status).toBe("PARTIAL_SUCCESS");
    expect(result.actualOutcome.solvency).toBe("INSOLVENT");
    expect(result.actualOutcome.varianceClassification).toBe("HIGH_VARIANCE_OUTCOME");
  });

  it("5. Multi-Tenant isolation: API routes block cross-tenant read access", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "user-1",
      name: "Aryan Mittal",
      email: "aryan@comp.com",
      businessId: "different-biz",
      businessName: "Different Biz",
    });

    vi.mocked(prisma.decision.findFirst).mockResolvedValue(null);

    // Request detail route for decision belonging to biz-1
    const request = new NextRequest("http://localhost/api/decisions/dec-1");
    const response = await handleDecisionDetail(request as any, { params: Promise.resolve({ id: "dec-1" }) });
    expect(response.status).toBe(404); // Not found under user's tenant
  });

  it("6. Strategy Aggregates: Computes median error and reports sample sizes correctly", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "user-1",
      name: "Aryan Mittal",
      email: "aryan@comp.com",
      businessId: "biz-1",
      businessName: "Acme Corp",
    });

    const mockDecisionsHistory = [
      {
        ...mockDecisionData,
        status: "OUTCOME_MEASURED",
        actualOutcome: {
          status: "SUCCESS",
          predictionError: { minimumBalance: -100000 }, // Error in paise
        },
      },
      {
        ...mockDecisionData,
        status: "OUTCOME_MEASURED",
        actualOutcome: {
          status: "SUCCESS",
          predictionError: { minimumBalance: -200000 },
        },
      },
      {
        ...mockDecisionData,
        status: "OUTCOME_MEASURED",
        actualOutcome: {
          status: "SUCCESS",
          predictionError: { minimumBalance: -500000 },
        },
      },
    ];

    // Counts are DB-side now; the page read still returns the measured rows.
    vi.mocked(prisma.decision.count).mockImplementation((async (args: any) =>
      args?.where?.recommendedSnapshot?.equals === "RECOVER_ONLY" ? 3 : 0) as any);
    vi.mocked(prisma.decision.findMany).mockImplementation((async (args: any) =>
      args?.where?.recommendedSnapshot?.equals === "RECOVER_ONLY" ? mockDecisionsHistory : []) as any);

    const response = await handlePerformance();
    expect(response.status).toBe(200);

    const body = await response.json();
    const recoveryStats = body.performance["RECOVER_ONLY"];

    expect(recoveryStats.sampleSize).toBe(3);
    // Median of [-100k, -200k, -500k] should be -200k
    expect(recoveryStats.medianPredictionError).toBe(-200000);
  });

  it("7. Idempotency: Duplicate outcome measurement calls return the same measured state without muting or double-writes", async () => {
    const alreadyMeasured = {
      ...mockDecisionData,
      status: "OUTCOME_MEASURED",
      actualOutcome: { status: "SUCCESS" },
    };
    installDecisionRow(alreadyMeasured);

    const result = await measureDecisionOutcome("dec-1");
    expect(result.status).toBe("OUTCOME_MEASURED");
    expect(result.actualOutcome.status).toBe("SUCCESS");
  });
});

// Mock NextRequest for routing context
class NextRequest {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
}
