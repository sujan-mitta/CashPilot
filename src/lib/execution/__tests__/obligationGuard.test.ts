import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  recordExecutionIntent,
  buildObligationKey,
  buildIdempotencyKey,
  resolveIntentFailed,
  claimExecutionIntent,
  sweepAbandonedIntents,
  OBLIGATION_CLAIMING_STATES,
} from "../executionIntent";
import { executeWithDurableIntent } from "../executor";
import { makeExecutionIntentFake } from "../../engine/__tests__/helpers/prismaFakes";
import { ExecutionOperation } from "../../../../generated/prisma/client";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/**
 * HIGH-severity defect regression suite.
 *
 * The defect: idempotency identity was bound to the ACTION. A regenerated
 * strategy mints a new actionId, therefore a new idempotency key, therefore a
 * second provider execution for the SAME underlying obligation - even while the
 * first attempt's provider outcome was still unknown.
 *
 * Every test below fixes the obligation (the invoice) and varies the action, so
 * it exercises exactly the path the old code allowed.
 */

const store = { intents: [] as any[] };
const client: any = { executionIntent: makeExecutionIntentFake(store) };

const INVOICE = "cminvoice0000000000000001";

/** Attempt N against the SAME invoice, from a DIFFERENT action. */
const attempt = (actionId: string) => ({
  businessId: "biz-A",
  strategyId: `strat-${actionId}`,
  actionId,
  operation: ExecutionOperation.CREATE_PAYMENT_LINK,
  amount: 4400000,
  targetType: "INVOICE",
  targetId: INVOICE,
});

beforeEach(() => {
  store.intents.length = 0;
});

// ===========================================================================
describe("Obligation identity", () => {
  it("is derived from the target, not the action", () => {
    // Two different actions, same invoice -> same obligation.
    expect(buildObligationKey("INVOICE", INVOICE)).toBe(`INVOICE:${INVOICE}`);
    // Setup assertion: the idempotency keys genuinely DO differ, which is why
    // an action-scoped guard failed.
    expect(buildIdempotencyKey("action-1", INVOICE)).not.toBe(
      buildIdempotencyKey("action-2", INVOICE)
    );
  });

  it("is null when there is no identifiable target", () => {
    expect(buildObligationKey(null, INVOICE)).toBeNull();
    expect(buildObligationKey("INVOICE", null)).toBeNull();
  });

  it("treats UNKNOWN as a state that still claims the obligation", () => {
    expect(OBLIGATION_CLAIMING_STATES).toContain("UNKNOWN");
    expect(OBLIGATION_CLAIMING_STATES).toContain("DISPATCHING");
    expect(OBLIGATION_CLAIMING_STATES).toContain("RECORDED");
    expect(OBLIGATION_CLAIMING_STATES).toContain("SUCCEEDED");
    // A reconciliation-proven failure is the ONLY state that releases it.
    expect(OBLIGATION_CLAIMING_STATES).not.toContain("FAILED");
  });
});

// ===========================================================================
describe("SCENARIO 1/2 - UNKNOWN attempt blocks a regenerated strategy", () => {
  it("THE DEFECT: a new action cannot create a second link while attempt #1 is UNKNOWN", async () => {
    let providerCalls = 0;
    const dispatch = async () => {
      providerCalls++;
      throw new Error("ETIMEDOUT");
    };

    // Attempt #1 - provider outcome genuinely unknown.
    const first = await executeWithDurableIntent(client, { ...attempt("action-1"), dispatch });
    expect(first.outcome).toBe("UNKNOWN");
    expect(providerCalls).toBe(1);
    expect(store.intents).toHaveLength(1);

    // Strategy regenerated -> brand new action id -> brand new idempotency key.
    const second = await executeWithDurableIntent(client, {
      ...attempt("action-2"),
      dispatch: async () => {
        providerCalls++;
        return { externalRef: "plink_SECOND" };
      },
    });

    // The provider must NOT have been contacted again.
    expect(second.outcome).toBe("BLOCKED_BY_PRIOR_ATTEMPT");
    expect(providerCalls).toBe(1);
    // And no second intent row exists to hang a second link off.
    expect(store.intents).toHaveLength(1);
    expect(second.blockingIntentId).toBe(store.intents[0].id);
    expect(second.obligationKey).toBe(`INVOICE:${INVOICE}`);
  });

  it("the refusal explains that a live link may already exist", async () => {
    await executeWithDurableIntent(client, {
      ...attempt("action-1"),
      dispatch: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    const second = await executeWithDurableIntent(client, {
      ...attempt("action-2"),
      dispatch: async () => ({ externalRef: "x" }),
    });
    expect(second.unknownReason).toMatch(/may already have created a live payment link/i);
  });

  it("repeated regeneration never wears the guard down", async () => {
    await executeWithDurableIntent(client, {
      ...attempt("action-1"),
      dispatch: async () => {
        throw new Error("ETIMEDOUT");
      },
    });

    let providerCalls = 0;
    for (const id of ["action-2", "action-3", "action-4", "action-5"]) {
      const r = await executeWithDurableIntent(client, {
        ...attempt(id),
        dispatch: async () => {
          providerCalls++;
          return { externalRef: "plink_X" };
        },
      });
      expect(r.outcome).toBe("BLOCKED_BY_PRIOR_ATTEMPT");
    }
    expect(providerCalls).toBe(0);
    expect(store.intents).toHaveLength(1);
  });
});

// ===========================================================================
describe("SCENARIO 6/7/8 - other unresolved states also hold the claim", () => {
  it("a DISPATCHING attempt (process died mid-call) blocks a new action", async () => {
    const { intent } = await recordExecutionIntent(client, attempt("action-1"));
    await claimExecutionIntent(client, intent.id);
    expect(store.intents[0].status).toBe("DISPATCHING");

    let calls = 0;
    const r = await executeWithDurableIntent(client, {
      ...attempt("action-2"),
      dispatch: async () => {
        calls++;
        return { externalRef: "x" };
      },
    });
    expect(r.outcome).toBe("BLOCKED_BY_PRIOR_ATTEMPT");
    expect(calls).toBe(0);
  });

  it("a swept (crashed) attempt still blocks, because sweeping yields UNKNOWN", async () => {
    const { intent } = await recordExecutionIntent(client, attempt("action-1"));
    await claimExecutionIntent(client, intent.id);
    await sweepAbandonedIntents(client, new Date(Date.now() + 10 * 60 * 1000), 60 * 1000);
    expect(store.intents[0].status).toBe("UNKNOWN");

    let calls = 0;
    const r = await executeWithDurableIntent(client, {
      ...attempt("action-2"),
      dispatch: async () => {
        calls++;
        return { externalRef: "x" };
      },
    });
    expect(r.outcome).toBe("BLOCKED_BY_PRIOR_ATTEMPT");
    expect(calls).toBe(0);
  });

  it("a SUCCEEDED attempt blocks a second execution for the same obligation", async () => {
    await executeWithDurableIntent(client, {
      ...attempt("action-1"),
      dispatch: async () => ({ externalRef: "plink_FIRST" }),
    });
    expect(store.intents[0].status).toBe("SUCCEEDED");

    let calls = 0;
    const r = await executeWithDurableIntent(client, {
      ...attempt("action-2"),
      dispatch: async () => {
        calls++;
        return { externalRef: "plink_SECOND" };
      },
    });
    expect(r.outcome).toBe("BLOCKED_BY_PRIOR_ATTEMPT");
    expect(calls).toBe(0);
  });
});

// ===========================================================================
describe("The guard releases ONLY on proven failure", () => {
  it("a reconciliation-proven FAILED attempt allows a fresh execution", async () => {
    const { intent } = await recordExecutionIntent(client, attempt("action-1"));
    // Only reconciliation reaches FAILED, and only with positive evidence.
    await resolveIntentFailed(client, intent.id, "Exhaustive scan proved absence");
    expect(store.intents[0].status).toBe("FAILED");

    let calls = 0;
    const r = await executeWithDurableIntent(client, {
      ...attempt("action-2"),
      dispatch: async () => {
        calls++;
        return { externalRef: "plink_SECOND" };
      },
    });

    // This is the intended escape hatch: absence was proven, so a retry is safe.
    expect(r.outcome).toBe("SUCCEEDED");
    expect(calls).toBe(1);
    // Both attempts survive in history - the first is not overwritten.
    expect(store.intents).toHaveLength(2);
  });

  it("history is never rewritten when a new attempt is admitted", async () => {
    const { intent } = await recordExecutionIntent(client, attempt("action-1"));
    await resolveIntentFailed(client, intent.id, "proven absent");
    const firstKey = store.intents[0].idempotencyKey;
    const firstId = store.intents[0].id;

    await executeWithDurableIntent(client, {
      ...attempt("action-2"),
      dispatch: async () => ({ externalRef: "plink_SECOND" }),
    });

    const original = store.intents.find((i) => i.id === firstId);
    expect(original.idempotencyKey).toBe(firstKey);
    expect(original.status).toBe("FAILED");
  });
});

// ===========================================================================
describe("SCENARIO 5 - concurrency", () => {
  it("concurrent regenerated attempts cannot both be admitted", async () => {
    await executeWithDurableIntent(client, {
      ...attempt("action-1"),
      dispatch: async () => {
        throw new Error("ETIMEDOUT");
      },
    });

    let calls = 0;
    const mk = (id: string) =>
      executeWithDurableIntent(client, {
        ...attempt(id),
        dispatch: async () => {
          calls++;
          return { externalRef: `plink_${id}` };
        },
      });

    const results = await Promise.all([mk("action-2"), mk("action-3")]);
    expect(results.every((r) => r.outcome === "BLOCKED_BY_PRIOR_ATTEMPT")).toBe(true);
    expect(calls).toBe(0);
  });
});

// ===========================================================================
describe("The guard does not over-block", () => {
  it("a DIFFERENT obligation is unaffected", async () => {
    await executeWithDurableIntent(client, {
      ...attempt("action-1"),
      dispatch: async () => {
        throw new Error("ETIMEDOUT");
      },
    });

    let calls = 0;
    const other = await executeWithDurableIntent(client, {
      ...attempt("action-2"),
      targetId: "cminvoice0000000000000002", // different invoice
      dispatch: async () => {
        calls++;
        return { externalRef: "plink_OTHER" };
      },
    });

    expect(other.outcome).toBe("SUCCEEDED");
    expect(calls).toBe(1);
  });

  it("a retry of the SAME action re-attaches rather than being blocked", async () => {
    await executeWithDurableIntent(client, {
      ...attempt("action-1"),
      dispatch: async () => ({ externalRef: "plink_FIRST" }),
    });

    const again = await executeWithDurableIntent(client, {
      ...attempt("action-1"),
      dispatch: async () => ({ externalRef: "plink_DUPLICATE" }),
    });

    // Same idempotency key -> the existing intent, not a block and not a dup.
    expect(again.outcome).toBe("ALREADY_SUCCEEDED");
    expect(again.externalRef).toBe("plink_FIRST");
    expect(store.intents).toHaveLength(1);
  });

  it("an obligation with no identifiable target keeps per-action behaviour", async () => {
    let calls = 0;
    const noTarget = {
      businessId: "biz-A",
      strategyId: "s",
      actionId: "action-1",
      operation: ExecutionOperation.PAUSE_EXPENSE,
      amount: 100,
      dispatch: async () => {
        calls++;
        return { externalRef: "x" };
      },
    };
    const r = await executeWithDurableIntent(client, noTarget as any);
    expect(r.outcome).toBe("SUCCEEDED");
    expect(calls).toBe(1);
    expect(store.intents[0].obligationKey).toBeNull();
  });
});
