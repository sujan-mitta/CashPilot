import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/strategies — four defects, all in one request path.
 *
 *  1. `deficitDays` was computed from a 0-BASED findIndex for the baseline and
 *     a 1-BASED crisisDay for the recommendation, both subtracted from 14. A
 *     strategy that changed nothing appeared to remove exactly one deficit day,
 *     and these two numbers are what outcome measurement later compares.
 *
 *  2. The failed payment to recover was `transactions.find(t => t.status ===
 *     "FAILED")` - array order, and it accepted a failed OUTFLOW, which is a
 *     payment WE failed to make and is not recoverable revenue at all.
 *
 *  3. The cleanup filtered on `decision: null`, but a Decision is created for
 *     EVERY strategy, so it matched nothing. Each visit to /strategies added
 *     four more Strategy rows, four Decisions and their actions, permanently.
 *
 *  4. No rate limit, on a route holding a 30-second transaction plus an LLM
 *     call.
 */

const world = vi.hoisted(() => ({
  transactions: [] as any[],
  invoices: [] as any[],
  payouts: [] as any[],
  createdStrategies: [] as any[],
  createdDecisions: [] as any[],
  supersedable: [] as { id: string }[],
  intents: [] as { strategyId: string }[],
  deleted: {
    strategies: [] as string[],
    decisions: [] as string[],
    actions: [] as string[],
  },
  businessId: "biz-1",
}));

vi.mock("@/lib/prisma", () => {
  const tx = {
    strategy: {
      findMany: vi.fn(async () => world.supersedable),
      create: vi.fn(async ({ data }: any) => {
        const created = {
          id: `strategy-${data.name}`,
          ...data,
          agentActions: (data.agentActions?.create ?? []).map((a: any, i: number) => ({
            id: `action-${data.name}-${i}`,
            ...a,
          })),
        };
        world.createdStrategies.push(created);
        return created;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        world.deleted.strategies.push(...(where.id?.in ?? []));
        return { count: (where.id?.in ?? []).length };
      }),
    },
    agentAction: {
      deleteMany: vi.fn(async ({ where }: any) => {
        world.deleted.actions.push(...(where.strategyId?.in ?? []));
        return { count: 0 };
      }),
    },
    executionIntent: { findMany: vi.fn(async () => world.intents) },
    decision: {
      create: vi.fn(async ({ data }: any) => {
        const created = { id: `decision-${data.strategyId}`, ...data };
        world.createdDecisions.push(created);
        return created;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        world.deleted.decisions.push(...(where.strategyId?.in ?? []));
        return { count: 0 };
      }),
      findFirst: vi.fn(async () => null),
    },
    decisionEvent: {
      create: vi.fn(async ({ data }: any) => data),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };

  return {
    prisma: {
      business: {
        findUnique: vi.fn(async () => ({ id: world.businessId, name: "Acme", currentCash: 10_000_000 })),
        findFirst: vi.fn(async () => ({ id: world.businessId, name: "Acme", currentCash: 10_000_000 })),
      },
      transaction: { findMany: vi.fn(async () => world.transactions) },
      invoice: { findMany: vi.fn(async () => world.invoices) },
      payout: { findMany: vi.fn(async () => world.payouts) },
      // The route stamps each decision with the materialised state version it
      // was computed against. No state has been materialised in this fixture,
      // so the honest answer is null — which the freshness gate reads as
      // NOT_TRACKED, exactly as before the column was populated.
      financialState: { findFirst: vi.fn(async () => null) },
      ...tx,
      $transaction: vi.fn(async (cb: any) => cb(tx)),
    },
  };
});

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "user-1",
    name: "Operator",
    email: "op@acme.test",
    businessId: world.businessId,
    businessName: "Acme",
  })),
}));

vi.mock("@/lib/ai/agents", () => ({ runAgent: vi.fn(async (_p: string, fallback: string) => fallback) }));

import { POST } from "../route";

const outflow = (id: string, amount: number, dayOffset: number) => ({
  id,
  businessId: "biz-1",
  amount,
  type: "OUTFLOW",
  status: "PENDING",
  description: `Payout ${id}`,
  expectedDate: new Date(Date.now() + dayOffset * 86_400_000),
});

const failedInflow = (id: string, amount: number) => ({
  id,
  businessId: "biz-1",
  amount,
  type: "INFLOW",
  status: "FAILED",
  description: `Failed order ${id}`,
  expectedDate: new Date(Date.now() - 2 * 86_400_000),
});

beforeEach(() => {
  vi.clearAllMocks();
  // Each test gets its own tenant id so the per-business rate limiter (which is
  // process-global and intentionally has no reset hook) cannot bleed across.
  world.businessId = `biz-${Math.random().toString(36).slice(2)}`;
  world.transactions = [];
  world.invoices = [];
  world.payouts = [];
  world.createdStrategies = [];
  world.createdDecisions = [];
  world.supersedable = [];
  world.intents = [];
  world.deleted = { strategies: [], decisions: [], actions: [] };
});

describe("deficit-day parity between baseline and recommendation", () => {
  it("THE BUG: a plan that changes nothing reports the SAME deficit days as the baseline", async () => {
    // A large outflow inside the window drives the balance negative, and
    // DO_NOTHING by definition does nothing about it.
    world.transactions = [outflow("tx-1", 50_000_000, 3)];

    const res = await POST();
    expect(res.status).toBe(200);

    const doNothing = world.createdDecisions.find(
      (d) => d.recommendedSnapshot.strategyType === "DO_NOTHING"
    );
    expect(doNothing).toBeDefined();
    // Off by one before the fix: baseline 12, recommendation 11.
    expect(doNothing.recommendedSnapshot.deficitDays).toBe(doNothing.baselineSnapshot.deficitDays);
  });

  it("no deficit anywhere means zero on both sides, not a horizon-length number", async () => {
    world.transactions = [outflow("tx-1", 1_000, 3)];
    await POST();
    const doNothing = world.createdDecisions.find(
      (d) => d.recommendedSnapshot.strategyType === "DO_NOTHING"
    );
    expect(doNothing.baselineSnapshot.deficitDays).toBe(0);
    expect(doNothing.recommendedSnapshot.deficitDays).toBe(0);
  });
});

describe("which failed payment is chosen", () => {
  it("THE BUG: a failed OUTFLOW is not recoverable revenue and is never picked", async () => {
    // A payment WE failed to make. Simulating it as an inflow invents money.
    world.transactions = [
      { ...outflow("tx-out", 900_000, 2), status: "FAILED" },
      failedInflow("tx-in", 100_000),
    ];
    await POST();
    const recoverOnly = world.createdStrategies.find((s) => s.name === "RECOVER_ONLY");
    const recoverAction = recoverOnly.agentActions.find(
      (a: any) => a.actionType === "RECOVER_FAILED_PAYMENTS"
    );
    expect(recoverAction.targetTransactionId).toBe("tx-in");
    expect(recoverAction.amount).toBe(100_000);
  });

  it("picks the LARGEST recoverable failure, deterministically", async () => {
    world.transactions = [failedInflow("tx-small", 100_000), failedInflow("tx-big", 900_000)];
    await POST();
    const recoverOnly = world.createdStrategies.find((s) => s.name === "RECOVER_ONLY");
    expect(
      recoverOnly.agentActions.find((a: any) => a.actionType === "RECOVER_FAILED_PAYMENTS").amount
    ).toBe(900_000);
  });

  it("row order does not change the recommendation", async () => {
    const picks: number[] = [];
    for (const order of [
      [failedInflow("tx-a", 100_000), failedInflow("tx-b", 900_000)],
      [failedInflow("tx-b", 900_000), failedInflow("tx-a", 100_000)],
    ]) {
      world.businessId = `biz-${Math.random().toString(36).slice(2)}`;
      world.createdStrategies = [];
      world.transactions = order;
      await POST();
      picks.push(
        world.createdStrategies
          .find((s) => s.name === "RECOVER_ONLY")
          .agentActions.find((a: any) => a.actionType === "RECOVER_FAILED_PAYMENTS").amount
      );
    }
    expect(picks[0]).toBe(picks[1]);
  });

  it("surfaces the failures this recommendation does NOT address", async () => {
    // Real money the plan leaves on the table. Silently dropping it let the UI
    // imply the shortfall was fully covered.
    world.transactions = [failedInflow("tx-big", 900_000), failedInflow("tx-small", 100_000)];
    const body = await (await POST()).json();
    expect(body.unaddressedFailures).toEqual([
      { id: "tx-small", amount: 100_000, description: "Failed order tx-small" },
    ]);
  });

  it("reports an empty list when every failure is covered", async () => {
    world.transactions = [failedInflow("tx-only", 900_000)];
    const body = await (await POST()).json();
    expect(body.unaddressedFailures).toEqual([]);
  });
});

describe("superseded simulations are actually cleaned up", () => {
  it("THE BUG: an unacted previous simulation is deleted", async () => {
    world.supersedable = [{ id: "old-1" }, { id: "old-2" }];
    await POST();
    expect(world.deleted.strategies).toEqual(["old-1", "old-2"]);
    expect(world.deleted.decisions).toEqual(["old-1", "old-2"]);
    expect(world.deleted.actions).toEqual(["old-1", "old-2"]);
  });

  it("a strategy that ever DISPATCHED an intent is never deleted", async () => {
    // The intent is the durable record of an external side effect. Deleting it
    // would erase the only evidence that a payment link exists.
    world.supersedable = [{ id: "old-safe" }, { id: "old-dispatched" }];
    world.intents = [{ strategyId: "old-dispatched" }];
    await POST();
    expect(world.deleted.strategies).toEqual(["old-safe"]);
    expect(world.deleted.strategies).not.toContain("old-dispatched");
  });

  it("deletes nothing when there is nothing superseded", async () => {
    world.supersedable = [];
    await POST();
    expect(world.deleted.strategies).toEqual([]);
  });
});

describe("rate limiting", () => {
  it("an expensive route cannot be hammered from one tenant", async () => {
    world.transactions = [outflow("tx-1", 1_000, 3)];
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await POST()).status);

    expect(statuses.filter((s) => s === 200).length).toBe(10);
    const limited = statuses.filter((s) => s === 429);
    expect(limited.length).toBe(4);
  });

  it("a 429 carries Retry-After so a client knows when to come back", async () => {
    world.transactions = [outflow("tx-1", 1_000, 3)];
    let res = await POST();
    for (let i = 0; i < 12 && res.status !== 429; i++) res = await POST();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("one tenant's limit does not affect another", async () => {
    world.transactions = [outflow("tx-1", 1_000, 3)];
    for (let i = 0; i < 12; i++) await POST();

    world.businessId = "biz-fresh-tenant";
    expect((await POST()).status).toBe(200);
  });
});
