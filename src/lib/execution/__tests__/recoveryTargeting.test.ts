import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WHICH DEBT DOES RECOVERY ACTUALLY RECOVER?
 *
 * executeRecoverFailedPayments ignored `action.targetTransactionId` entirely.
 * It took whichever RECOVERY_CANDIDATE an UNORDERED findFirst returned, then
 * issued a payment link for `ctx.action.amount` - the SIMULATED figure.
 *
 * With more than one failed payment on the ledger that means:
 *   - the debt the operator approved and the debt the system chased could be
 *     different rows, and
 *   - the link asked the customer for the wrong sum, which settlement then
 *     flagged as a RECONCILIATION_MISMATCH the system had caused itself.
 */

const world = vi.hoisted(() => ({
  recoveries: [] as any[],
  linkCalls: [] as { amount: number; description: string }[],
  lastQuery: null as any,
}));

vi.mock("../../razorpay/client", () => ({
  createRecoveryPaymentLink: vi.fn(async (amount: number, description: string, key?: string) => {
    world.linkCalls.push({ amount, description });
    return { id: `plink_${key ?? "x"}`, short_url: "/sandbox/checkout", status: "created" };
  }),
}));

vi.mock("../executor", () => ({
  executeWithDurableIntent: vi.fn(async (_client: any, opts: any) => {
    const res = await opts.dispatch("idem_key_1");
    return {
      outcome: "SUCCEEDED",
      intentId: "intent_1",
      externalRef: res.externalRef,
      externalStatus: res.externalStatus,
    };
  }),
}));

import { executeRecoverFailedPayments } from "../actionExecutors";

function makeClient() {
  return {
    paymentRecovery: {
      findFirst: vi.fn(async (query: any) => {
        world.lastQuery = query;
        const wanted: string[] = query.where.status.in;
        let candidates = world.recoveries.filter((r) => wanted.includes(r.status));
        if (query.where.transactionId) {
          candidates = candidates.filter((r) => r.transactionId === query.where.transactionId);
        }
        if (query.orderBy) {
          candidates = [...candidates].sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id));
        }
        return candidates[0] ?? null;
      }),
      update: vi.fn(async () => ({})),
    },
  } as any;
}

const action = (overrides: Record<string, unknown> = {}) => ({
  id: "act-1",
  amount: 999_999_999, // deliberately NOT any recovery's amount
  actionType: "RECOVER_FAILED_PAYMENTS",
  targetTransactionId: null,
  targetPayoutId: null,
  ...overrides,
});

beforeEach(() => {
  world.linkCalls = [];
  world.lastQuery = null;
  world.recoveries = [
    { id: "rec-small", transactionId: "tx-small", amount: 100_000, status: "RECOVERY_CANDIDATE", transaction: { description: "Order #1" } },
    { id: "rec-big", transactionId: "tx-big", amount: 900_000, status: "RECOVERY_CANDIDATE", transaction: { description: "Order #2" } },
  ];
});

describe("executeRecoverFailedPayments — targeting", () => {
  it("THE BUG: recovers the debt the ACTION was approved against", async () => {
    const client = makeClient();
    await executeRecoverFailedPayments(client, {
      businessId: "biz-1",
      strategyId: "strat-1",
      action: action({ targetTransactionId: "tx-small" }) as any,
    });
    // Not "whichever row came back first".
    expect(world.lastQuery.where.transactionId).toBe("tx-small");
    expect(client.paymentRecovery.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rec-small" } })
    );
  });

  it("THE BUG: issues the link for the RECOVERY's amount, not the simulated action amount", async () => {
    const client = makeClient();
    await executeRecoverFailedPayments(client, {
      businessId: "biz-1",
      strategyId: "strat-1",
      action: action({ targetTransactionId: "tx-small" }) as any,
    });
    // 999_999_999 was the action's figure. Asking the customer for it would be
    // wrong, and settlement would then flag OUR error as their mismatch.
    expect(world.linkCalls).toEqual([{ amount: 100_000, description: "Order #1" }]);
  });

  it("stays tenant-scoped even when targeting", async () => {
    const client = makeClient();
    await executeRecoverFailedPayments(client, {
      businessId: "biz-1",
      strategyId: "strat-1",
      action: action({ targetTransactionId: "tx-small" }) as any,
    });
    expect(world.lastQuery.where.transaction).toEqual({ businessId: "biz-1" });
  });

  it("falls back DETERMINISTICALLY (largest first) when the action carries no target", async () => {
    // The old unordered findFirst made the outcome depend on row order, which
    // is not something the decision fingerprint can account for.
    const client = makeClient();
    await executeRecoverFailedPayments(client, {
      businessId: "biz-1",
      strategyId: "strat-1",
      action: action() as any,
    });
    expect(world.lastQuery.orderBy).toEqual([{ amount: "desc" }, { id: "asc" }]);
    expect(world.linkCalls[0].amount).toBe(900_000);
  });

  it("produces the SAME result on repeated runs with the same ledger", async () => {
    const amounts: number[] = [];
    for (let i = 0; i < 3; i++) {
      world.linkCalls = [];
      // Row order shuffled between runs, as a database is free to do.
      world.recoveries.reverse();
      await executeRecoverFailedPayments(makeClient(), {
        businessId: "biz-1",
        strategyId: "strat-1",
        action: action() as any,
      });
      amounts.push(world.linkCalls[0].amount);
    }
    expect(new Set(amounts).size).toBe(1);
  });

  it("falls back to the deterministic pick when the TARGET has no recoverable row", async () => {
    const client = makeClient();
    await executeRecoverFailedPayments(client, {
      businessId: "biz-1",
      strategyId: "strat-1",
      action: action({ targetTransactionId: "tx-does-not-exist" }) as any,
    });
    // The debt is real even if this particular action's target has gone; the
    // run must not simply fail.
    expect(world.linkCalls[0].amount).toBe(900_000);
  });

  it("prefers a FRESH candidate over re-attempting a dead one", async () => {
    world.recoveries = [
      { id: "rec-dead", transactionId: "tx-1", amount: 900_000, status: "EXPIRED", transaction: { description: "old" } },
      { id: "rec-fresh", transactionId: "tx-2", amount: 100_000, status: "RECOVERY_CANDIDATE", transaction: { description: "new" } },
    ];
    const client = makeClient();
    await executeRecoverFailedPayments(client, {
      businessId: "biz-1",
      strategyId: "strat-1",
      action: action() as any,
    });
    expect(world.linkCalls[0].description).toBe("new");
  });

  it("re-attempts an EXPIRED or FAILED recovery when no fresh candidate exists", async () => {
    world.recoveries = [
      { id: "rec-dead", transactionId: "tx-1", amount: 900_000, status: "EXPIRED", transaction: { description: "old" } },
    ];
    const client = makeClient();
    const out = await executeRecoverFailedPayments(client, {
      businessId: "biz-1",
      strategyId: "strat-1",
      action: action() as any,
    });
    // The debt is real and the link is dead; something must be able to issue a
    // replacement.
    expect(out.status).toBe("EXECUTING");
    expect(world.linkCalls[0].amount).toBe(900_000);
  });
});
