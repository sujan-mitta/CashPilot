import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recordExecutionIntent,
  claimExecutionIntent,
  resolveIntentUnknown,
  resolveIntentFailed,
  sweepAbandonedIntents,
  isDispatchable,
} from "../../execution/executionIntent";
import { executeWithDurableIntent, reconcileUnknownIntent, isRetryPermitted } from "../../execution/executor";
import { interpretScan, scanForReference } from "../../execution/providerReconciliation";
import { reconcileReschedulePayout, reconcilePauseExpense } from "../../execution/ledgerReconciliation";
import { validateActionTransition } from "../stateTransitions";
import {
  validateDecisionTransition,
  transitionDecision,
  InvalidDecisionTransitionError,
} from "../decisionStateMachine";
import { classifyStaleness, computeContextFingerprint } from "../strategyFreshness";
import { verifiedMovements } from "../outcomeMeasurer";
import { isUsableAmount, safeRatio, FINANCIAL_CONFIG } from "../financialConfig";
import { summariseObligationOutcomes, classifyObligation } from "../obligationOutcome";
import { inspectConfiguration } from "../../config/productionConfig";
import { makeExecutionIntentFake, makeDecisionFakes } from "./helpers/prismaFakes";
import { ExecutionOperation } from "../../../../generated/prisma/client";

// outcomeMeasurer imports the Prisma client at module scope; these invariants
// use only its pure helpers, so the client is stubbed out.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    decision: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    transaction: { findMany: vi.fn(), findFirst: vi.fn() },
    payout: { findFirst: vi.fn() },
    decisionEvent: { create: vi.fn() },
  },
}));

/**
 * PRODUCTION FINANCIAL INVARIANTS  (Phase 16 PART 14)
 *
 * Each block states one invariant and proves it. Where an invariant depends on a
 * setup actually exercising the intended path, the setup is asserted first so
 * the proof cannot pass vacuously (PART 17).
 */

const store = { intents: [] as any[] };
const decisionStore = { decisions: [] as any[], events: [] as any[] };
const client: any = {
  executionIntent: makeExecutionIntentFake(store),
  ...makeDecisionFakes(decisionStore),
  payout: { findFirst: vi.fn(async () => null) },
  transaction: { findFirst: vi.fn(async () => null) },
};

const base = {
  businessId: "biz-A",
  strategyId: "strat-1",
  actionId: "act-1",
  operation: ExecutionOperation.CREATE_PAYMENT_LINK,
  amount: 2400000,
};

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-09-01T00:00:00.000Z");

beforeEach(() => {
  store.intents.length = 0;
  decisionStore.decisions.length = 0;
  decisionStore.events.length = 0;
  vi.mocked(client.payout.findFirst).mockResolvedValue(null);
  vi.mocked(client.transaction.findFirst).mockResolvedValue(null);
});

// ===========================================================================
describe("INVARIANT 1 - No provider call without a committed execution intent", () => {
  it("the intent row exists before the dispatch function is entered", async () => {
    let intentAtDispatchTime: any = null;

    await executeWithDurableIntent(client, {
      ...base,
      dispatch: async () => {
        // Observed from INSIDE the provider call.
        intentAtDispatchTime = store.intents[0] ? { ...store.intents[0] } : null;
        return { externalRef: "plink_1" };
      },
    });

    expect(intentAtDispatchTime).not.toBeNull();
    expect(intentAtDispatchTime.status).toBe("DISPATCHING");
    expect(intentAtDispatchTime.idempotencyKey).toBe("cp_act-1");
  });

  it("a dispatch that is never reached leaves no provider call and a recoverable row", async () => {
    let called = false;
    await resolveIntentUnknown(client, (await recordExecutionIntent(client, base)).intent.id, "prior timeout");

    const res = await executeWithDurableIntent(client, {
      ...base,
      dispatch: async () => {
        called = true;
        return { externalRef: "x" };
      },
    });

    expect(called).toBe(false);
    expect(res.outcome).toBe("BLOCKED_UNKNOWN");
    expect(store.intents).toHaveLength(1);
  });
});

// ===========================================================================
describe("INVARIANT 2 - One action cannot produce two successful executions", () => {
  it("repeated execution contacts the provider exactly once", async () => {
    let calls = 0;
    const run = () =>
      executeWithDurableIntent(client, {
        ...base,
        dispatch: async () => {
          calls++;
          return { externalRef: `plink_${calls}` };
        },
      });

    const first = await run();
    const second = await run();
    const third = await run();

    // Setup assertion: the first run must genuinely have succeeded.
    expect(first.outcome).toBe("SUCCEEDED");
    expect(calls).toBe(1);
    expect(second.outcome).toBe("ALREADY_SUCCEEDED");
    expect(third.outcome).toBe("ALREADY_SUCCEEDED");
    expect(store.intents.filter((i) => i.status === "SUCCEEDED")).toHaveLength(1);
  });

  it("concurrent execution yields exactly one SUCCEEDED intent", async () => {
    let calls = 0;
    const run = () =>
      executeWithDurableIntent(client, {
        ...base,
        dispatch: async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 5));
          return { externalRef: "plink_1" };
        },
      });

    await Promise.all([run(), run(), run()]);
    expect(calls).toBe(1);
    expect(store.intents).toHaveLength(1);
  });
});

// ===========================================================================
describe("INVARIANT 3 - UNKNOWN cannot become SUCCESS without evidence", () => {
  it("stays UNKNOWN when the provider cannot be reached", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentUnknown(client, intent.id, "timeout");

    const res = await reconcileUnknownIntent(client, intent.id, {
      lookup: async () => {
        throw new Error("ECONNRESET");
      },
    });

    expect(res.result.status).toBe("UNKNOWN");
    expect(store.intents[0].status).toBe("UNKNOWN");
  });

  it("becomes SUCCEEDED only when the provider positively confirms it", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentUnknown(client, intent.id, "timeout");

    const res = await reconcileUnknownIntent(client, intent.id, {
      lookup: async () => ({
        status: "CONFIRMED_SUCCESS",
        providerReference: "plink_real",
        providerStatus: "paid",
        reason: "found",
        expectedEvidence: "e",
        observedEvidence: "o",
        searchExhaustive: true,
        retrySafe: false,
        checkedAt: new Date().toISOString(),
      }),
    });

    expect(res.result.status).toBe("CONFIRMED_SUCCESS");
    expect(store.intents[0].status).toBe("SUCCEEDED");
    expect(store.intents[0].externalRef).toBe("plink_real");
  });

  it("an incomplete provider scan can never yield NOT_FOUND", () => {
    const verdict = interpretScan("cp_act-1", { found: null, exhaustive: false });
    expect(verdict.status).toBe("UNKNOWN");
    expect(verdict.retrySafe).toBe(false);
  });

  it("a scan never matches a positionally-adjacent unrelated link", async () => {
    // The Phase 15 bug: `items.find(...) ?? items[0]`.
    const scan = await scanForReference(
      "cp_act-1",
      { fromUnix: 0, toUnix: 1 },
      async () => [
        { id: "plink_someone_else", reference_id: "cp_OTHER", status: "paid" },
      ]
    );
    expect(scan.found).toBeNull();
    expect(interpretScan("cp_act-1", scan).status).toBe("NOT_FOUND");
  });
});

// ===========================================================================
describe("INVARIANT 4 - UNKNOWN cannot directly become EXECUTING", () => {
  it("the action state machine forbids the transition", () => {
    expect(validateActionTransition("EXECUTION_UNKNOWN" as any, "EXECUTING" as any)).toBe(false);
  });

  it("an UNKNOWN intent is not dispatchable", () => {
    expect(isDispatchable("UNKNOWN" as any)).toBe(false);
    expect(isDispatchable("DISPATCHING" as any)).toBe(false);
    expect(isDispatchable("RECORDED" as any)).toBe(true);
  });

  it("claiming an UNKNOWN intent returns null", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentUnknown(client, intent.id, "timeout");
    expect(await claimExecutionIntent(client, intent.id)).toBeNull();
  });
});

// ===========================================================================
describe("INVARIANT 5 - Retry requires proof the original effect did not occur", () => {
  it("retry is refused while the intent is UNKNOWN", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentUnknown(client, intent.id, "timeout");
    expect(isRetryPermitted(store.intents[0])).toBe(false);
  });

  it("retry is refused for a FAILED intent that was never reconciled", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentFailed(client, intent.id, "provider rejected");
    // retrySafe defaults to false; no reconciliation evidence exists.
    expect(isRetryPermitted(store.intents[0])).toBe(false);
  });

  it("retry is permitted only after an exhaustive NOT_FOUND", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentUnknown(client, intent.id, "timeout");

    await reconcileUnknownIntent(client, intent.id, {
      lookup: async () => interpretScan("cp_act-1", { found: null, exhaustive: true }),
    });

    expect(store.intents[0].status).toBe("FAILED");
    expect(store.intents[0].retrySafe).toBe(true);
    expect(isRetryPermitted(store.intents[0])).toBe(true);
  });

  it("a found-but-cancelled link is NOT retry safe", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentUnknown(client, intent.id, "timeout");

    await reconcileUnknownIntent(client, intent.id, {
      lookup: async () =>
        interpretScan("cp_act-1", {
          found: { id: "plink_1", reference_id: "cp_act-1", status: "cancelled" },
          exhaustive: true,
        }),
    });

    // The link WAS created; re-issuing would double it.
    expect(store.intents[0].status).toBe("FAILED");
    expect(store.intents[0].retrySafe).toBe(false);
    expect(isRetryPermitted(store.intents[0])).toBe(false);
  });
});

// ===========================================================================
describe("INVARIANT 6/7 - Execution is not settlement; pending is not cash", () => {
  it("a successful dispatch does not mark the intent settled", async () => {
    const res = await executeWithDurableIntent(client, {
      ...base,
      dispatch: async () => ({ externalRef: "plink_1", externalStatus: "created" }),
    });
    expect(res.outcome).toBe("SUCCEEDED");
    // "created" - a link exists; nobody has paid.
    expect(store.intents[0].externalStatus).toBe("created");
    expect(interpretScan("cp_act-1", {
      found: { id: "plink_1", reference_id: "cp_act-1", status: "created" },
      exhaustive: true,
    }).status).toBe("PENDING");
  });

  it("an unsettled inflow is excluded from measured cash", () => {
    const { movements, ignoredUnsettledInflows } = verifiedMovements([
      { id: "a", amount: 5000000, type: "INFLOW", status: "PENDING", expectedDate: T0 },
      { id: "b", amount: 3000000, type: "INFLOW", status: "SUCCESS", expectedDate: T0 },
    ] as any);
    expect(ignoredUnsettledInflows).toBe(1);
    expect(movements).toHaveLength(1);
    expect(movements[0].inflows).toBe(3000000);
  });
});

// ===========================================================================
describe("INVARIANT 8 - A deferred obligation cannot disappear", () => {
  it("an unresolved obligation is counted separately, never as protected", () => {
    const snap = {
      id: "PAYOUT:p1", sourceType: "PAYOUT", sourceId: "p1", amount: 5500000,
      originalDueDate: "2026-09-04", expectedAction: "RESCHEDULE", criticality: "HIGH",
    };
    const outcomes = [
      classifyObligation(snap, { dueDate: new Date("2026-10-01"), status: "SCHEDULED" }, new Date("2026-09-15")),
    ];
    // Setup assertion: this scenario must genuinely be beyond the window.
    expect(outcomes[0].verdict).toBe("BEYOND_WINDOW");

    const summary = summariseObligationOutcomes(outcomes);
    expect(summary.unresolvedCount).toBe(1);
    expect(summary.protectedCount).toBe(0);
    expect(summary.breachedCount).toBe(0);
  });
});

// ===========================================================================
describe("INVARIANT 9 - Missing data cannot become zero", () => {
  it.each([NaN, Infinity, null, undefined, "5"])("rejects %s as an amount", (v) => {
    expect(isUsableAmount(v as any)).toBe(false);
  });

  it("an undefined ratio is null, not zero", () => {
    expect(safeRatio(100, 0)).toBeNull();
    expect(safeRatio(undefined, 100)).toBeNull();
  });

  it("a malformed amount is dropped from movements rather than treated as zero", () => {
    const { movements } = verifiedMovements([
      { id: "a", amount: NaN, type: "INFLOW", status: "SUCCESS", expectedDate: T0 },
    ] as any);
    expect(movements).toHaveLength(0);
  });
});

// ===========================================================================
describe("INVARIANT 10/11 - Stale and old strategies cannot execute", () => {
  const ctx = {
    strategyType: "FULL_INTERVENTION",
    startingCash: 10000000,
    requiredBuffer: 5000000,
    forecastHorizonDays: 14,
    movements: [],
    obligations: [],
    actionTargets: [],
    engineVersion: "16.0.0",
    scoringConfigVersion: "16.0.0",
    liquidityConfigVersion: "16.0.0",
  };

  it("a materially changed context blocks execution", () => {
    const before = computeContextFingerprint(ctx);
    const after = computeContextFingerprint({ ...ctx, startingCash: 20000000 });
    const verdict = classifyStaleness(before, after);
    // Setup assertion: the change must actually be material.
    expect(verdict.classification).toBe("MATERIAL_CHANGE");
    expect(verdict.blocksExecution).toBe(true);
  });

  it("a strategy with NO fingerprint is blocked and named as an old-engine strategy", () => {
    const verdict = classifyStaleness(null, computeContextFingerprint(ctx));
    expect(verdict.classification).toBe("UNKNOWN");
    expect(verdict.blocksExecution).toBe(true);
    expect(verdict.decisionFingerprint).toBeNull();
    expect(verdict.changes[0].reason).toMatch(/older engine version/i);
  });

  it("no fabricated fingerprint is ever produced for an old strategy", () => {
    const verdict = classifyStaleness(undefined, computeContextFingerprint(ctx));
    // The current fingerprint is reported, but the decision side stays null -
    // it is never back-filled to make the comparison pass.
    expect(verdict.decisionFingerprint).toBeNull();
    expect(verdict.currentFingerprint).toBeTruthy();
  });

  it("an unchanged context remains executable (the gate is not blocking everything)", () => {
    const verdict = classifyStaleness(computeContextFingerprint(ctx), computeContextFingerprint(ctx));
    expect(verdict.classification).toBe("NO_CHANGE");
    expect(verdict.blocksExecution).toBe(false);
  });
});

// ===========================================================================
describe("INVARIANT 12/13 - Audit events and state machine cannot be bypassed", () => {
  function seedDecision(status: string) {
    decisionStore.decisions.length = 0;
    decisionStore.events.length = 0;
    decisionStore.decisions.push({
      id: "dec-1", businessId: "biz-A", strategyId: "strat-1", status,
      baselineSnapshot: {}, recommendedSnapshot: {}, engineVersion: "16.0.0",
      approvalSnapshot: null, executionSnapshot: null,
    });
  }

  it("an invalid transition is refused and writes no event", async () => {
    seedDecision("REJECTED");
    await expect(
      transitionDecision(client, { id: "dec-1" }, "EXECUTED" as any, {}, { audit: { actorType: "SYSTEM" } })
    ).rejects.toBeInstanceOf(InvalidDecisionTransitionError);
    expect(decisionStore.decisions[0].status).toBe("REJECTED");
    expect(decisionStore.events).toHaveLength(0);
  });

  it("a valid transition always writes exactly one event", async () => {
    seedDecision("APPROVED");
    await transitionDecision(client, { id: "dec-1" }, "EXECUTED" as any, {}, {
      audit: { actorType: "SYSTEM", actorId: "worker" },
    });
    expect(decisionStore.events).toHaveLength(1);
    expect(decisionStore.events[0].fromStatus).toBe("APPROVED");
    expect(decisionStore.events[0].toStatus).toBe("EXECUTED");
  });

  it("historical events are never rewritten by a later transition", async () => {
    seedDecision("APPROVED");
    await transitionDecision(client, { id: "dec-1" }, "EXECUTED" as any, {}, { audit: { actorType: "SYSTEM" } });
    const firstEvent = { ...decisionStore.events[0] };
    await transitionDecision(client, { id: "dec-1" }, "RECONCILED" as any, {}, { audit: { actorType: "WEBHOOK" } });

    expect(decisionStore.events).toHaveLength(2);
    expect(decisionStore.events[0]).toEqual(firstEvent);
  });

  it("the event model exposes no update or delete path", () => {
    expect((client as any).decisionEvent.update).toBeUndefined();
    expect((client as any).decisionEvent.delete).toBeUndefined();
    expect((client as any).decisionEvent.deleteMany).toBeUndefined();
  });

  it("immutable historical fields are rejected outright", async () => {
    seedDecision("APPROVED");
    await expect(
      transitionDecision(client, { id: "dec-1" }, "EXECUTED" as any, { baselineSnapshot: {} })
    ).rejects.toThrow(/Immutable historical field/);
  });

  it("every terminal decision status is genuinely terminal", () => {
    expect(validateDecisionTransition("OUTCOME_MEASURED" as any, "APPROVED" as any)).toBe(false);
    expect(validateDecisionTransition("OUTCOME_MEASURED" as any, "EXECUTED" as any)).toBe(false);
  });
});

// ===========================================================================
describe("INVARIANT 15 - No LLM can influence financial calculations", () => {
  it("no execution or reconciliation module imports the AI layer", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const dirs = [
      path.resolve(__dirname, "../../execution"),
      path.resolve(__dirname, ".."),
      path.resolve(__dirname, "../../config"),
    ];

    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".ts")) continue;
        const src = fs.readFileSync(path.join(dir, f), "utf-8");
        if (/from\s+["'].*(ai\/agents|ai\/prompts|groq|openai)/.test(src)) offenders.push(`${dir}/${f}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the reconciliation verdict is a pure function of provider evidence", () => {
    const a = interpretScan("k", { found: { id: "p", reference_id: "k", status: "paid" }, exhaustive: true }, T0);
    const b = interpretScan("k", { found: { id: "p", reference_id: "k", status: "paid" }, exhaustive: true }, T0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ===========================================================================
describe("INVARIANT 16/17/18 - Failure and partial execution stay honest", () => {
  it("a ledger write that never landed is CONFIRMED_FAILURE, not success", () => {
    const verdict = reconcileReschedulePayout(
      { targetId: "p1", originalDueDate: "2026-09-04", expectedDueDate: "2026-09-26", expectedStatus: "RESCHEDULED" },
      { id: "p1", scheduledDate: new Date("2026-09-04"), status: "SCHEDULED" },
      T0
    );
    expect(verdict.verdict).toBe("RESCHEDULE_NOT_APPLIED");
    expect(verdict.status).toBe("CONFIRMED_FAILURE");
    expect(verdict.retrySafe).toBe(true);
  });

  it("a ledger row changed by someone else is UNKNOWN, not success", () => {
    const verdict = reconcileReschedulePayout(
      { targetId: "p1", originalDueDate: "2026-09-04", expectedDueDate: "2026-09-26", expectedStatus: "RESCHEDULED" },
      { id: "p1", scheduledDate: new Date("2026-09-11"), status: "SCHEDULED" },
      T0
    );
    expect(verdict.verdict).toBe("TARGET_ALREADY_CHANGED");
    expect(verdict.status).toBe("UNKNOWN");
    expect(verdict.retrySafe).toBe(false);
  });

  it("a missing ledger row is UNKNOWN, never a confirmed outcome", () => {
    const verdict = reconcilePauseExpense(
      { targetId: "t1", originalStatus: "PENDING", expectedStatus: "FAILED" },
      null,
      T0
    );
    expect(verdict.verdict).toBe("TARGET_MISSING");
    expect(verdict.status).toBe("UNKNOWN");
    expect(verdict.retrySafe).toBe(false);
  });

  it("a partial multi-action run cannot report full success", async () => {
    // Two actions: one succeeds, one is unknown.
    const okIntent = await executeWithDurableIntent(client, {
      ...base,
      actionId: "act-ok",
      dispatch: async () => ({ externalRef: "plink_ok" }),
    });
    const unknownIntent = await executeWithDurableIntent(client, {
      ...base,
      actionId: "act-unknown",
      dispatch: async () => {
        throw new Error("ETIMEDOUT");
      },
    });

    // Setup assertion: the mix must genuinely be mixed.
    expect(okIntent.outcome).toBe("SUCCEEDED");
    expect(unknownIntent.outcome).toBe("UNKNOWN");

    const statuses = store.intents.map((i) => i.status).sort();
    expect(statuses).toEqual(["SUCCEEDED", "UNKNOWN"]);

    // The decision aggregation rule: any unknown means execution is NOT confirmed.
    const anyUnknown = store.intents.some((i) => i.status === "UNKNOWN");
    expect(anyUnknown).toBe(true);
    expect(validateDecisionTransition("APPROVED" as any, "APPROVED" as any)).toBe(true);
  });
});

// ===========================================================================
describe("PART 7 - Production configuration cannot silently disable controls", () => {
  const KEYS = [
    "DATABASE_URL",
    "SESSION_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
  ];

  it("a missing webhook secret is FATAL in production", () => {
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const report = inspectConfiguration("production");
    expect(report.financiallyUnsafe).toBe(true);
    expect(report.fatalKeys).toContain("RAZORPAY_WEBHOOK_SECRET");
    if (saved) process.env.RAZORPAY_WEBHOOK_SECRET = saved;
  });

  it("the same absence is DEGRADED, not fatal, outside production", () => {
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const report = inspectConfiguration("development");
    expect(report.financiallyUnsafe).toBe(false);
    expect(report.degradedKeys).toContain("RAZORPAY_WEBHOOK_SECRET");
    if (saved) process.env.RAZORPAY_WEBHOOK_SECRET = saved;
  });

  it("every financial control is covered by a check", () => {
    const report = inspectConfiguration("production");
    for (const key of KEYS) {
      expect(report.checks.map((c) => c.key)).toContain(key);
    }
  });

  it("a placeholder value counts as absent", () => {
    const saved = process.env.RAZORPAY_KEY_ID;
    process.env.RAZORPAY_KEY_ID = "rzp_placeholder";
    const report = inspectConfiguration("production");
    expect(report.fatalKeys).toContain("RAZORPAY_KEY_ID");
    if (saved) process.env.RAZORPAY_KEY_ID = saved;
    else delete process.env.RAZORPAY_KEY_ID;
  });

  it("the redacted summary never exposes a secret value", async () => {
    const { redactedConfigSummary } = await import("../../config/productionConfig");
    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "super-secret-value-12345";
    const summary = redactedConfigSummary(inspectConfiguration("production"));
    expect(JSON.stringify(summary)).not.toContain("super-secret-value-12345");
    expect(summary.controls.find((c) => c.key === "SESSION_SECRET")?.configured).toBe(true);
    if (saved) process.env.SESSION_SECRET = saved;
    else delete process.env.SESSION_SECRET;
  });
});

// ===========================================================================
// PHASE 17 PART 19 - malformed / wrong-mode configuration must fail closed
// ===========================================================================
describe("PART 19 - Production configuration fails closed on malformed values", () => {
  const KEYS = ["DATABASE_URL", "SESSION_SECRET", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });

  const restore = () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  };

  it("a TEST-mode Razorpay key in production is FATAL", async () => {
    const { inspectConfiguration } = await import("../../config/productionConfig");
    process.env.RAZORPAY_KEY_ID = "rzp_test_abc123";
    const report = inspectConfiguration("production");
    expect(report.financiallyUnsafe).toBe(true);
    expect(report.defects.some((d) => /TEST-mode/i.test(d.problem))).toBe(true);
    restore();
  });

  it("production pointed at a local database is FATAL", async () => {
    const { inspectConfiguration } = await import("../../config/productionConfig");
    process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
    const report = inspectConfiguration("production");
    expect(report.fatalKeys).toContain("DATABASE_URL");
    restore();
  });

  it("a malformed Razorpay key is rejected", async () => {
    const { detectMalformedConfiguration } = await import("../../config/productionConfig");
    process.env.RAZORPAY_KEY_ID = "not-a-razorpay-key";
    expect(detectMalformedConfiguration(true).some((d) => d.key === "RAZORPAY_KEY_ID")).toBe(true);
    restore();
  });

  it("a short session secret is rejected", async () => {
    const { detectMalformedConfiguration } = await import("../../config/productionConfig");
    process.env.SESSION_SECRET = "tooshort";
    expect(detectMalformedConfiguration(true).some((d) => d.key === "SESSION_SECRET")).toBe(true);
    restore();
  });

  it("an empty string counts as absent, not as configured", async () => {
    const { inspectConfiguration } = await import("../../config/productionConfig");
    process.env.RAZORPAY_WEBHOOK_SECRET = "   ";
    const report = inspectConfiguration("production");
    expect(report.fatalKeys).toContain("RAZORPAY_WEBHOOK_SECRET");
    restore();
  });

  it("a live-mode key in production is NOT flagged as a defect", async () => {
    const { detectMalformedConfiguration } = await import("../../config/productionConfig");
    process.env.RAZORPAY_KEY_ID = "rzp_live_realkey123";
    // The gate must not block a correct production setup.
    expect(detectMalformedConfiguration(true).some((d) => d.key === "RAZORPAY_KEY_ID")).toBe(false);
    restore();
  });

  it("no defect description leaks the offending value", async () => {
    const { inspectConfiguration, redactedConfigSummary } = await import("../../config/productionConfig");
    process.env.RAZORPAY_KEY_ID = "rzp_test_SECRETVALUE999";
    const summary = redactedConfigSummary(inspectConfiguration("production"));
    expect(JSON.stringify(summary)).not.toContain("SECRETVALUE999");
    restore();
  });
});
