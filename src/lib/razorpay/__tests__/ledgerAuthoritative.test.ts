import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * REGRESSION: settled money was rolled back because an ACTION could not advance.
 *
 * A recovery whose intent SUCCEEDED but whose action was still APPROVED could
 * not legally reach RECONCILING (ALLOWED_TRANSITIONS[APPROVED] omits it). The
 * guarded update then matched nothing, the "concurrently modified" branch threw,
 * and the throw escaped the enclosing $transaction - rolling back the recovery
 * status AND the cash credit. Money that genuinely arrived at the provider left
 * no trace in the ledger at all.
 *
 * Verified live against paid link plink_TTgfL5SJE2a4n7, whose action was
 * APPROVED: settlement threw "Action concurrently modified" and credited zero.
 *
 * The ledger is authoritative. A status transition the state machine refuses is
 * a reason to RECORD a divergence, never to un-settle real money - the same rule
 * reconcileDecisionForStrategy already applies to the Decision machine.
 */

const world = {
  actions: [] as any[],
  recoveries: [] as any[],
  intents: [] as any[],
  business: { id: "biz-A", currentCash: 10_000_000 },
};

vi.mock("@/lib/prisma", () => {
  const match = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (k === "transaction" || k === "strategy") return true; // tenant scope
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
      paymentRecovery: {
        findFirst: vi.fn(async ({ where }: any) => {
          const r = world.recoveries.find((x) => match(x, where));
          return r ? { ...r, transaction: { businessId: world.business.id } } : null;
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          const r = world.recoveries.find((x) => x.id === where.id);
          return r ? { ...r, transaction: { businessId: world.business.id } } : null;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const r of world.recoveries) {
            if (!match(r, where)) continue;
            Object.assign(r, data);
            count++;
          }
          return { count };
        }),
      },
      executionIntent: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async ({ where }: any) => {
          const found = world.intents.find((i) => match(i, where));
          if (!found) return null;
          return { ...found, action: world.actions.find((a) => a.id === found.actionId) ?? null };
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      invoice: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
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
      $transaction: vi.fn(async (fn: any) => {
        const mod = await import("@/lib/prisma");
        return typeof fn === "function" ? fn(mod.prisma) : fn;
      }),
    },
  };
});

import { settlePayment } from "../settlement";

const LINK = "plink_PAID";

function seed(actionStatus: string) {
  world.actions.length = 0;
  world.recoveries.length = 0;
  world.intents.length = 0;
  world.business.currentCash = 10_000_000;

  world.actions.push({
    id: "action-1",
    strategyId: "strategy-1",
    actionType: "RECOVER_FAILED_PAYMENTS",
    status: actionStatus,
    auditLog: [],
    predictionActual: null,
    result: "",
  });
  world.recoveries.push({
    id: "rec-1",
    status: "PAYMENT_PENDING",
    paymentLinkId: LINK,
    amount: 100_000,
  });
  world.intents.push({
    id: "intent-1",
    actionId: "action-1",
    externalRef: LINK,
    targetType: "PAYMENT_RECOVERY",
    targetId: "rec-1",
    status: "SUCCEEDED",
  });
}

beforeEach(() => vi.clearAllMocks());

describe("settlement never un-settles money because an action cannot advance", () => {
  it("credits the ledger even when the action is stuck at APPROVED", async () => {
    // APPROVED -> RECONCILING is not a legal transition, which is exactly the
    // live state that used to throw and roll the whole settlement back.
    seed("APPROVED");

    const result = await settlePayment(LINK, "biz-A");

    expect(result).toBe("paid");
    expect(world.recoveries[0].status).toBe("RECOVERED");
    expect(world.business.currentCash).toBe(10_000_000 + 100_000);
    // The action itself is left alone rather than forced through an illegal move.
    expect(world.actions[0].status).toBe("APPROVED");
  });

  it("does not throw where it previously reported a phantom concurrent change", async () => {
    seed("APPROVED");
    await expect(settlePayment(LINK, "biz-A")).resolves.toBe("paid");
  });

  it("still advances an action that CAN legally reconcile", async () => {
    seed("EXECUTING");

    await settlePayment(LINK, "biz-A");

    expect(world.recoveries[0].status).toBe("RECOVERED");
    expect(world.business.currentCash).toBe(10_000_000 + 100_000);
    expect(world.actions[0].status).toBe("COMPLETED");
  });

  it("credits exactly once when the same settlement is delivered twice", async () => {
    seed("EXECUTING");

    await settlePayment(LINK, "biz-A");
    await settlePayment(LINK, "biz-A");

    expect(world.business.currentCash).toBe(10_000_000 + 100_000);
  });
});
