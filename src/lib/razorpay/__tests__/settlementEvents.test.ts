import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Settlement must append to the canonical financial-event spine.
 *
 * The spine is the append-only record of what actually happened to the
 * company's money. Until now nothing wrote to it, so every downstream consumer
 * — reconciliation, materialised state, the evidence trail — had nothing to
 * read. Settlement is the right first writer because it is the moment money
 * genuinely arrives.
 *
 * Three properties matter here, and none of them is "an event was created":
 *
 *  1. The event is written on the SAME transaction client as the ledger
 *     movement, so the log cannot survive a rolled-back credit.
 *  2. Its identity is granular per settled obligation, so one payment link
 *     covering several invoices produces one event per invoice — and a repeat
 *     settlement of the same obligation reproduces the same key.
 *  3. It records what was settled and how far its timestamp can be trusted,
 *     and carries no signature, header or credential.
 */

const { world, financialEvent } = vi.hoisted(() => {
  const world: {
    invoice: Record<string, unknown> | null;
    invoiceUpdateCount: number;
    recovery: Record<string, unknown> | null;
    action: Record<string, unknown> | null;
    cashIncrements: number[];
    events: { data: Record<string, unknown> }[];
    invoiceUpdates: Record<string, unknown>[];
    transactionShouldThrow: Error | null;
  } = {
    invoice: null,
    invoiceUpdateCount: 1,
    recovery: null,
    action: null,
    cashIncrements: [],
    events: [],
    invoiceUpdates: [],
    transactionShouldThrow: null,
  };

  /** The one delegate under test, shared by the outer client and the tx client. */
  const financialEvent = {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      world.events.push({ data: args.data });
      return { id: `fe_${world.events.length}`, ...args.data };
    }),
    findUnique: vi.fn(async () => null),
  };

  return { world, financialEvent };
});

vi.mock("@/lib/prisma", () => {
  /**
   * A Prisma delegate whose unlisted methods return harmless defaults.
   *
   * Settlement touches a wide surface, and hand-listing every method it happens
   * to call makes the test fail for reasons unrelated to what it asserts. The
   * overrides carry the behaviour under test; the Proxy absorbs the rest.
   */
  const delegate = (overrides: Record<string, unknown> = {}) =>
    new Proxy(overrides, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        if (prop === "create") return vi.fn(async (a: { data: unknown }) => a.data);
        if (prop === "updateMany" || prop === "deleteMany") return vi.fn(async () => ({ count: 1 }));
        if (prop === "findMany") return vi.fn(async () => []);
        // findFirst / findUnique / update / upsert / delete / count …
        return vi.fn(async () => null);
      },
    });

  const txClient = () => ({
    financialEvent,
    invoice: delegate({
      findFirst: vi.fn(async () => world.invoice),
      updateMany: vi.fn(async (a: { data: Record<string, unknown> }) => {
        world.invoiceUpdates.push(a.data);
        return { count: world.invoiceUpdateCount };
      }),
    }),
    paymentRecovery: delegate({
      findUnique: vi.fn(async () => world.recovery),
      findFirst: vi.fn(async () => world.recovery),
      updateMany: vi.fn(async () => ({ count: 1 })),
    }),
    business: delegate({
      findUnique: vi.fn(async () => ({ id: "biz-1", currentCash: 0 })),
      update: vi.fn(async ({ data }: { data: { currentCash: { increment: number } } }) => {
        world.cashIncrements.push(data.currentCash.increment);
        return {};
      }),
    }),
    agentAction: delegate({
      findUnique: vi.fn(async () => world.action),
      findFirst: vi.fn(async () => world.action),
      updateMany: vi.fn(async () => ({ count: 1 })),
    }),
    executionIntent: delegate(),
    decision: delegate(),
    decisionEvent: delegate(),
  });

  return {
    prisma: {
      financialEvent,
      invoice: delegate({ findFirst: vi.fn(async () => world.invoice) }),
      paymentRecovery: delegate({
        findUnique: vi.fn(async () => world.recovery),
        findFirst: vi.fn(async () => world.recovery),
      }),
      agentAction: delegate({
        findUnique: vi.fn(async () => world.action),
        findFirst: vi.fn(async () => world.action),
      }),
      business: delegate({ findUnique: vi.fn(async () => ({ id: "biz-1", currentCash: 0 })) }),
      executionIntent: delegate(),
      decision: delegate(),
      decisionEvent: delegate(),
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        if (world.transactionShouldThrow) throw world.transactionShouldThrow;
        return cb(txClient());
      }),
    },
  };
});

import { settlePayment } from "../settlement";

const LINK = "plink_EVT";
const linksJson = (invoiceId: string) =>
  JSON.stringify({ message: "generated", links: [{ invoiceId, paymentLinkId: LINK, amount: 500000 }] });

beforeEach(() => {
  vi.clearAllMocks();
  world.events = [];
  world.invoiceUpdates = [];
  world.cashIncrements = [];
  world.transactionShouldThrow = null;
  world.invoiceUpdateCount = 1;
  world.recovery = null;
  world.invoice = {
    id: "inv-1",
    businessId: "biz-1",
    amount: 500000,
    status: "PENDING",
    customerName: "Sharma Traders",
  };
  world.action = {
    id: "act-1",
    strategyId: "strat-1",
    actionType: "PRIORITIZE_COLLECTIONS",
    status: "EXECUTING",
    amount: 500000,
    auditLog: [],
    result: linksJson("inv-1"),
    strategy: { businessId: "biz-1" },
  };
});

describe("Settlement writes the financial-event spine", () => {
  it("records INVOICE_PAID when an invoice settles", async () => {
    await settlePayment(LINK, "biz-1", 500000, undefined, "WEBHOOK");

    expect(world.events).toHaveLength(1);
    const e = world.events[0].data;
    expect(e.eventType).toBe("INVOICE_PAID");
    expect(e.sourceType).toBe("RAZORPAY");
    expect(e.businessId).toBe("biz-1");
    expect(e.amount).toBe(500000);
  });

  it("keys the event per settled obligation, not per payment link", async () => {
    await settlePayment(LINK, "biz-1", 500000, undefined, "WEBHOOK");

    // One link can cover several invoices, so the link alone is not unique per
    // financial fact. Including the target makes the key exactly as granular as
    // the money movement.
    expect(world.events[0].data.sourceRecordId).toBe(`${LINK}:INVOICE:inv-1`);
  });

  it("credits the ledger and appends the event on the same client", async () => {
    await settlePayment(LINK, "biz-1", 500000, undefined, "WEBHOOK");

    // Both happened; neither can outlive the other, because both ran inside the
    // one transaction the mock exposes.
    expect(world.cashIncrements).toEqual([500000]);
    expect(world.events).toHaveLength(1);
  });

  it("writes no event when the transaction fails", async () => {
    world.transactionShouldThrow = new Error("deadlock detected");

    await expect(settlePayment(LINK, "biz-1", 500000, undefined, "WEBHOOK")).rejects.toThrow();

    // A credit that never landed must not leave an event claiming it did.
    expect(world.cashIncrements).toEqual([]);
    expect(world.events).toHaveLength(0);
  });

  it("records the amount that actually arrived, not the amount expected", async () => {
    // A partial payment: the spine must agree with the ledger, and the ledger
    // records what the provider reported.
    await settlePayment(LINK, "biz-1", 300000, undefined, "WEBHOOK");

    expect(world.cashIncrements).toEqual([300000]);
    expect(world.events[0].data.amount).toBe(300000);
    const nd = world.events[0].data.normalizedData as Record<string, unknown>;
    expect(nd.expectedAmount).toBe(500000);
    expect(nd.settledAmount).toBe(300000);
  });

  it("marks a webhook timestamp as provider-reported and a manual one as observed", async () => {
    await settlePayment(LINK, "biz-1", 500000, undefined, "WEBHOOK");
    const webhookMeta = world.events[0].data.normalizedData as Record<string, unknown>;
    expect(webhookMeta.settlementTrigger).toBe("WEBHOOK");
    expect(webhookMeta.timestampMeaning).toBe("PROVIDER_REPORTED");

    // A manual settlement is an operator observation that may be days after the
    // money moved. The spine must not present it as provider-attested.
    world.events = [];
    world.invoice = { ...(world.invoice as object), status: "PENDING" } as Record<string, unknown>;
    await settlePayment(LINK, "biz-1", 500000, undefined, "MANUAL");
    const manualMeta = world.events[0].data.normalizedData as Record<string, unknown>;
    expect(manualMeta.settlementTrigger).toBe("MANUAL");
    expect(manualMeta.timestampMeaning).toBe("OBSERVED");
  });

  it("carries no signature, header or credential in the payload", async () => {
    await settlePayment(LINK, "biz-1", 500000, undefined, "WEBHOOK");

    const serialised = JSON.stringify(world.events[0].data).toLowerCase();
    for (const forbidden of ["signature", "x-razorpay", "secret", "authorization", "key_id", "rzp_"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("records PAYMENT_RECEIVED when a recovery settles", async () => {
    world.invoice = null;
    world.action = {
      id: "act-2",
      strategyId: "strat-1",
      actionType: "RECOVER_FAILED_PAYMENTS",
      status: "EXECUTING",
      amount: 440000,
      auditLog: [],
      result: "Recovery link generated: " + LINK,
      strategy: { businessId: "biz-1" },
    };
    world.recovery = {
      id: "rec-1",
      businessId: "biz-1",
      amount: 440000,
      // The state a recovery is actually in while its link is out awaiting
      // payment. "PENDING" is not a member of RecoveryStatus at all.
      status: "PAYMENT_LINK_CREATED",
      razorpayLinkId: LINK,
    };

    await settlePayment(LINK, "biz-1", 440000, undefined, "WEBHOOK");

    const paymentEvents = world.events.filter((e) => e.data.eventType === "PAYMENT_RECEIVED");
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0].data.sourceRecordId).toBe(`${LINK}:PAYMENT_RECOVERY:rec-1`);
    expect(paymentEvents[0].data.amount).toBe(440000);
  });
});

describe("Partially paid invoices", () => {
  it("marks the invoice PARTIALLY_PAID when the receipt does not close it", async () => {
    // ₹5,00,000 invoice, ₹3,00,000 received. Previously ANY settlement flipped
    // the invoice to PAID, which removed the remaining ₹2,00,000 from the
    // forecast entirely.
    await settlePayment(LINK, "biz-1", 300000, undefined, "WEBHOOK");

    expect(world.invoiceUpdates).toHaveLength(1);
    expect(world.invoiceUpdates[0].status).toBe("PARTIALLY_PAID");
  });

  it("marks it PAID when the receipt closes it exactly", async () => {
    await settlePayment(LINK, "biz-1", 500000, undefined, "WEBHOOK");
    expect(world.invoiceUpdates[0].status).toBe("PAID");
  });

  it("marks it PAID on an overpayment — the invoice is satisfied", async () => {
    await settlePayment(LINK, "biz-1", 650000, undefined, "WEBHOOK");
    expect(world.invoiceUpdates[0].status).toBe("PAID");
  });

  it("increments paidAmount rather than assigning it, so parts accumulate", async () => {
    await settlePayment(LINK, "biz-1", 300000, undefined, "WEBHOOK");

    // An assignment would make a second ₹2,00,000 receipt read as ₹2,00,000
    // total received instead of ₹5,00,000, leaving the invoice permanently
    // short of closing.
    expect(world.invoiceUpdates[0].paidAmount).toEqual({ increment: 300000 });
  });

  it("credits the ledger with the amount received, not the invoice face value", async () => {
    await settlePayment(LINK, "biz-1", 300000, undefined, "WEBHOOK");
    expect(world.cashIncrements).toEqual([300000]);
  });

  it("does not stamp paidAt on a part payment", async () => {
    // paidAt means "when this invoice was settled". A part payment has not
    // settled it, and writing a date would tell the behaviour model the
    // customer paid in full on that day.
    await settlePayment(LINK, "biz-1", 300000, undefined, "WEBHOOK");
    expect(world.invoiceUpdates[0].paidAt).toBeUndefined();
  });

  it("stamps paidAt only when the invoice actually closes", async () => {
    await settlePayment(LINK, "biz-1", 500000, undefined, "WEBHOOK");
    expect(world.invoiceUpdates[0].paidAt).toBeInstanceOf(Date);
  });

  it("closes an already part-paid invoice with the remainder", async () => {
    // ₹5,00,000 invoice with ₹2,00,000 already confirmed; ₹3,00,000 arrives.
    world.invoice = { ...(world.invoice as object), paidAmount: 200000 } as Record<string, unknown>;

    await settlePayment(LINK, "biz-1", 300000, undefined, "WEBHOOK");

    expect(world.invoiceUpdates[0].status).toBe("PAID");
    expect(world.invoiceUpdates[0].paidAmount).toEqual({ increment: 300000 });
  });
});
