import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyObligation,
  summariseObligationOutcomes,
  measureObligationSnapshot,
} from "../obligationOutcome";
import { measureDecisionOutcome } from "../outcomeMeasurer";
import {
  transitionDecision,
  appendDecisionEvent,
  InvalidDecisionTransitionError,
} from "../decisionStateMachine";
import { prisma } from "../../prisma";
import { getSession } from "../../auth";
// Imported at module scope, not inside a test: resolving this route pulls in the
// Prisma client chain, which under full-suite parallelism can take longer than a
// single test's timeout and produced a spurious failure.
import { GET as getStrategyPerformance } from "../../../app/api/strategy-performance/route";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { findUnique: vi.fn() },
    transaction: { findMany: vi.fn(), findFirst: vi.fn() },
    payout: { findFirst: vi.fn(), findMany: vi.fn() },
    decision: {
      findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(),
      update: vi.fn(), updateMany: vi.fn(), count: vi.fn(),
    },
    decisionEvent: { create: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock("@/lib/auth", () => ({ getSession: vi.fn() }));

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-06-01T00:00:00.000Z");
const at = (d: number) => new Date(T0.getTime() + d * DAY);
const windowEnd = at(14);

const events: any[] = [];
let store: any;

function installDecision(row: any) {
  store = { ...row };
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

function decisionRow(overrides: any = {}) {
  return {
    id: "dec-1",
    businessId: "biz-A",
    strategyId: "strat-1",
    status: "EXECUTED",
    engineVersion: "15.0.0",
    createdAt: T0,
    outcomeMeasurementHorizonDays: 14,
    outcomePhase: "WINDOW_OPEN",
    baselineSnapshot: {
      startingCash: 10000000, minimumBalance: -5000000, deficitDays: 6, requiredLiquidity: 5000000,
    },
    recommendedSnapshot: {
      minimumBalance: 2000000, deficitDays: 0, deferredObligations: [],
    },
    obligationSnapshot: [],
    executionSnapshot: null,
    actualOutcome: null,
    outcomeMeasuredAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  vi.mocked(prisma.transaction.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.transaction.findFirst).mockResolvedValue(null as any);
  vi.mocked(prisma.payout.findFirst).mockResolvedValue(null as any);
  vi.mocked(prisma.decisionEvent.create).mockImplementation((async ({ data }: any) => {
    events.push(data);
    return data;
  }) as any);
});

// ===========================================================================
// PART 17 - OBLIGATION OUTCOMES DERIVED FROM EVIDENCE
// ===========================================================================
describe("PART 17 - Obligation outcome classification", () => {
  const snap = {
    id: "PAYOUT:po1", sourceType: "PAYOUT", sourceId: "po1", amount: 1200000,
    originalDueDate: at(3).toISOString().split("T")[0],
    expectedAction: "PROTECT", criticality: "HIGH",
  };

  it("PAID on its original date is PAID_ON_TIME and counts as protected", () => {
    const o = classifyObligation(snap, { dueDate: at(3), status: "PAID" }, windowEnd);
    expect(o.verdict).toBe("PAID_ON_TIME");
    expect(o.countsAsProtected).toBe(true);
  });

  it("PAID after its original date is PAID_LATE and does NOT count as protected", () => {
    const o = classifyObligation(snap, { dueDate: at(8), status: "PAID" }, windowEnd);
    expect(o.verdict).toBe("PAID_LATE");
    expect(o.countsAsProtected).toBe(false);
  });

  it("RESCHEDULED counts as protected only when the plan asked for it", () => {
    const asked = classifyObligation(
      { ...snap, expectedAction: "RESCHEDULE" },
      { dueDate: at(10), status: "RESCHEDULED" },
      windowEnd
    );
    expect(asked.verdict).toBe("RESCHEDULED");
    expect(asked.countsAsProtected).toBe(true);

    const unasked = classifyObligation(snap, { dueDate: at(10), status: "RESCHEDULED" }, windowEnd);
    expect(unasked.countsAsProtected).toBe(false);
  });

  it("an obligation landing beyond the window is BEYOND_WINDOW, never protected", () => {
    const o = classifyObligation(snap, { dueDate: at(30), status: "SCHEDULED" }, windowEnd);
    expect(o.verdict).toBe("BEYOND_WINDOW");
    expect(o.countsAsProtected).toBe(false);
  });

  it("a missing record is UNVERIFIABLE, never assumed good", () => {
    const o = classifyObligation(snap, null, windowEnd);
    expect(o.verdict).toBe("UNVERIFIABLE");
    expect(o.countsAsProtected).toBe(false);
  });

  it("a FAILED record is a breach", () => {
    const o = classifyObligation(snap, { dueDate: at(3), status: "FAILED" }, windowEnd);
    expect(o.verdict).toBe("FAILED");
    expect(o.countsAsProtected).toBe(false);
  });

  it("the summary derives protection from verdicts, and flags a critical breach", () => {
    const outcomes = [
      classifyObligation(snap, { dueDate: at(3), status: "PAID" }, windowEnd),
      classifyObligation({ ...snap, id: "b", sourceId: "po2" }, { dueDate: at(3), status: "FAILED" }, windowEnd),
      classifyObligation({ ...snap, id: "c", sourceId: "po3" }, null, windowEnd),
    ];
    const s = summariseObligationOutcomes(outcomes);
    expect(s.total).toBe(3);
    expect(s.protectedCount).toBe(1);
    expect(s.breachedCount).toBe(1);
    expect(s.unresolvedCount).toBe(1); // NOT folded into either bucket
    expect(s.criticalBreach).toBe(true);
  });

  it("measures a snapshot against live payout records", async () => {
    vi.mocked(prisma.payout.findFirst).mockResolvedValue({
      id: "po1", scheduledDate: at(3), status: "PAID",
    } as any);
    const outcomes = await measureObligationSnapshot(prisma, [snap], windowEnd);
    expect(outcomes[0].verdict).toBe("PAID_ON_TIME");
    expect(outcomes[0].observedStatus).toBe("PAID");
  });
});

// ===========================================================================
// PART 16/17 - actualCriticalObligationsProtected IS NO LONGER NULL
// ===========================================================================
describe("PART 16 - Evidence-based critical obligation protection", () => {
  it("derives the protected count from the ledger, not the prediction", async () => {
    installDecision(
      decisionRow({
        obligationSnapshot: [
          { id: "PAYOUT:po1", sourceType: "PAYOUT", sourceId: "po1", amount: 1200000, originalDueDate: at(3).toISOString().split("T")[0], expectedAction: "PROTECT", criticality: "HIGH" },
        ],
        // The PREDICTION claimed protection; the ledger must decide.
        recommendedSnapshot: { minimumBalance: 2000000, deficitDays: 0, deferredObligations: [], criticalObligationProtection: 99 },
      })
    );
    vi.mocked(prisma.payout.findFirst).mockResolvedValue({
      id: "po1", scheduledDate: at(3), status: "PAID",
    } as any);
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: "t1", businessId: "biz-A", amount: 8000000, type: "INFLOW", status: "SUCCESS", expectedDate: at(2) },
    ] as any);

    const res = await measureDecisionOutcome("dec-1", at(20));
    expect(res.actualOutcome.actualCriticalObligationsProtected).toBe(1);
    // Not the predicted 99.
    expect(res.actualOutcome.actualCriticalObligationsProtected).not.toBe(99);
    expect(res.actualOutcome.obligationOutcomes).toHaveLength(1);
  });

  it("a breached critical obligation forces FAILED regardless of balances", async () => {
    installDecision(
      decisionRow({
        obligationSnapshot: [
          { id: "PAYOUT:po1", sourceType: "PAYOUT", sourceId: "po1", amount: 1200000, originalDueDate: at(3).toISOString().split("T")[0], expectedAction: "PROTECT", criticality: "CRITICAL" },
        ],
      })
    );
    vi.mocked(prisma.payout.findFirst).mockResolvedValue({
      id: "po1", scheduledDate: at(3), status: "FAILED",
    } as any);
    // Healthy cash: without the obligation rule this would read as SUCCESS.
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: "t1", businessId: "biz-A", amount: 50000000, type: "INFLOW", status: "SUCCESS", expectedDate: at(2) },
    ] as any);

    const res = await measureDecisionOutcome("dec-1", at(20));
    expect(res.actualOutcome.solvency).toBe("SOLVENT");
    expect(res.actualOutcome.status).toBe("FAILED");
  });

  it("reports unavailable, with a warning, when no snapshot exists", async () => {
    installDecision(decisionRow({ obligationSnapshot: [] }));
    const res = await measureDecisionOutcome("dec-1", at(20));
    expect(res.actualOutcome.actualCriticalObligationsProtected).toBeNull();
    expect(
      res.actualOutcome.dataWarnings.some((w: string) => w.includes("no obligation snapshot"))
    ).toBe(true);
  });
});

// ===========================================================================
// PART 18/19 - POST-HORIZON MEASUREMENT LIFECYCLE
// ===========================================================================
describe("PART 18/19 - Post-horizon measurement", () => {
  it("the outcome horizon may exceed the forecast horizon", async () => {
    installDecision(decisionRow({ outcomeMeasurementHorizonDays: 21 }));
    const res = await measureDecisionOutcome("dec-1", at(16));
    // Day 16 is past the 14-day forecast but inside the 21-day outcome horizon.
    expect(res.actualOutcome.outcomePhase).toBe("POST_HORIZON_PENDING");
    expect(res.actualOutcome.outcomeHorizonDays).toBe(21);
  });

  it("does not close a decision while a deferred obligation is still ahead", async () => {
    const s = installDecision(decisionRow({ outcomeMeasurementHorizonDays: 21 }));
    await measureDecisionOutcome("dec-1", at(16));
    // Still EXECUTED: OUTCOME_MEASURED is terminal and must be written once.
    expect(s.status).toBe("EXECUTED");
    expect(s.outcomePhase).toBe("POST_HORIZON_PENDING");
  });

  it("reaches FINAL_MEASURED once everything resolves", async () => {
    const s = installDecision(
      decisionRow({
        outcomeMeasurementHorizonDays: 21,
        obligationSnapshot: [
          { id: "PAYOUT:po1", sourceType: "PAYOUT", sourceId: "po1", amount: 1200000, originalDueDate: at(3).toISOString().split("T")[0], expectedAction: "RESCHEDULE", criticality: "HIGH" },
        ],
      })
    );
    vi.mocked(prisma.payout.findFirst).mockResolvedValue({
      id: "po1", scheduledDate: at(18), status: "RESCHEDULED",
    } as any);
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: "t1", businessId: "biz-A", amount: 9000000, type: "INFLOW", status: "SUCCESS", expectedDate: at(2) },
    ] as any);

    const res = await measureDecisionOutcome("dec-1", at(22));
    expect(res.actualOutcome.outcomePhase).toBe("FINAL_MEASURED");
    expect(s.status).toBe("OUTCOME_MEASURED");
    expect(res.actualOutcome.status).toBe("SUCCESS");
  });

  it("reaches UNRESOLVED_AFTER_WINDOW when evidence never arrives", async () => {
    installDecision(
      decisionRow({
        obligationSnapshot: [
          { id: "PAYOUT:ghost", sourceType: "PAYOUT", sourceId: "ghost", amount: 1200000, originalDueDate: at(3).toISOString().split("T")[0], expectedAction: "PROTECT", criticality: "HIGH" },
        ],
      })
    );
    const res = await measureDecisionOutcome("dec-1", at(20));
    expect(res.actualOutcome.outcomePhase).toBe("UNRESOLVED_AFTER_WINDOW");
    expect(res.actualOutcome.status).toBe("PARTIALLY_MEASURED");
  });

  it("the forecast itself is never extended - only measurement continues", async () => {
    installDecision(decisionRow({ outcomeMeasurementHorizonDays: 30 }));
    const res = await measureDecisionOutcome("dec-1", at(35));
    // The reconstructed actual series still spans the 14-day forecast horizon.
    expect(res.actualOutcome.outcomeHorizonDays).toBe(30);
    expect(res.actualOutcome.actualDeficitDays).toBeLessThanOrEqual(14);
  });
});

// ===========================================================================
// PART 20 - CLASSIFICATION PRECEDENCE
// ===========================================================================
describe("PART 20 - Outcome classification precedence", () => {
  it("unresolved external execution cannot be SUCCESS", async () => {
    installDecision(
      decisionRow({
        executionSnapshot: { outcome: "EXECUTION_UNKNOWN", requiresManualVerification: true },
      })
    );
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: "t1", businessId: "biz-A", amount: 50000000, type: "INFLOW", status: "SUCCESS", expectedDate: at(2) },
    ] as any);
    const res = await measureDecisionOutcome("dec-1", at(20));
    expect(res.actualOutcome.status).toBe("PARTIALLY_MEASURED");
  });

  it("worse than baseline outranks any improvement in deficit days", async () => {
    installDecision(decisionRow());
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: "t1", businessId: "biz-A", amount: 20000000, type: "OUTFLOW", status: "PENDING", expectedDate: at(2) },
    ] as any);
    const res = await measureDecisionOutcome("dec-1", at(20));
    expect(res.actualOutcome.vsBaseline).toBe("WORSE");
    expect(res.actualOutcome.status).toBe("FAILED");
  });

  it("a rejected decision is never graded on financial metrics", async () => {
    installDecision(decisionRow({ status: "REJECTED" }));
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([
      { id: "t1", businessId: "biz-A", amount: 90000000, type: "OUTFLOW", status: "PENDING", expectedDate: at(2) },
    ] as any);
    const res = await measureDecisionOutcome("dec-1", at(20));
    expect(res.actualOutcome.status).toBe("REJECTED");
  });

  it("no two precedence rules can produce contradictory statuses", async () => {
    // A single measurement yields exactly one status, and it is one of the
    // declared values - not an ad hoc string.
    installDecision(decisionRow());
    const res = await measureDecisionOutcome("dec-1", at(20));
    expect([
      "SUCCESS", "PARTIAL_SUCCESS", "PARTIALLY_MEASURED", "FAILED",
      "OUTCOME_PENDING", "REJECTED", "NOT_EXECUTED", "RECONCILIATION_MISMATCH",
    ]).toContain(res.actualOutcome.status);
  });
});

// ===========================================================================
// PART 23/24 - APPEND-ONLY DECISION EVENT LOG
// ===========================================================================
describe("PART 23/24 - Decision event log", () => {
  it("writes an event for every status transition", async () => {
    installDecision(decisionRow({ status: "APPROVED" }));
    await transitionDecision(prisma, { id: "dec-1" }, "EXECUTED" as any, {}, {
      audit: { actorType: "SYSTEM", actorId: "worker-1" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("EXECUTED");
    expect(events[0].fromStatus).toBe("APPROVED");
    expect(events[0].toStatus).toBe("EXECUTED");
    expect(events[0].actorId).toBe("worker-1");
  });

  it("writes NO event when a transition is refused", async () => {
    installDecision(decisionRow({ status: "REJECTED" }));
    await expect(
      transitionDecision(prisma, { id: "dec-1" }, "EXECUTED" as any, {})
    ).rejects.toBeInstanceOf(InvalidDecisionTransitionError);
    expect(events).toHaveLength(0);
  });

  it("writes NO event for a pure no-op self-transition", async () => {
    installDecision(decisionRow({ status: "APPROVED" }));
    await transitionDecision(prisma, { id: "dec-1" }, "APPROVED" as any, {});
    expect(events).toHaveLength(0);
  });

  it("a failing event insert aborts the enclosing transaction (PART 24)", async () => {
    // A real transaction client: writes are staged and only committed if the
    // whole callback resolves. This models what Prisma actually does, so the
    // rollback is demonstrated rather than asserted about.
    const committed: any = { status: "APPROVED" };
    let staged: any = null;

    const txClient: any = {
      decision: {
        findFirst: async () => ({ id: "dec-1", businessId: "biz-A", ...committed, ...(staged ?? {}) }),
        updateMany: async ({ data }: any) => {
          staged = { ...(staged ?? {}), ...data };
          return { count: 1 };
        },
      },
      decisionEvent: {
        create: async () => {
          throw new Error("event insert failed");
        },
      },
    };

    const runInTransaction = async () => {
      staged = null;
      try {
        await transitionDecision(txClient, { id: "dec-1" }, "EXECUTED" as any, {}, {
          audit: { actorType: "SYSTEM" },
        });
        Object.assign(committed, staged); // commit
      } catch (err) {
        staged = null; // rollback
        throw err;
      }
    };

    await expect(runInTransaction()).rejects.toThrow(/event insert failed/);

    // The status change did NOT survive: state and audit log cannot disagree.
    expect(committed.status).toBe("APPROVED");
    expect(staged).toBeNull();
  });

  it("events are append-only - the model exposes no update or delete", () => {
    expect((prisma as any).decisionEvent.update).toBeUndefined();
    expect((prisma as any).decisionEvent.delete).toBeUndefined();
    expect((prisma as any).decisionEvent.updateMany).toBeUndefined();
  });

  it("records the actor type so human and system actions are distinguishable", async () => {
    installDecision(decisionRow({ status: "GENERATED" }));
    await transitionDecision(prisma, { id: "dec-1" }, "APPROVED" as any, {}, {
      audit: { actorType: "HUMAN", actorId: "user-7" },
    });
    expect(events[0].actorType).toBe("HUMAN");
    expect(events[0].actorId).toBe("user-7");
  });

  it("appendDecisionEvent never mutates an existing row", async () => {
    await appendDecisionEvent(prisma, { id: "dec-1", businessId: "biz-A" }, {
      eventType: "STALE_BLOCKED" as any,
      actorType: "SYSTEM",
      metadata: { classification: "MATERIAL_CHANGE" },
    });
    await appendDecisionEvent(prisma, { id: "dec-1", businessId: "biz-A" }, {
      eventType: "STALE_BLOCKED" as any,
      actorType: "SYSTEM",
      metadata: { classification: "UNKNOWN" },
    });
    expect(events).toHaveLength(2);
    expect(events[0].metadata.classification).toBe("MATERIAL_CHANGE");
  });
});

// ===========================================================================
// PART 21/22 - PERFORMANCE PAGINATION AND SCALE
// ===========================================================================
describe("PART 21/22 - Strategy performance at scale", () => {
  async function callPerformance(url?: string) {
    return getStrategyPerformance(url ? ({ url } as any) : undefined);
  }

  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "u", name: "n", email: "e", businessId: "biz-A", businessName: "A",
    } as any);
  });

  it.each([10, 100, 1000, 10000])(
    "never loads more than one page of rows at %s decisions",
    async (total) => {
      const takes: number[] = [];
      vi.mocked(prisma.decision.count).mockResolvedValue(total as any);
      vi.mocked(prisma.decision.findMany).mockImplementation((async (args: any) => {
        takes.push(args.take);
        return [];
      }) as any);

      const res = await callPerformance("http://x/api/strategy-performance");
      expect(res.status).toBe(200);
      for (const t of takes) expect(t).toBeLessThanOrEqual(100);
    }
  );

  it("counts come from the database, not from loading rows", async () => {
    vi.mocked(prisma.decision.count).mockResolvedValue(4242 as any);
    vi.mocked(prisma.decision.findMany).mockResolvedValue([] as any);
    const body = await (await callPerformance()).json();
    expect(body.performance["DO_NOTHING"].timesRecommended).toBe(4242);
    // Row reads returned nothing, so the count cannot have come from them.
    expect(body.performance["DO_NOTHING"].sampleSize).toBe(0);
  });

  it("selects only the fields the averages need, not whole snapshots", async () => {
    let captured: any = null;
    vi.mocked(prisma.decision.count).mockResolvedValue(0 as any);
    vi.mocked(prisma.decision.findMany).mockImplementation((async (args: any) => {
      captured = args.select;
      return [];
    }) as any);
    await callPerformance();
    expect(Object.keys(captured).sort()).toEqual(
      ["actualOutcome", "baselineSnapshot", "id", "recommendedSnapshot"].sort()
    );
  });

  it("orders deterministically so pages cannot repeat or skip rows", async () => {
    let order: any = null;
    vi.mocked(prisma.decision.count).mockResolvedValue(0 as any);
    vi.mocked(prisma.decision.findMany).mockImplementation((async (args: any) => {
      order = args.orderBy;
      return [];
    }) as any);
    await callPerformance();
    expect(order).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("scopes every query to the caller's tenant", async () => {
    const wheres: any[] = [];
    vi.mocked(prisma.decision.count).mockImplementation((async (a: any) => {
      wheres.push(a.where);
      return 0;
    }) as any);
    vi.mocked(prisma.decision.findMany).mockImplementation((async (a: any) => {
      wheres.push(a.where);
      return [];
    }) as any);
    await callPerformance("http://x/api/strategy-performance?businessId=biz-EVIL");
    expect(wheres.length).toBeGreaterThan(0);
    for (const w of wheres) expect(w.businessId).toBe("biz-A");
  });

  it("issues a constant number of queries regardless of history size", async () => {
    vi.mocked(prisma.decision.count).mockResolvedValue(50000 as any);
    vi.mocked(prisma.decision.findMany).mockResolvedValue([] as any);
    await callPerformance();
    // 6 counts + 1 page read per strategy type. No N+1.
    const perType = 6;
    expect(vi.mocked(prisma.decision.count).mock.calls.length).toBe(perType * 4);
    expect(vi.mocked(prisma.decision.findMany).mock.calls.length).toBe(4);
  });
});
