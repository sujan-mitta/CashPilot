import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordExecutionIntent,
  claimExecutionIntent,
  resolveIntentSucceeded,
  resolveIntentFailed,
  resolveIntentUnknown,
  sweepAbandonedIntents,
  buildIdempotencyKey,
  isDispatchable,
} from "../executionIntent";
import { executeWithDurableIntent, reconcileUnknownIntent } from "../executor";
import {
  classifyProviderError,
  ProviderIndeterminateError,
  ProviderRejectedError,
} from "../../razorpay/client";
import { makeExecutionIntentFake } from "../../engine/__tests__/helpers/prismaFakes";
import { ExecutionOperation } from "../../../../generated/prisma/client";

const store = { intents: [] as any[] };
const client: any = { executionIntent: makeExecutionIntentFake(store) };

const base = {
  businessId: "biz-A",
  strategyId: "strat-1",
  actionId: "act-1",
  operation: ExecutionOperation.CREATE_PAYMENT_LINK,
  amount: 2400000,
};

beforeEach(() => {
  store.intents.length = 0;
});

// ===========================================================================
// PART 6 - STABLE IDEMPOTENCY IDENTITY
// ===========================================================================
describe("PART 6 - Idempotency identity", () => {
  it("derives the same key for the same action every time", () => {
    expect(buildIdempotencyKey("act-1")).toBe(buildIdempotencyKey("act-1"));
    expect(buildIdempotencyKey("act-1", "inv-9")).toBe(buildIdempotencyKey("act-1", "inv-9"));
  });

  it("contains no randomness or timestamp, so a retry reuses it", () => {
    const key = buildIdempotencyKey("act-1", "inv-9");
    expect(key).toBe("cp_act-1_inv-9");
    // A second call a moment later must not differ.
    expect(buildIdempotencyKey("act-1", "inv-9")).toBe(key);
  });

  it("never exceeds the provider's 40-character reference_id limit", () => {
    // VERIFIED_LIVE: Razorpay rejects reference_id > 40 chars with
    //   "BAD_REQUEST_ERROR: reference_id: the length must be no more than 40."
    // Real cuids are 25 chars, so a fan-out key of `cp_<cuid>_<cuid>` is 54 and
    // was ALWAYS rejected - every per-invoice collection link failed silently
    // until this was found in the running app.
    const cuid = () => "c" + "m".repeat(24); // 25 chars, same shape as a real cuid
    const action = cuid();
    const target = cuid();

    // Setup assertion: the naive form must genuinely be over the limit, or this
    // test proves nothing.
    expect(`cp_${action}_${target}`.length).toBeGreaterThan(40);

    expect(buildIdempotencyKey(action).length).toBeLessThanOrEqual(40);
    expect(buildIdempotencyKey(action, target).length).toBeLessThanOrEqual(40);
  });

  it("keeps short keys human-readable so existing intents are not orphaned", () => {
    const action = "c" + "m".repeat(24);
    // Under the limit -> unchanged, so any key the provider already accepted
    // still resolves to the same intent.
    expect(buildIdempotencyKey(action)).toBe(`cp_${action}`);
  });

  it("a hashed fan-out key is still deterministic and target-distinct", () => {
    const action = "c" + "m".repeat(24);
    const t1 = "a" + "b".repeat(24);
    const t2 = "a" + "c".repeat(24);
    expect(buildIdempotencyKey(action, t1)).toBe(buildIdempotencyKey(action, t1));
    expect(buildIdempotencyKey(action, t1)).not.toBe(buildIdempotencyKey(action, t2));
    expect(buildIdempotencyKey(action, t1)).not.toBe(buildIdempotencyKey(action));
  });

  it("separates fan-out targets so one action can hold several operations", () => {
    expect(buildIdempotencyKey("act-1", "inv-1")).not.toBe(buildIdempotencyKey("act-1", "inv-2"));
  });

  it("recording the same intent twice yields one row, not two", async () => {
    const a = await recordExecutionIntent(client, base);
    const b = await recordExecutionIntent(client, base);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.intent.id).toBe(b.intent.id);
    expect(store.intents).toHaveLength(1);
  });
});

// ===========================================================================
// PART 5 - CRASH SIMULATION AT EVERY BOUNDARY
// ===========================================================================
describe("PART 5 - Crash recovery", () => {
  it("1. crash AFTER intent persisted leaves a recoverable RECORDED row", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    // Process dies here. Nothing external has happened.
    expect(intent.status).toBe("RECORDED");
    expect(isDispatchable(intent.status)).toBe(true);
    expect(intent.dispatchedAt).toBeNull();
  });

  it("2. crash BEFORE the external call: re-running dispatches exactly once", async () => {
    let calls = 0;
    const run = () =>
      executeWithDurableIntent(client, {
        ...base,
        dispatch: async () => {
          calls++;
          return { externalRef: "plink_1" };
        },
      });

    // First run crashes before dispatch - simulated by claiming then abandoning.
    const { intent } = await recordExecutionIntent(client, base);
    await claimExecutionIntent(client, intent.id);
    // Recovery sweeps the abandoned claim.
    await sweepAbandonedIntents(client, new Date(Date.now() + 10 * 60 * 1000), 60 * 1000);
    expect(store.intents[0].status).toBe("UNKNOWN");

    // A rerun must NOT call the provider again.
    const result = await run();
    expect(result.outcome).toBe("BLOCKED_UNKNOWN");
    expect(calls).toBe(0);
  });

  it("3. crash AFTER the external call leaves DISPATCHING, which sweeps to UNKNOWN", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await claimExecutionIntent(client, intent.id);
    expect(store.intents[0].status).toBe("DISPATCHING");

    const swept = await sweepAbandonedIntents(client, new Date(Date.now() + 5 * 60 * 1000), 60 * 1000);
    expect(swept).toContain(intent.id);
    // Never RECORDED (which would make it re-dispatchable) and never FAILED.
    expect(store.intents[0].status).toBe("UNKNOWN");
    expect(store.intents[0].unknownReason).toMatch(/indeterminate/i);
  });

  it("4. crash BEFORE the response is persisted never yields a false COMPLETED", async () => {
    const result = await executeWithDurableIntent(client, {
      ...base,
      dispatch: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(result.outcome).toBe("UNKNOWN");
    expect(store.intents[0].status).toBe("UNKNOWN");
    expect(store.intents[0].externalRef).toBeNull();
  });

  it("5. crash AFTER the response is persisted is a no-op on rerun", async () => {
    let calls = 0;
    const run = () =>
      executeWithDurableIntent(client, {
        ...base,
        dispatch: async () => {
          calls++;
          return { externalRef: "plink_1", externalStatus: "created" };
        },
      });

    const first = await run();
    expect(first.outcome).toBe("SUCCEEDED");

    const second = await run();
    expect(second.outcome).toBe("ALREADY_SUCCEEDED");
    expect(second.externalRef).toBe("plink_1");
    expect(calls).toBe(1); // the provider was contacted exactly once
  });

  it("6. an intent recorded but never dispatched is not lost", async () => {
    await recordExecutionIntent(client, base);
    const orphan = store.intents.find((i) => i.status === "RECORDED");
    expect(orphan).toBeDefined();
    // A sweep must NOT touch it - nothing external happened, so it is safe.
    await sweepAbandonedIntents(client, new Date(Date.now() + 60 * 60 * 1000), 1000);
    expect(store.intents[0].status).toBe("RECORDED");
  });

  it("7. two concurrent runs produce exactly one external call", async () => {
    let calls = 0;
    const run = () =>
      executeWithDurableIntent(client, {
        ...base,
        dispatch: async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 5));
          return { externalRef: `plink_${calls}` };
        },
      });

    const [a, b] = await Promise.all([run(), run()]);
    expect(calls).toBe(1);
    const outcomes = [a.outcome, b.outcome].sort();
    // One wins; the other is told an operation already owns this intent.
    expect(outcomes).toContain("SUCCEEDED");
    expect(outcomes.some((o) => o === "BLOCKED_UNKNOWN" || o === "ALREADY_SUCCEEDED")).toBe(true);
  });
});

// ===========================================================================
// PART 4/7 - UNKNOWN NEVER AUTO-RETRIES; RECONCILIATION RESOLVES IT
// ===========================================================================
describe("PART 4/7 - EXECUTION_UNKNOWN recovery", () => {
  it("an UNKNOWN intent is not dispatchable", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentUnknown(client, intent.id, "timeout");
    expect(isDispatchable("UNKNOWN" as any)).toBe(false);

    let calls = 0;
    const result = await executeWithDurableIntent(client, {
      ...base,
      dispatch: async () => {
        calls++;
        return { externalRef: "plink_x" };
      },
    });
    expect(result.outcome).toBe("BLOCKED_UNKNOWN");
    expect(calls).toBe(0);
  });

  it("reconciliation CONFIRMS when the provider has our operation", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentUnknown(client, intent.id, "timeout");

    const res = await reconcileUnknownIntent(client, intent.id, {
      lookup: async () => ({
        status: "CONFIRMED_SUCCESS",
        providerReference: "plink_found",
        providerStatus: "paid",
        reason: "found and paid",
        expectedEvidence: "e",
        observedEvidence: "o",
        searchExhaustive: true,
        retrySafe: false,
        checkedAt: new Date().toISOString(),
      }),
    });
    expect(res.result.status).toBe("CONFIRMED_SUCCESS");
    expect(store.intents[0].status).toBe("SUCCEEDED");
    expect(store.intents[0].externalRef).toBe("plink_found");
  });

  it("reconciliation marks ABSENT when the provider definitively has nothing", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentUnknown(client, intent.id, "timeout");

    const res = await reconcileUnknownIntent(client, intent.id, {
      lookup: async () => ({
        status: "NOT_FOUND",
        reason: "exhaustive scan found nothing",
        expectedEvidence: "e",
        observedEvidence: "o",
        searchExhaustive: true,
        retrySafe: true,
        checkedAt: new Date().toISOString(),
      }),
    });
    expect(res.result.status).toBe("NOT_FOUND");
    // Now - and only now - a fresh attempt is safe.
    expect(store.intents[0].status).toBe("FAILED");
    expect(store.intents[0].retrySafe).toBe(true);
  });

  it("reconciliation remains UNKNOWN when lookup returns UNKNOWN (e.g. inside cooling window)", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentUnknown(client, intent.id, "timeout");

    const res = await reconcileUnknownIntent(client, intent.id, {
      lookup: async () => ({
        status: "UNKNOWN",
        reason: "inside 24-hour cooling-off window",
        expectedEvidence: "e",
        observedEvidence: "o",
        searchExhaustive: true,
        retrySafe: false,
        checkedAt: new Date().toISOString(),
      }),
    });
    expect(res.result.status).toBe("UNKNOWN");
    expect(store.intents[0].status).toBe("UNKNOWN");
    expect(store.intents[0].retrySafe).toBe(false);
  });

  it("reconciliation leaves it UNKNOWN when the provider cannot be reached", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentUnknown(client, intent.id, "timeout");

    const res = await reconcileUnknownIntent(client, intent.id, {
      lookup: async () => {
        throw new ProviderIndeterminateError("provider unreachable");
      },
    });
    expect(res.result.status).toBe("UNKNOWN");
    expect(store.intents[0].status).toBe("UNKNOWN");
    expect(store.intents[0].retrySafe).toBe(false);
  });

  it("reconciliation never re-issues the financial mutation", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentUnknown(client, intent.id, "timeout");

    const lookup = vi.fn(async () => ({
      status: "PENDING" as const,
      providerReference: "plink_found",
      providerStatus: "created",
      reason: "awaiting payment",
      expectedEvidence: "e",
      observedEvidence: "o",
      searchExhaustive: true,
      retrySafe: false,
      checkedAt: new Date().toISOString(),
    }));
    await reconcileUnknownIntent(client, intent.id, { lookup });
    // Exactly one READ, no create.
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(store.intents[0].attempts).toBe(0);
  });

  it("a resolved intent is not reconcilable", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentSucceeded(client, intent.id, "plink_1");
    const res = await reconcileUnknownIntent(client, intent.id, {});
    expect(res.intentStatusAfter).toBe("SUCCEEDED");
    expect(res.result.reason).toMatch(/nothing to reconcile/i);
  });
});

// ===========================================================================
// PROVIDER ERROR CLASSIFICATION - the basis of FAILED vs UNKNOWN
// ===========================================================================
describe("Provider error classification", () => {
  it.each([
    "ETIMEDOUT connecting",
    "socket hang up",
    "ECONNRESET",
    "network error",
    "502 Bad Gateway",
    "service unavailable",
  ])("treats %s as indeterminate", (message) => {
    expect(classifyProviderError(new Error(message))).toBeInstanceOf(ProviderIndeterminateError);
  });

  it("treats a 400 as a definite rejection", () => {
    const err: any = new Error("invalid amount");
    err.statusCode = 400;
    expect(classifyProviderError(err)).toBeInstanceOf(ProviderRejectedError);
  });

  it("treats a 429 as indeterminate, not a rejection", () => {
    const err: any = new Error("too many requests");
    err.statusCode = 429;
    expect(classifyProviderError(err)).toBeInstanceOf(ProviderIndeterminateError);
  });

  it("treats a 500 as indeterminate", () => {
    const err: any = new Error("server error");
    err.statusCode = 500;
    expect(classifyProviderError(err)).toBeInstanceOf(ProviderIndeterminateError);
  });

  it("defaults an unrecognised error to indeterminate rather than failed", () => {
    expect(classifyProviderError(new Error("???"))).toBeInstanceOf(ProviderIndeterminateError);
  });

  it("a definite rejection produces FAILED, which IS retryable", async () => {
    const err: any = new Error("amount must be positive");
    err.statusCode = 400;
    const result = await executeWithDurableIntent(client, {
      ...base,
      dispatch: async () => {
        throw err;
      },
    });
    expect(result.outcome).toBe("FAILED");
    expect(store.intents[0].status).toBe("FAILED");
  });
});

// ===========================================================================
// PART 31 - NO SILENT RETRIES
// ===========================================================================
describe("PART 31 - No silent retries", () => {
  it("a failed intent is not automatically re-dispatched", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await resolveIntentFailed(client, intent.id, "rejected");

    let calls = 0;
    const result = await executeWithDurableIntent(client, {
      ...base,
      dispatch: async () => {
        calls++;
        return { externalRef: "x" };
      },
    });
    expect(result.outcome).toBe("ALREADY_FAILED");
    expect(calls).toBe(0);
  });

  it("attempts are counted, so a runaway retry loop would be visible", async () => {
    const { intent } = await recordExecutionIntent(client, base);
    await claimExecutionIntent(client, intent.id);
    expect(store.intents[0].attempts).toBe(1);
    // A second claim on a DISPATCHING row is refused, so the count cannot grow
    // silently.
    const second = await claimExecutionIntent(client, intent.id);
    expect(second).toBeNull();
    expect(store.intents[0].attempts).toBe(1);
  });
});
