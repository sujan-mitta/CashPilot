import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * REGRESSION: an action left EXECUTING forever after its work was settled.
 *
 * A payment link belongs to an OBLIGATION (an invoice), not to an action. When
 * a strategy is regenerated, the new action re-attaches to the existing link
 * rather than issuing a second one - so two actions reference one link. But
 * settlement resolves exactly ONE action, via the intent's `externalRef`, so
 * the other stayed EXECUTING. `reconcileDecisionForStrategy` reads EXECUTING as
 * still-in-flight, so that decision never reconciled either.
 *
 * Confirmed live: link plink_TTqbMASMw9oJv1 resolved to its original action,
 * and nothing advanced any other action referencing the same link.
 */

const world = {
  actions: [] as any[],
  invoices: [] as any[],
  intents: [] as any[],
  business: { id: "biz-A", currentCash: 100_000_000 },
};

vi.mock("@/lib/prisma", () => {
  const match = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (k === "strategy") return true; // tenant scope; single-tenant in this fake
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
          const found = world.intents.find((i) => match(i, where));
          if (!found) return null;
          return { ...found, action: world.actions.find((a) => a.id === found.actionId) ?? null };
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      paymentRecovery: {
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => null),
      },
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

const LINK_A = "plink_LINK_A";
const LINK_B = "plink_LINK_B";

/** Result payload in the shape executePrioritizeCollections writes. */
const linksResult = (pairs: [string, string][]) =>
  JSON.stringify({
    message: `Generated payment links for ${pairs.length} of ${pairs.length} overdue invoices.`,
    links: pairs.map(([invoiceId, paymentLinkId]) => ({
      invoiceId,
      customerName: invoiceId,
      paymentLinkId,
      shortUrl: `/sandbox/checkout?paymentLinkId=${paymentLinkId}`,
      amount: 1000,
    })),
  });

function seed(siblingStatus = "EXECUTING") {
  world.actions.length = 0;
  world.invoices.length = 0;
  world.intents.length = 0;
  world.business.currentCash = 100_000_000;

  world.invoices.push(
    { id: "inv-1", amount: 1000, status: "OVERDUE", businessId: "biz-A" },
    { id: "inv-2", amount: 1000, status: "OVERDUE", businessId: "biz-A" }
  );

  // The ORIGINAL action that issued both links.
  world.actions.push({
    id: "action-1",
    strategyId: "strategy-1",
    actionType: "PRIORITIZE_COLLECTIONS",
    status: "EXECUTING",
    auditLog: [],
    result: linksResult([["inv-1", LINK_A], ["inv-2", LINK_B]]),
  });

  // The RETRY, from a regenerated strategy, re-attached to the same links.
  world.actions.push({
    id: "action-2",
    strategyId: "strategy-2",
    actionType: "PRIORITIZE_COLLECTIONS",
    status: siblingStatus,
    auditLog: [],
    result: linksResult([["inv-1", LINK_A], ["inv-2", LINK_B]]),
  });

  // Only ONE intent exists - the blocked retry never created a second.
  world.intents.push({
    id: "intent-1",
    actionId: "action-1",
    idempotencyKey: "cp_key_1",
    externalRef: LINK_A,
    targetType: "INVOICE",
    targetId: "inv-1",
    status: "SUCCEEDED",
  });
}

const seedSecondIntent = () =>
  world.intents.push({
    id: "intent-2",
    actionId: "action-1",
    idempotencyKey: "cp_key_2",
    externalRef: LINK_B,
    targetType: "INVOICE",
    targetId: "inv-2",
    status: "SUCCEEDED",
  });

beforeEach(() => seed());

describe("settlement converges every action referencing the settled obligation", () => {
  it("leaves the retry EXECUTING while only part of the fan-out is paid", async () => {
    await settlePayment(LINK_A, "biz-A");

    expect(world.invoices.find((i) => i.id === "inv-1").status).toBe("PAID");
    expect(world.invoices.find((i) => i.id === "inv-2").status).toBe("OVERDUE");
    // inv-2 is still outstanding, so neither action is finished.
    expect(world.actions.find((a) => a.id === "action-2").status).toBe("EXECUTING");
  });

  it("completes the retry once every invoice it targeted is paid", async () => {
    seedSecondIntent();

    await settlePayment(LINK_A, "biz-A");
    await settlePayment(LINK_B, "biz-A");

    expect(world.invoices.every((i) => i.status === "PAID")).toBe(true);

    // THE DEFECT: action-2 used to stay EXECUTING forever, because settlement
    // resolves only the intent's own action.
    const retry = world.actions.find((a) => a.id === "action-2");
    expect(retry.status).toBe("COMPLETED");

    // The convergence is auditable, and attributed to settlement.
    const entry = retry.auditLog[retry.auditLog.length - 1];
    expect(entry.who).toBe("SYSTEM_SETTLEMENT");
    expect(entry.why).toMatch(/different action for the same obligation/i);
  });

  it("credits the cash exactly once per invoice despite two actions", async () => {
    seedSecondIntent();

    await settlePayment(LINK_A, "biz-A");
    await settlePayment(LINK_B, "biz-A");
    // A duplicate delivery of both links must move nothing further.
    await settlePayment(LINK_A, "biz-A");
    await settlePayment(LINK_B, "biz-A");

    expect(world.business.currentCash).toBe(100_000_000 + 1000 + 1000);
  });

  it("never re-transitions an action that is already terminal", async () => {
    seed("COMPLETED");
    seedSecondIntent();

    await settlePayment(LINK_A, "biz-A");
    await settlePayment(LINK_B, "biz-A");

    const retry = world.actions.find((a) => a.id === "action-2");
    expect(retry.status).toBe("COMPLETED");
    expect(retry.auditLog).toHaveLength(0); // untouched, not re-written
  });
});
