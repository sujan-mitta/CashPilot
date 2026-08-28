import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE APPROVAL VERB
 *
 * /api/approve read:
 *
 *     const action = typeof body.action === "string" ? body.action : "approve";
 *     const targetStatus = action === "reject" ? "REJECTED" : "APPROVED";
 *
 * so ANY unrecognised value fell through to APPROVED. On the single endpoint
 * that is the human gate for moving money, {"action":"REJECT"},
 * {"action":"rejct"} and {"action":"cancel"} all authorised the plan.
 *
 * Defaulting an unparseable instruction to the irreversible option is exactly
 * backwards. These lock the closed set.
 */

const world = vi.hoisted(() => ({
  actions: [] as any[],
  decisionStatus: "PRESENTED" as string,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { findUnique: vi.fn(async () => ({ id: "biz-1", name: "Acme", currentCash: 1_000_000 })) },
    strategy: {
      findFirst: vi.fn(async () => ({
        id: "strat-1",
        businessId: "biz-1",
        name: "RECOVER_ONLY",
        agentActions: world.actions,
      })),
    },
    agentAction: {
      findMany: vi.fn(async () => world.actions),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    decision: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async (cb: any) =>
      cb({
        agentAction: {
          findMany: vi.fn(async () => world.actions),
          update: vi.fn(async ({ where, data }: any) => {
            const a = world.actions.find((x) => x.id === where.id);
            if (a) Object.assign(a, data);
            return a;
          }),
          updateMany: vi.fn(async ({ where, data }: any) => {
            let count = 0;
            for (const a of world.actions) {
              if (where.status && a.status !== where.status) continue;
              Object.assign(a, data);
              count++;
            }
            return { count };
          }),
        },
        decision: {
          findFirst: vi.fn(async () => ({
            id: "dec-1",
            businessId: "biz-1",
            strategyId: "strat-1",
            status: world.decisionStatus,
          })),
          update: vi.fn(async ({ data }: any) => {
            if (data.status) world.decisionStatus = data.status;
            return { id: "dec-1", ...data };
          }),
          updateMany: vi.fn(async ({ data }: any) => {
            if (data.status) world.decisionStatus = data.status;
            return { count: 1 };
          }),
        },
        decisionEvent: { create: vi.fn(async (a: any) => a.data) },
      })
    ),
  },
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "user-1",
    name: "Operator",
    email: "op@acme.test",
    businessId: "biz-1",
    businessName: "Acme",
  })),
}));

vi.mock("@/lib/engine/freshnessGate", () => ({
  checkStrategyFreshness: vi.fn(async () => ({ verdict: { classification: "FRESH", changes: [] }, blocked: false })),
  recordStaleBlock: vi.fn(),
  describeStaleness: vi.fn(() => "stale"),
}));

import { POST } from "../route";

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/approve", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  world.actions = [
    { id: "act-1", strategyId: "strat-1", status: "PENDING", auditLog: [] },
    { id: "act-2", strategyId: "strat-1", status: "PENDING", auditLog: [] },
  ];
  world.decisionStatus = "PRESENTED";
});

describe("POST /api/approve — the action verb is a closed set", () => {
  it("approves when the verb is omitted (the documented default)", async () => {
    const res = await post({ strategyId: "strat-1" });
    expect(res.status).toBe(200);
    expect(world.actions.every((a) => a.status === "APPROVED")).toBe(true);
  });

  it("approves on an explicit \"approve\"", async () => {
    const res = await post({ strategyId: "strat-1", action: "approve" });
    expect(res.status).toBe(200);
    expect(world.actions.every((a) => a.status === "APPROVED")).toBe(true);
  });

  it("rejects on an explicit \"reject\"", async () => {
    const res = await post({ strategyId: "strat-1", action: "reject" });
    expect(res.status).toBe(200);
    expect(world.actions.every((a) => a.status === "REJECTED")).toBe(true);
  });

  it("THE BUG: a typo'd verb must NOT approve", async () => {
    const res = await post({ strategyId: "strat-1", action: "rejct" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_ACTION");
    // Nothing moved.
    expect(world.actions.every((a) => a.status === "PENDING")).toBe(true);
  });

  it("THE BUG: an unrelated verb must NOT approve", async () => {
    for (const verb of ["cancel", "delete", "execute", "yes", ""]) {
      world.actions.forEach((a) => (a.status = "PENDING"));
      const res = await post({ strategyId: "strat-1", action: verb });
      expect(res.status, `verb: ${verb}`).toBe(400);
      expect(world.actions.every((a) => a.status === "PENDING")).toBe(true);
    }
  });

  it("a non-string verb must NOT approve", async () => {
    for (const verb of [1, true, {}, ["reject"]]) {
      world.actions.forEach((a) => (a.status = "PENDING"));
      const res = await post({ strategyId: "strat-1", action: verb });
      expect(res.status).toBe(400);
      expect(world.actions.every((a) => a.status === "PENDING")).toBe(true);
    }
  });

  it("CASE AND WHITESPACE: \"REJECT\" rejects rather than silently approving", async () => {
    // This was the sharpest edge of the bug - the value LOOKS like a rejection
    // to anyone reading the request, and approved.
    const res = await post({ strategyId: "strat-1", action: "  REJECT " });
    expect(res.status).toBe(200);
    expect(world.actions.every((a) => a.status === "REJECTED")).toBe(true);
  });

  it("\"Approve\" in mixed case still approves", async () => {
    const res = await post({ strategyId: "strat-1", action: "Approve" });
    expect(res.status).toBe(200);
    expect(world.actions.every((a) => a.status === "APPROVED")).toBe(true);
  });

  it("an explicit null verb takes the default, not the error path", async () => {
    const res = await post({ strategyId: "strat-1", action: null });
    expect(res.status).toBe(200);
  });

  it("a rejection reason is bounded, so it cannot be an unbounded write", async () => {
    const res = await post({
      strategyId: "strat-1",
      action: "reject",
      reason: "x".repeat(50_000),
    });
    expect(res.status).toBe(200);
    const logged = world.actions[0].auditLog as { why: string }[];
    expect(logged[0].why.length).toBeLessThan(2100);
  });
});
