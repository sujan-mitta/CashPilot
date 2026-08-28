import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { GET as getPerformance } from "../strategy-performance/route";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    decision: { count: vi.fn(), findMany: vi.fn() },
    executionIntent: { findMany: vi.fn(), findFirst: vi.fn() },
    agentAction: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/auth", () => ({ getSession: vi.fn() }));

const SESSION = { userId: "u", name: "n", email: "e", businessId: "biz-A", businessName: "A" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION as any);
});

/**
 * PART 10 - strategy performance integrity.
 *
 * The concern is not that the numbers look good, it is that they mean what they
 * claim. Each test pins one semantic.
 */
describe("PART 10 - Strategy performance integrity", () => {
  function measured(status: string, actualMin: number | null, predictionError: number | null) {
    return {
      id: `d-${Math.random()}`,
      actualOutcome: {
        status,
        actualMinimumBalance: actualMin,
        predictionError: predictionError === null ? {} : { minimumBalance: predictionError },
      },
      recommendedSnapshot: { minimumBalance: 5000000, strategyType: "RECOVER_ONLY" },
      baselineSnapshot: { minimumBalance: -5000000 },
    };
  }

  it("does not count PARTIALLY_MEASURED outcomes as failures", async () => {
    vi.mocked(prisma.decision.count).mockResolvedValue(3 as any);
    vi.mocked(prisma.decision.findMany).mockResolvedValue([
      measured("SUCCESS", 1000, -5),
      measured("PARTIALLY_MEASURED", null, null),
      measured("FAILED", -9000, -20),
    ] as any);

    const body = await (await getPerformance()).json();
    const stats = body.performance["DO_NOTHING"];

    expect(stats.successCount).toBe(1);
    expect(stats.failedCount).toBe(1);
    // Uncertainty gets its own bucket. Folding it into failures would make the
    // engine look worse than the evidence supports, which is just as dishonest
    // as making it look better.
    expect(stats.partiallyMeasuredCount).toBe(1);
    expect(stats.successCount + stats.failedCount + stats.partiallyMeasuredCount).toBe(3);
  });

  it("excludes unmeasurable outcomes from the improvement average", async () => {
    vi.mocked(prisma.decision.count).mockResolvedValue(2 as any);
    vi.mocked(prisma.decision.findMany).mockResolvedValue([
      measured("SUCCESS", 1000000, -5),
      // actualMinimumBalance null: never measurable, must not enter the mean.
      measured("PARTIALLY_MEASURED", null, null),
    ] as any);

    const body = await (await getPerformance()).json();
    const stats = body.performance["DO_NOTHING"];

    // (1000000 - (-5000000)) / 1 == 6000000, not divided by 2.
    expect(stats.avgActualImprovement).toBe(6000000);
  });

  it("returns null rather than zero for an empty dataset", async () => {
    vi.mocked(prisma.decision.count).mockResolvedValue(0 as any);
    vi.mocked(prisma.decision.findMany).mockResolvedValue([] as any);

    const body = await (await getPerformance()).json();
    const stats = body.performance["FULL_INTERVENTION"];

    expect(stats.avgActualImprovement).toBeNull();
    expect(stats.avgPredictedImprovement).toBeNull();
    expect(stats.medianPredictionError).toBeNull();
    expect(stats.sampleConfidence).toBe("NONE");
  });

  it("computes a deterministic median", async () => {
    vi.mocked(prisma.decision.count).mockResolvedValue(4 as any);
    vi.mocked(prisma.decision.findMany).mockResolvedValue([
      measured("SUCCESS", 1, -100),
      measured("SUCCESS", 1, -300),
      measured("SUCCESS", 1, -200),
      measured("SUCCESS", 1, -400),
    ] as any);

    const first = await (await getPerformance()).json();
    const second = await (await getPerformance()).json();

    // Even count -> mean of the two middle values: (-200 + -300) / 2.
    expect(first.performance["DO_NOTHING"].medianPredictionError).toBe(-250);
    expect(second.performance["DO_NOTHING"].medianPredictionError).toBe(-250);
  });

  it("keeps timesMeasured as the total population and sampleSize as the page", async () => {
    vi.mocked(prisma.decision.count).mockResolvedValue(10000 as any);
    vi.mocked(prisma.decision.findMany).mockResolvedValue([
      measured("SUCCESS", 1, -1),
      measured("SUCCESS", 1, -2),
    ] as any);

    const body = await (await getPerformance({ url: "http://x/api/strategy-performance?pageSize=2" } as any)).json();
    const stats = body.performance["DO_NOTHING"];

    expect(stats.timesMeasured).toBe(10000); // whole history
    expect(stats.sampleSize).toBe(2); // this page only
    expect(body.pagination.note).toMatch(/averages are computed over this page/i);
  });

  it("bases sample confidence on the full population, not the page", async () => {
    vi.mocked(prisma.decision.count).mockResolvedValue(500 as any);
    vi.mocked(prisma.decision.findMany).mockResolvedValue([measured("SUCCESS", 1, -1)] as any);

    const body = await (await getPerformance()).json();
    const stats = body.performance["DO_NOTHING"];

    // One row on this page, but 500 measured overall - the statistic IS meaningful.
    expect(stats.sampleSize).toBe(1);
    expect(stats.timesMeasured).toBe(500);
    expect(stats.sampleConfidence).toBe("SUFFICIENT");
  });

  it("scopes every count and page read to the caller's tenant", async () => {
    const wheres: any[] = [];
    vi.mocked(prisma.decision.count).mockImplementation((async (a: any) => {
      wheres.push(a.where);
      return 0;
    }) as any);
    vi.mocked(prisma.decision.findMany).mockImplementation((async (a: any) => {
      wheres.push(a.where);
      return [];
    }) as any);

    await getPerformance({ url: "http://x/api/strategy-performance?businessId=biz-EVIL" } as any);
    expect(wheres.length).toBeGreaterThan(0);
    for (const w of wheres) expect(w.businessId).toBe("biz-A");
  });

  it("rejects unauthenticated callers before touching data", async () => {
    vi.mocked(getSession).mockResolvedValue(null as any);
    const res = await getPerformance();
    expect(res.status).toBe(401);
    expect(prisma.decision.count).not.toHaveBeenCalled();
    expect(prisma.decision.findMany).not.toHaveBeenCalled();
  });
});

/**
 * PART 5/6 - the operator intent listing.
 */
describe("PART 5/6 - Operator intent listing", () => {
  it("is tenant scoped and never lets the client decide retry eligibility", async () => {
    const { GET } = await import("../execution-intents/route");

    let captured: any = null;
    vi.mocked(prisma.executionIntent.findMany).mockImplementation((async (a: any) => {
      captured = a.where;
      return [
        {
          id: "i1",
          strategyId: "s1",
          actionId: "a1",
          operation: "CREATE_PAYMENT_LINK",
          amount: 100,
          targetType: "INVOICE",
          targetId: "inv1",
          idempotencyKey: "cp_a1_inv1",
          externalRef: null,
          status: "UNKNOWN",
          attempts: 1,
          recordedAt: new Date(),
          dispatchedAt: new Date(),
          unknownReason: "timeout",
          lastReconciledAt: null,
          reconciliationResult: null,
          retrySafe: false,
        },
      ];
    }) as any);
    vi.mocked(prisma.agentAction.findMany).mockResolvedValue([
      { id: "a1", actionType: "PRIORITIZE_COLLECTIONS", status: "EXECUTION_UNKNOWN", amount: 100 },
    ] as any);

    const res = await GET({ url: "http://x/api/execution-intents?businessId=biz-EVIL" } as any);
    const body = await res.json();

    expect(captured.businessId).toBe("biz-A");
    expect(body.intents[0].retryPermitted).toBe(false);
    // The operator is told what to do, and it is not "retry".
    expect(body.intents[0].nextSafeAction).toMatch(/do NOT retry/i);
  });

  it("surfaces the evidence an operator needs, not a verdict they must trust blindly", async () => {
    const { GET } = await import("../execution-intents/route");

    vi.mocked(prisma.executionIntent.findMany).mockResolvedValue([
      {
        id: "i2",
        strategyId: "s1",
        actionId: "a2",
        operation: "RESCHEDULE_PAYOUT",
        amount: 5500000,
        targetType: "PAYOUT",
        targetId: "po1",
        idempotencyKey: "cp_a2",
        externalRef: null,
        status: "FAILED",
        attempts: 1,
        recordedAt: new Date(),
        dispatchedAt: new Date(),
        unknownReason: null,
        lastReconciledAt: new Date(),
        reconciliationResult: {
          status: "CONFIRMED_FAILURE",
          reason: "The payout is exactly as it was before the operation.",
          expectedEvidence: "Payout po1 at RESCHEDULED.",
          observedEvidence: "Payout po1 at SCHEDULED.",
          searchExhaustive: true,
          checkedAt: new Date().toISOString(),
        },
        retrySafe: true,
      },
    ] as any);
    vi.mocked(prisma.agentAction.findMany).mockResolvedValue([
      { id: "a2", actionType: "RESCHEDULE_PAYOUT", status: "FAILED", amount: 5500000 },
    ] as any);

    const body = await (await GET({ url: "http://x/api/execution-intents" } as any)).json();
    const intent = body.intents[0];

    expect(intent.lastReconciliation.expectedEvidence).toContain("RESCHEDULED");
    expect(intent.lastReconciliation.observedEvidence).toContain("SCHEDULED");
    // Positive evidence of non-occurrence -> retry becomes available.
    expect(intent.retryPermitted).toBe(true);
    expect(intent.nextSafeAction).toMatch(/safe/i);
  });
});
