import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * H2 REGRESSION — the settlement audit actor must identify the TRUE trigger.
 *
 * Every settlement audit entry used to be stamped `SYSTEM_WEBHOOK`, regardless
 * of what actually caused it. Observed live during the Phase 20 audit: a
 * settlement invoked directly from a script was recorded as
 *   { who: "SYSTEM_WEBHOOK", what: "Transition RECONCILING -> COMPLETED" }
 * which is exactly the evidence a provider certification relies on, asserting
 * the reassuring answer rather than the true one.
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

import { settlePayment, settlementActor, type SettlementTrigger } from "../settlement";

const LINK = "plink_TRIGGER";

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
  world.invoices.push({ id: "inv-1", amount: 1000, status: "OVERDUE", businessId: "biz-A" });
  world.actions.push({
    id: "action-1", strategyId: "strategy-1", actionType: "PRIORITIZE_COLLECTIONS",
    status: "EXECUTING", auditLog: [], result: result(),
  });
  world.intents.push({
    id: "intent-1", actionId: "action-1", idempotencyKey: "cp_key_1",
    externalRef: LINK, targetType: "INVOICE", targetId: "inv-1", status: "SUCCEEDED",
  });
}

/** The audit entry settlement appended to the action. */
const lastAudit = () => {
  const a = world.actions.find((x) => x.id === "action-1");
  return a.auditLog[a.auditLog.length - 1];
};

beforeEach(() => seed());

describe("settlementActor maps each trigger to a distinct actor", () => {
  it("only WEBHOOK yields SYSTEM_WEBHOOK", () => {
    expect(settlementActor("WEBHOOK")).toBe("SYSTEM_WEBHOOK");

    const others: SettlementTrigger[] = ["POLL", "RECONCILIATION", "MANUAL"];
    for (const t of others) expect(settlementActor(t)).not.toBe("SYSTEM_WEBHOOK");
  });

  it("gives every trigger its own actor, with no collisions", () => {
    const all: SettlementTrigger[] = ["WEBHOOK", "POLL", "RECONCILIATION", "MANUAL"];
    const actors = all.map(settlementActor);
    expect(new Set(actors).size).toBe(all.length);
  });
});

describe("the recorded actor reflects the real trigger", () => {
  it("a webhook-triggered settlement is recorded as WEBHOOK", async () => {
    await settlePayment(LINK, "biz-A", undefined, undefined, "WEBHOOK");
    expect(lastAudit().who).toBe("SYSTEM_WEBHOOK");
    expect(lastAudit().trigger).toBe("WEBHOOK");
  });

  it("a poll-triggered settlement is NOT labelled WEBHOOK", async () => {
    await settlePayment(LINK, "biz-A", undefined, undefined, "POLL");
    expect(lastAudit().who).toBe("SYSTEM_POLL");
    expect(lastAudit().who).not.toBe("SYSTEM_WEBHOOK");
    expect(lastAudit().trigger).toBe("POLL");
  });

  it("a reconciliation-triggered settlement is NOT labelled WEBHOOK", async () => {
    await settlePayment(LINK, "biz-A", undefined, undefined, "RECONCILIATION");
    expect(lastAudit().who).toBe("SYSTEM_RECONCILIATION");
    expect(lastAudit().who).not.toBe("SYSTEM_WEBHOOK");
    expect(lastAudit().trigger).toBe("RECONCILIATION");
  });

  it("an explicit manual settlement is NOT labelled WEBHOOK", async () => {
    await settlePayment(LINK, "biz-A", undefined, undefined, "MANUAL");
    expect(lastAudit().who).toBe("MANUAL_SETTLEMENT");
    expect(lastAudit().who).not.toBe("SYSTEM_WEBHOOK");
  });

  it("THE DEFECT: a bare settlePayment() call cannot produce SYSTEM_WEBHOOK", async () => {
    // Exactly the call the Phase 20 audit made from a script. It was recorded
    // as SYSTEM_WEBHOOK, making a manual settlement indistinguishable from
    // provider-attested settlement.
    await settlePayment(LINK, "biz-A");

    expect(lastAudit().who).not.toBe("SYSTEM_WEBHOOK");
    expect(lastAudit().who).toBe("MANUAL_SETTLEMENT");
    expect(lastAudit().trigger).toBe("MANUAL");
  });

  it("the default is inert: omitting the trigger never claims provider attestation", async () => {
    // Belt and braces - assert over the whole audit trail, not just the last
    // entry, so no settlement path can slip a SYSTEM_WEBHOOK in elsewhere.
    await settlePayment(LINK, "biz-A");
    const a = world.actions.find((x) => x.id === "action-1");
    const actors = (a.auditLog as any[]).map((e) => e.who);
    expect(actors).not.toContain("SYSTEM_WEBHOOK");
  });
});
