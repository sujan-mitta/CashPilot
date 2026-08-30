import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE SWALLOWED SETTLEMENT FAILURE
 *
 * The collections branch of settlePayment() wrapped its ENTIRE body - including
 * the write transaction - in one try, whose catch logged "Error parsing invoice
 * links in settle" and fell through to `return "created"`.
 *
 * So a database error, a lost concurrency race, or any throw inside the
 * transaction was reported to the caller as a successful no-op. The webhook
 * route then called markSucceeded() and answered HTTP 200; Razorpay saw success
 * and never retried. A customer's payment was credited to nobody, and nothing
 * anywhere was flagged.
 *
 * "created" now means exactly one thing: this action does not describe the link
 * we were asked about. Everything else propagates.
 */

const world = vi.hoisted(() => ({
  action: null as any,
  invoice: null as any,
  transactionShouldThrow: null as Error | null,
  invoiceUpdateCount: 1,
  cashIncrements: [] as number[],
}));

vi.mock("@/lib/observability", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    executionIntent: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null), updateMany: vi.fn() },
    agentAction: {
      findFirst: vi.fn(async () => world.action),
      findUnique: vi.fn(async () => world.action),
      findMany: vi.fn(async () => (world.action ? [world.action] : [])),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    paymentRecovery: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    invoice: {
      findFirst: vi.fn(async () => world.invoice),
      findMany: vi.fn(async () => (world.invoice ? [world.invoice] : [])),
      updateMany: vi.fn(async () => ({ count: world.invoiceUpdateCount })),
    },
    business: { findUnique: vi.fn(async () => ({ id: "biz-1", currentCash: 0 })), update: vi.fn() },
    decision: { findFirst: vi.fn(async () => null) },
    decisionEvent: { create: vi.fn() },
    financialEvent: {
      create: vi.fn(async (args: any) => ({
        id: `fe_${Math.random().toString(36).slice(2, 10)}`,
        ...args.data,
      })),
      findUnique: vi.fn(async () => null),
    },
    $transaction: vi.fn(async (cb: any) => {
      if (world.transactionShouldThrow) throw world.transactionShouldThrow;
      return cb({
        financialEvent: {
          create: vi.fn(async (a: any) => ({ id: "fe_1", ...a.data })),
          findUnique: vi.fn(async () => null),
        },
        invoice: {
          findFirst: vi.fn(async () => world.invoice),
          updateMany: vi.fn(async () => ({ count: world.invoiceUpdateCount })),
        },
        executionIntent: { updateMany: vi.fn() },
        business: {
          update: vi.fn(async ({ data }: any) => {
            world.cashIncrements.push(data.currentCash.increment);
            return {};
          }),
          findUnique: vi.fn(async () => ({ id: "biz-1", currentCash: 0 })),
        },
        agentAction: {
          findUnique: vi.fn(async () => world.action),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
      });
    }),
  },
}));

import { settlePayment } from "../settlement";

const linksJson = (paymentLinkId: string, invoiceId: string) =>
  JSON.stringify({ message: "generated", links: [{ invoiceId, paymentLinkId, amount: 500000 }] });

beforeEach(() => {
  vi.clearAllMocks();
  world.transactionShouldThrow = null;
  world.invoiceUpdateCount = 1;
  world.cashIncrements = [];
  world.action = {
    id: "act-1",
    strategyId: "strat-1",
    actionType: "PRIORITIZE_COLLECTIONS",
    status: "EXECUTING",
    amount: 500000,
    auditLog: [],
    result: linksJson("plink_1", "inv-1"),
    strategy: { businessId: "biz-1" },
  };
  world.invoice = { id: "inv-1", businessId: "biz-1", status: "OVERDUE", amount: 500000 };
});

describe("settlePayment — a failure must never be reported as success", () => {
  it("THE BUG: a database failure inside the transaction PROPAGATES instead of returning \"created\"", async () => {
    world.transactionShouldThrow = new Error("connection terminated unexpectedly");

    // Before: this resolved to "created", the webhook answered 200, and the
    // provider never redelivered.
    await expect(settlePayment("plink_1", "biz-1", 500000, undefined, "WEBHOOK")).rejects.toThrow(
      "connection terminated unexpectedly"
    );
    expect(world.cashIncrements).toEqual([]);
  });

  it("a lost concurrency race PROPAGATES rather than reporting a no-op", async () => {
    // updateMany matching zero rows with the invoice still not PAID is a real
    // conflict; it must not look like "nothing to do".
    world.invoiceUpdateCount = 0;
    await expect(settlePayment("plink_1", "biz-1", 500000, undefined, "WEBHOOK")).rejects.toThrow();
  });

  it("an UNPARSEABLE result is still \"created\" — the one case that legitimately means \"not ours\"", async () => {
    world.action.result = "Razorpay link generated: plink_1";
    await expect(settlePayment("plink_1", "biz-1", 500000, undefined, "WEBHOOK")).resolves.toBe("created");
    expect(world.cashIncrements).toEqual([]);
  });

  it("a result whose links do not include this payment link is \"created\"", async () => {
    world.action.result = linksJson("plink_SOMETHING_ELSE", "inv-9");
    await expect(settlePayment("plink_1", "biz-1", 500000, undefined, "WEBHOOK")).resolves.toBe("created");
  });

  it("the happy path still settles and credits exactly once", async () => {
    await expect(settlePayment("plink_1", "biz-1", 500000, undefined, "WEBHOOK")).resolves.toBe("paid");
    expect(world.cashIncrements).toEqual([500000]);
  });
});

describe("settlePayment — the amount that reaches the balance", () => {
  it("credits the PROVIDER-REPORTED amount, not the expected one, on a partial payment", async () => {
    await settlePayment("plink_1", "biz-1", 120000, undefined, "WEBHOOK");
    expect(world.cashIncrements).toEqual([120000]);
  });

  it("credits ZERO when the provider says zero, rather than falling back to the invoice", async () => {
    await settlePayment("plink_1", "biz-1", 0, undefined, "WEBHOOK");
    expect(world.cashIncrements).toEqual([0]);
  });

  it("falls back to the expected amount only when NO provider figure was supplied", async () => {
    // The poll/manual path: we know what is owed, not what arrived.
    await settlePayment("plink_1", "biz-1", undefined, undefined, "POLL");
    expect(world.cashIncrements).toEqual([500000]);
  });

  it("REFUSES a negative amount instead of debiting a real balance", async () => {
    await expect(settlePayment("plink_1", "biz-1", -500000, undefined, "WEBHOOK")).rejects.toMatchObject({
      code: "UNSAFE_SETTLEMENT_AMOUNT",
    });
    expect(world.cashIncrements).toEqual([]);
  });

  it("REFUSES NaN, a fraction, and an absurd figure", async () => {
    for (const bad of [NaN, 100.5, Number.MAX_SAFE_INTEGER]) {
      world.cashIncrements = [];
      await expect(settlePayment("plink_1", "biz-1", bad, undefined, "WEBHOOK")).rejects.toMatchObject({
        code: "UNSAFE_SETTLEMENT_AMOUNT",
      });
      expect(world.cashIncrements).toEqual([]);
    }
  });

  it("an overpayment IS credited — the ledger records what actually arrived", async () => {
    await settlePayment("plink_1", "biz-1", 750000, undefined, "WEBHOOK");
    expect(world.cashIncrements).toEqual([750000]);
  });
});
