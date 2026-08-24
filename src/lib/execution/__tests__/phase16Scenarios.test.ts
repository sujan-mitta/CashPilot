import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recordExecutionIntent,
  claimExecutionIntent,
  resolveIntentUnknown,
  sweepAbandonedIntents,
} from "../executionIntent";
import { executeWithDurableIntent, reconcileUnknownIntent, isRetryPermitted } from "../executor";
import { interpretScan, scanForReference, providerUnavailable } from "../providerReconciliation";
import { reconcileReschedulePayout, reconcilePauseExpense } from "../ledgerReconciliation";
import { classifyProviderError, ProviderRejectedError, ProviderIndeterminateError } from "../../razorpay/client";
import { transitionDecision, InvalidDecisionTransitionError } from "../../engine/decisionStateMachine";
import { makeExecutionIntentFake, makeDecisionFakes } from "../../engine/__tests__/helpers/prismaFakes";
import { ExecutionOperation } from "../../../../generated/prisma/client";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/**
 * PHASE 16 ADVERSARIAL SCENARIOS  (PART 15)
 *
 * A-W, each a named fixture proving one invariant. Every scenario asserts its
 * own setup landed before asserting the property, so none can pass vacuously.
 */

const intents = { intents: [] as any[] };
const decisions = { decisions: [] as any[], events: [] as any[] };

const payouts: any[] = [];
const transactions: any[] = [];

const client: any = {
  executionIntent: makeExecutionIntentFake(intents),
  ...makeDecisionFakes(decisions),
  payout: { findFirst: async ({ where }: any) => payouts.find((p) => p.id === where.id) ?? null },
  transaction: { findFirst: async ({ where }: any) => transactions.find((t) => t.id === where.id) ?? null },
};

const T0 = new Date("2026-10-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const linkBase = {
  businessId: "biz-A",
  strategyId: "strat-1",
  actionId: "act-1",
  operation: ExecutionOperation.CREATE_PAYMENT_LINK,
  amount: 2400000,
};

beforeEach(() => {
  intents.intents.length = 0;
  decisions.decisions.length = 0;
  decisions.events.length = 0;
  payouts.length = 0;
  transactions.length = 0;
});

describe("PHASE 16 scenarios A-W", () => {
  // -------------------------------------------------------------------------
  it("A. provider timeout AFTER the request was transmitted -> UNKNOWN, no retry", async () => {
    const res = await executeWithDurableIntent(client, {
      ...linkBase,
      dispatch: async () => {
        throw new ProviderIndeterminateError("ETIMEDOUT after send");
      },
    });
    expect(res.outcome).toBe("UNKNOWN");
    expect(intents.intents[0].status).toBe("UNKNOWN");
    expect(isRetryPermitted(intents.intents[0])).toBe(false);
  });

  it("B. provider rejection BEFORE transmission -> FAILED, still not blindly retryable", async () => {
    const err: any = new Error("amount must be positive");
    err.statusCode = 400;
    const res = await executeWithDurableIntent(client, {
      ...linkBase,
      dispatch: async () => {
        throw err;
      },
    });
    // Setup assertion: this must classify as a definite rejection.
    expect(classifyProviderError(err)).toBeInstanceOf(ProviderRejectedError);
    expect(res.outcome).toBe("FAILED");
    // No reconciliation evidence yet, so retry stays closed.
    expect(isRetryPermitted(intents.intents[0])).toBe(false);
  });

  it("C. timeout, then the settlement turns out to have succeeded -> reconciles to SUCCEEDED", async () => {
    await executeWithDurableIntent(client, {
      ...linkBase,
      dispatch: async () => {
        throw new ProviderIndeterminateError("ETIMEDOUT");
      },
    });
    expect(intents.intents[0].status).toBe("UNKNOWN");

    await reconcileUnknownIntent(client, intents.intents[0].id, {
      lookup: async () =>
        interpretScan("cp_act-1", {
          found: { id: "plink_real", reference_id: "cp_act-1", status: "paid" },
          exhaustive: true,
        }),
    });

    expect(intents.intents[0].status).toBe("SUCCEEDED");
    expect(intents.intents[0].externalRef).toBe("plink_real");
    expect(intents.intents[0].retrySafe).toBe(false);
  });

  it("D. provider unavailable during reconciliation -> stays UNKNOWN", async () => {
    const { intent } = await recordExecutionIntent(client, linkBase);
    await resolveIntentUnknown(client, intent.id, "timeout");

    const res = await reconcileUnknownIntent(client, intent.id, {
      lookup: async () => providerUnavailable("cp_act-1", "provider down"),
    });

    expect(res.result.status).toBe("UNKNOWN");
    expect(intents.intents[0].status).toBe("UNKNOWN");
    expect(intents.intents[0].retrySafe).toBe(false);
  });

  it("E. payment link exists but our record says UNKNOWN -> the provider wins", async () => {
    const { intent } = await recordExecutionIntent(client, linkBase);
    await resolveIntentUnknown(client, intent.id, "timeout");
    expect(intents.intents[0].status).toBe("UNKNOWN");

    await reconcileUnknownIntent(client, intent.id, {
      lookup: async () =>
        interpretScan("cp_act-1", {
          found: { id: "plink_exists", reference_id: "cp_act-1", status: "created" },
          exhaustive: true,
        }),
    });

    // Link exists but is unpaid -> PENDING, so the intent stays unresolved and
    // is certainly not retryable.
    expect(intents.intents[0].status).toBe("UNKNOWN");
    expect(isRetryPermitted(intents.intents[0])).toBe(false);
  });

  it("F. our record says dispatching but the provider has nothing -> retry becomes safe", async () => {
    const { intent } = await recordExecutionIntent(client, linkBase);
    await claimExecutionIntent(client, intent.id);
    expect(intents.intents[0].status).toBe("DISPATCHING");

    await sweepAbandonedIntents(client, new Date(Date.now() + 10 * 60 * 1000), 60 * 1000);
    expect(intents.intents[0].status).toBe("UNKNOWN");

    await reconcileUnknownIntent(client, intent.id, {
      lookup: async () => interpretScan("cp_act-1", { found: null, exhaustive: true }),
    });

    expect(intents.intents[0].status).toBe("FAILED");
    expect(isRetryPermitted(intents.intents[0])).toBe(true);
  });

  // ---- ledger operations ---------------------------------------------------
  const payoutIntent = {
    businessId: "biz-A",
    strategyId: "strat-1",
    actionId: "act-resched",
    operation: ExecutionOperation.RESCHEDULE_PAYOUT,
    amount: 5500000,
    targetType: "PAYOUT",
    targetId: "po-1",
    expectedState: {
      kind: "PAYOUT_RESCHEDULE",
      originalDueDate: "2026-10-04",
      expectedDueDate: "2026-10-26",
      expectedStatus: "RESCHEDULED",
    },
  };

  it("G. reschedule succeeded but the response was lost -> reconciles to SUCCEEDED", async () => {
    payouts.push({ id: "po-1", scheduledDate: new Date("2026-10-26"), status: "RESCHEDULED" });

    const res = await executeWithDurableIntent(client, {
      ...payoutIntent,
      dispatch: async () => {
        throw new ProviderIndeterminateError("connection lost after commit");
      },
    });
    expect(res.outcome).toBe("UNKNOWN");

    const recon = await reconcileUnknownIntent(client, intents.intents[0].id, { now: T0 });
    expect(recon.result.status).toBe("CONFIRMED_SUCCESS");
    expect(intents.intents[0].status).toBe("SUCCEEDED");
    expect(intents.intents[0].retrySafe).toBe(false);
  });

  it("H. reschedule failed and the response was lost -> reconciles to retry-safe FAILED", async () => {
    // The row is exactly as it was: the write never landed.
    payouts.push({ id: "po-1", scheduledDate: new Date("2026-10-04"), status: "SCHEDULED" });

    await executeWithDurableIntent(client, {
      ...payoutIntent,
      dispatch: async () => {
        throw new ProviderIndeterminateError("connection lost");
      },
    });

    const recon = await reconcileUnknownIntent(client, intents.intents[0].id, { now: T0 });
    expect(recon.result.status).toBe("CONFIRMED_FAILURE");
    expect(intents.intents[0].status).toBe("FAILED");
    expect(isRetryPermitted(intents.intents[0])).toBe(true);
  });

  const pauseIntent = {
    businessId: "biz-A",
    strategyId: "strat-1",
    actionId: "act-pause",
    operation: ExecutionOperation.PAUSE_EXPENSE,
    amount: 1500000,
    targetType: "TRANSACTION",
    targetId: "tx-1",
    expectedState: { kind: "EXPENSE_PAUSE", originalStatus: "PENDING", expectedStatus: "FAILED" },
  };

  it("I. pause succeeded but the response was lost -> reconciles to SUCCEEDED", async () => {
    transactions.push({ id: "tx-1", status: "FAILED" });

    await executeWithDurableIntent(client, {
      ...pauseIntent,
      dispatch: async () => {
        throw new ProviderIndeterminateError("lost");
      },
    });

    const recon = await reconcileUnknownIntent(client, intents.intents[0].id, { now: T0 });
    expect(recon.result.status).toBe("CONFIRMED_SUCCESS");
    expect(intents.intents[0].status).toBe("SUCCEEDED");
  });

  it("J. pause failed and the response was lost -> retry-safe FAILED", async () => {
    transactions.push({ id: "tx-1", status: "PENDING" });

    await executeWithDurableIntent(client, {
      ...pauseIntent,
      dispatch: async () => {
        throw new ProviderIndeterminateError("lost");
      },
    });

    const recon = await reconcileUnknownIntent(client, intents.intents[0].id, { now: T0 });
    expect(recon.result.status).toBe("CONFIRMED_FAILURE");
    expect(isRetryPermitted(intents.intents[0])).toBe(true);
  });

  it("J2. an expense already paid is NOT retry safe", () => {
    const v = reconcilePauseExpense(
      { targetId: "tx-1", originalStatus: "PENDING", expectedStatus: "FAILED" },
      { id: "tx-1", status: "SUCCESS" },
      T0
    );
    expect(v.verdict).toBe("TARGET_ALREADY_SETTLED");
    expect(v.retrySafe).toBe(false);
  });

  it("K. two simultaneous execute requests -> one provider call", async () => {
    let calls = 0;
    const run = () =>
      executeWithDurableIntent(client, {
        ...linkBase,
        dispatch: async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 5));
          return { externalRef: "plink_1" };
        },
      });
    await Promise.all([run(), run()]);
    expect(calls).toBe(1);
    expect(intents.intents).toHaveLength(1);
  });

  it("L. two simultaneous reconciliations -> consistent single outcome", async () => {
    const { intent } = await recordExecutionIntent(client, linkBase);
    await resolveIntentUnknown(client, intent.id, "timeout");

    let lookups = 0;
    const lookup = async () => {
      lookups++;
      return interpretScan("cp_act-1", {
        found: { id: "plink_1", reference_id: "cp_act-1", status: "paid" },
        exhaustive: true,
      });
    };

    const [a, b] = await Promise.all([
      reconcileUnknownIntent(client, intent.id, { lookup }),
      reconcileUnknownIntent(client, intent.id, { lookup }),
    ]);

    // Both observed the same truth; the row ends in exactly one state.
    expect(intents.intents[0].status).toBe("SUCCEEDED");
    expect([a.result.status, b.result.status]).toContain("CONFIRMED_SUCCESS");
    expect(lookups).toBeGreaterThan(0); // the lookup genuinely ran
  });

  it("M. a webhook arriving before the execution response cannot un-settle it", async () => {
    // Webhook settles first.
    const { intent } = await recordExecutionIntent(client, linkBase);
    await claimExecutionIntent(client, intent.id);
    await client.executionIntent.updateMany({
      where: { id: intent.id },
      data: { status: "SUCCEEDED", externalRef: "plink_1", resolvedAt: new Date() },
    });

    // The slow execution response then arrives.
    const res = await executeWithDurableIntent(client, {
      ...linkBase,
      dispatch: async () => ({ externalRef: "plink_DUPLICATE" }),
    });

    expect(res.outcome).toBe("ALREADY_SUCCEEDED");
    expect(intents.intents[0].externalRef).toBe("plink_1");
  });

  it("N. a webhook arriving after the execution response is a no-op on the intent", async () => {
    await executeWithDurableIntent(client, {
      ...linkBase,
      dispatch: async () => ({ externalRef: "plink_1", externalStatus: "created" }),
    });
    expect(intents.intents[0].status).toBe("SUCCEEDED");

    const recon = await reconcileUnknownIntent(client, intents.intents[0].id, {});
    expect(recon.intentStatusAfter).toBe("SUCCEEDED");
    expect(recon.result.reason).toMatch(/nothing to reconcile/i);
  });

  it("R. an old strategy (no fingerprint) is blocked rather than fabricated", async () => {
    const { classifyStaleness, computeContextFingerprint } = await import("../../engine/strategyFreshness");
    const current = computeContextFingerprint({
      strategyType: "FULL_INTERVENTION", startingCash: 1, requiredBuffer: 1, forecastHorizonDays: 14,
      movements: [], obligations: [], actionTargets: [],
      engineVersion: "16.0.0", scoringConfigVersion: "16.0.0", liquidityConfigVersion: "16.0.0",
    });
    const verdict = classifyStaleness(null, current);
    expect(verdict.blocksExecution).toBe(true);
    expect(verdict.decisionFingerprint).toBeNull();
  });

  it("S. a forged cross-tenant decision id cannot be transitioned", async () => {
    decisions.decisions.push({
      id: "dec-A", businessId: "biz-A", strategyId: "s", status: "APPROVED",
      baselineSnapshot: {}, recommendedSnapshot: {}, approvalSnapshot: null, executionSnapshot: null,
    });

    // A transition scoped to the WRONG tenant matches nothing.
    const result = await transitionDecision(
      client,
      { id: "dec-A", businessId: "biz-B" } as any,
      "EXECUTED" as any,
      {}
    );
    expect(result).toBeNull();
    expect(decisions.decisions[0].status).toBe("APPROVED");
    expect(decisions.events).toHaveLength(0);
  });

  it("T. a decision event insertion failure prevents the status change", async () => {
    const committed: any = { status: "APPROVED" };
    let staged: any = null;
    const failing: any = {
      decision: {
        findFirst: async () => ({ id: "d", businessId: "b", ...committed, ...(staged ?? {}) }),
        updateMany: async ({ data }: any) => {
          staged = { ...(staged ?? {}), ...data };
          return { count: 1 };
        },
      },
      decisionEvent: {
        create: async () => {
          throw new Error("event write failed");
        },
      },
    };

    await expect(
      transitionDecision(failing, { id: "d" }, "EXECUTED" as any, {}, { audit: { actorType: "SYSTEM" } })
    ).rejects.toThrow(/event write failed/);
    expect(committed.status).toBe("APPROVED");
  });

  it("U. a partial four-action run leaves a mixed, honest picture", async () => {
    const outcomes = [];
    outcomes.push(await executeWithDurableIntent(client, { ...linkBase, actionId: "a1", dispatch: async () => ({ externalRef: "p1" }) }));
    outcomes.push(await executeWithDurableIntent(client, { ...linkBase, actionId: "a2", dispatch: async () => ({ externalRef: "p2" }) }));
    outcomes.push(await executeWithDurableIntent(client, {
      ...linkBase, actionId: "a3",
      dispatch: async () => { throw new ProviderIndeterminateError("ETIMEDOUT"); },
    }));
    const rejected: any = new Error("rejected"); rejected.statusCode = 400;
    outcomes.push(await executeWithDurableIntent(client, {
      ...linkBase, actionId: "a4",
      dispatch: async () => { throw rejected; },
    }));

    // Setup assertion: all four distinct outcomes must genuinely have occurred.
    expect(outcomes.map((o) => o.outcome)).toEqual(["SUCCEEDED", "SUCCEEDED", "UNKNOWN", "FAILED"]);
    const statuses = intents.intents.map((i) => i.status).sort();
    expect(statuses).toEqual(["FAILED", "SUCCEEDED", "SUCCEEDED", "UNKNOWN"]);
    // Not all succeeded: the run cannot be represented as fully successful.
    expect(statuses.every((s) => s === "SUCCEEDED")).toBe(false);
  });

  it("V. an unknown action followed by SAFE reconciliation resolves cleanly", async () => {
    payouts.push({ id: "po-1", scheduledDate: new Date("2026-10-26"), status: "RESCHEDULED" });
    await executeWithDurableIntent(client, {
      ...payoutIntent,
      dispatch: async () => { throw new ProviderIndeterminateError("lost"); },
    });
    expect(intents.intents[0].status).toBe("UNKNOWN");

    await reconcileUnknownIntent(client, intents.intents[0].id, { now: T0 });
    expect(intents.intents[0].status).toBe("SUCCEEDED");
    expect(intents.intents[0].lastReconciledAt).toBeTruthy();
  });

  it("W. an unknown action followed by an UNSAFE retry attempt is refused", async () => {
    // The payout moved somewhere we did not ask for: attribution is impossible.
    payouts.push({ id: "po-1", scheduledDate: new Date("2026-10-12"), status: "SCHEDULED" });
    await executeWithDurableIntent(client, {
      ...payoutIntent,
      dispatch: async () => { throw new ProviderIndeterminateError("lost"); },
    });

    const recon = await reconcileUnknownIntent(client, intents.intents[0].id, { now: T0 });
    expect(recon.result.status).toBe("UNKNOWN");
    expect(isRetryPermitted(intents.intents[0])).toBe(false);

    // And a re-execution is still blocked.
    let calls = 0;
    const res = await executeWithDurableIntent(client, {
      ...payoutIntent,
      dispatch: async () => { calls++; return { externalRef: "x" }; },
    });
    expect(res.outcome).toBe("BLOCKED_UNKNOWN");
    expect(calls).toBe(0);
  });
});
