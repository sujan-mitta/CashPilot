import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * B-10 — settlement records WHEN the money arrived.
 *
 * Until this change an invoice flipped to PAID and the date was discarded,
 * which made "how late does this customer usually pay?" unanswerable from
 * stored data: the Phase 9 behaviour model had no possible input.
 *
 * These tests pin down the three properties that matter for a field the
 * forecast will eventually be shifted by:
 *   1. it is written when settlement genuinely moves an invoice to PAID
 *   2. it is WRITE-ONCE - a repeat settlement cannot overwrite it
 *   3. it is never written for an invoice that did not settle
 */

const world = {
  actions: [] as any[],
  invoices: [] as any[],
  intents: [] as any[],
  business: { id: "biz-A", currentCash: 100_000 },
};

vi.mock("@/lib/prisma", () => {
  const match = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (k === "strategy") return true;
      const actual = row?.[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if (Array.isArray(v.in)) return v.in.includes(actual);
        if ("not" in v) return actual !== v.not;
        if ("contains" in v) return typeof actual === "string" && actual.includes(v.contains);
        return true;
      }
      return actual === v;
    });

  return {
    prisma: {
      agentAction: {
        findMany: vi.fn(async ({ where }: any) => world.actions.filter((a) => match(a, where))),
        findFirst: vi.fn(async ({ where }: any) => world.actions.find((a) => match(a, where)) ?? null),
        findUnique: vi.fn(async ({ where }: any) => world.actions.find((a) => a.id === where.id) ?? null),
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const a of world.actions) {
            if (!match(a, where)) continue;
            Object.assign(a, data);
            count++;
          }
          return { count };
        }),
      },
      invoice: {
        findMany: vi.fn(async ({ where }: any) => world.invoices.filter((i) => match(i, where))),
        findFirst: vi.fn(async ({ where }: any) => world.invoices.find((i) => match(i, where)) ?? null),
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const i of world.invoices) {
            if (!match(i, where)) continue;
            Object.assign(i, data);
            count++;
          }
          return { count };
        }),
      },
      executionIntent: {
        findUnique: vi.fn(async ({ where }: any) =>
          world.intents.find((i) => i.idempotencyKey === where.idempotencyKey) ?? null
        ),
        findFirst: vi.fn(async ({ where }: any) => {
          const f = world.intents.find((i) => match(i, where));
          if (!f) return null;
          return { ...f, action: world.actions.find((a) => a.id === f.actionId) ?? null };
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      paymentRecovery: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
      business: {
        findUnique: vi.fn(async () => world.business),
        findFirst: vi.fn(async () => world.business),
        update: vi.fn(async ({ data }: any) => {
          if (data?.currentCash?.increment) world.business.currentCash += data.currentCash.increment;
          return world.business;
        }),
      },
      decision: { findFirst: vi.fn(async () => null) },
      decisionEvent: { create: vi.fn(async () => ({})) },
      financialEvent: {
        create: vi.fn(async (args: any) => ({
          id: `fe_${Math.random().toString(36).slice(2, 10)}`,
          ...args.data,
        })),
        findUnique: vi.fn(async () => null),
      },
      $transaction: vi.fn(async (fn: any) => {
        const mod = await import("@/lib/prisma");
        return typeof fn === "function" ? fn(mod.prisma) : fn;
      }),
    },
  };
});

import { settlePayment } from "../settlement";
import { computePaymentBehavior } from "@/lib/behavior/paymentBehavior";

const LINK = "plink_PAIDAT";

const result = () =>
  JSON.stringify({
    message: "Generated payment links for 1 of 1 overdue invoices.",
    links: [{ invoiceId: "inv-1", customerName: "Acme", paymentLinkId: LINK, shortUrl: "/x", amount: 1000 }],
  });

function seed() {
  world.actions.length = 0;
  world.invoices.length = 0;
  world.intents.length = 0;
  world.business.currentCash = 100_000;
  world.invoices.push({
    id: "inv-1",
    amount: 1000,
    status: "OVERDUE",
    businessId: "biz-A",
    dueDate: new Date("2026-09-05T00:00:00Z"),
    paidAt: null,
  });
  world.actions.push({
    id: "action-1",
    strategyId: "strategy-1",
    actionType: "PRIORITIZE_COLLECTIONS",
    status: "EXECUTING",
    auditLog: [],
    result: result(),
  });
  world.intents.push({
    id: "intent-1",
    actionId: "action-1",
    idempotencyKey: "cp_key_1",
    externalRef: LINK,
    targetType: "INVOICE",
    targetId: "inv-1",
    status: "SUCCEEDED",
  });
}

const invoice = () => world.invoices.find((i) => i.id === "inv-1");

beforeEach(() => seed());

describe("settlement records when the money arrived", () => {
  it("stamps paidAt when the invoice settles", async () => {
    const at = new Date("2026-09-11T10:30:00Z");
    await settlePayment(LINK, "biz-A", undefined, undefined, "WEBHOOK", at);

    expect(invoice().status).toBe("PAID");
    expect(invoice().paidAt).toStrictEqual(at);
  });

  it("defaults to observation time when no timestamp is supplied", async () => {
    const before = Date.now();
    await settlePayment(LINK, "biz-A", undefined, undefined, "WEBHOOK");
    const after = Date.now();

    const paidAt = invoice().paidAt as Date;
    expect(paidAt).toBeInstanceOf(Date);
    expect(paidAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(paidAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("records it for a manual settlement too", async () => {
    const at = new Date("2026-09-11T10:30:00Z");
    await settlePayment(LINK, "biz-A", undefined, undefined, "MANUAL", at);
    expect(invoice().paidAt).toStrictEqual(at);
  });
});

describe("paidAt is write-once", () => {
  it("a repeat settlement does not overwrite the original arrival time", async () => {
    const first = new Date("2026-09-11T10:30:00Z");
    const later = new Date("2026-09-20T10:30:00Z");

    await settlePayment(LINK, "biz-A", undefined, undefined, "WEBHOOK", first);
    await settlePayment(LINK, "biz-A", undefined, undefined, "WEBHOOK", later);

    // The compare-and-swap on status is what guarantees this: the second
    // settlement finds the invoice already PAID and never enters the update.
    expect(invoice().paidAt).toStrictEqual(first);
  });

  it("survives ten redeliveries of the same settlement", async () => {
    const first = new Date("2026-09-11T10:30:00Z");
    await settlePayment(LINK, "biz-A", undefined, undefined, "WEBHOOK", first);

    for (let i = 1; i <= 10; i++) {
      await settlePayment(
        LINK,
        "biz-A",
        undefined,
        undefined,
        "WEBHOOK",
        new Date(first.getTime() + i * 86400000)
      );
    }
    expect(invoice().paidAt).toStrictEqual(first);
    expect(invoice().status).toBe("PAID");
  });

  it("does not stamp an invoice that was already PAID before this settlement", async () => {
    invoice().status = "PAID";
    invoice().paidAt = null;

    await settlePayment(LINK, "biz-A", undefined, undefined, "WEBHOOK", new Date());

    // Already-settled: the update is never entered, so nothing is invented for
    // an invoice whose real arrival time we do not know.
    expect(invoice().paidAt).toBeNull();
  });
});

describe("the data actually feeds the behaviour model", () => {
  it("a settled invoice yields a measurable delay", async () => {
    // The whole point of B-10: due Sep 5, paid Sep 11, so this customer is six
    // days late - a fact that was previously discarded at settlement.
    const paidOn = new Date("2026-09-11T00:00:00Z");
    await settlePayment(LINK, "biz-A", undefined, undefined, "WEBHOOK", paidOn);

    const settled = invoice();
    const behavior = computePaymentBehavior(
      // Five identical settlements is the minimum the model will act on.
      Array.from({ length: 5 }, (_, i) => ({
        id: `inv-${i}`,
        amount: settled.amount,
        dueDate: settled.dueDate,
        paidDate: settled.paidAt as Date,
      })),
      { now: new Date("2026-09-20T00:00:00Z") }
    );

    expect(behavior.sufficiency).toBe("SUFFICIENT");
    expect(behavior.averageDelayDays).toBe(6);
    expect(behavior.expectedDelayDays).toBe(6);
  });

  it("an unsettled invoice contributes nothing", async () => {
    // paidAt null is genuinely unknown, and the model must not guess.
    const behavior = computePaymentBehavior([], { now: new Date() });
    expect(behavior.sufficiency).toBe("INSUFFICIENT");
    expect(behavior.expectedDelayDays).toBeNull();
  });
});
