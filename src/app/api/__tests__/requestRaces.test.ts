import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { seedFreshDecision } from "../../../lib/engine/__tests__/helpers/prismaFakes";

/**
 * PART 25 - request-level race conditions.
 *
 * SCOPE NOTE, stated plainly: this project has no DOM test environment
 * (no jsdom, no testing-library), so these are NOT rendered-component tests.
 * They exercise the races at the layer where the financial safety property
 * actually lives - the API contract under duplicate, concurrent, interleaved
 * and cross-tenant requests. A double-clicked button is two POSTs; that is what
 * is tested here. The UI's own in-flight guards are asserted structurally at the
 * bottom of the file, which is a weaker check and is reported as such.
 */

const stores = vi.hoisted(() => ({
  intents: [] as any[],
  decisions: [] as any[],
  events: [] as any[],
}));

const world = vi.hoisted(() => ({
  cash: 10000000,
  actions: [] as any[],
  invoices: [] as any[],
}));

vi.mock("@/lib/prisma", async () => {
  const { makeExecutionIntentFake, makeDecisionFakes, matchesField } = await import(
    "../../../lib/engine/__tests__/helpers/prismaFakes"
  );
  return {
    prisma: {
      executionIntent: makeExecutionIntentFake(stores as any),
      ...makeDecisionFakes(stores as any),
      business: {
        findUnique: vi.fn(async ({ where }: any) =>
          where.id === "biz-A" ? { id: "biz-A", name: "A", currentCash: world.cash } : null
        ),
        findFirst: vi.fn(async () => ({ id: "biz-A", name: "A", currentCash: world.cash })),
      },
      transaction: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), update: vi.fn() },
      payout: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), update: vi.fn() },
      invoice: { findMany: vi.fn(async () => world.invoices), updateMany: vi.fn(async () => ({ count: 1 })) },
      paymentRecovery: { findFirst: vi.fn(async () => null), update: vi.fn() },
      strategy: {
        findFirst: vi.fn(async ({ where }: any) =>
          where.id === "strategy-1" && where.businessId === "biz-A"
            ? {
                id: "strategy-1",
                name: "FULL_INTERVENTION",
                projectedBalance: -4200000,
                startingCash: 10000000,
                riskLevel: "HIGH",
                agentActions: world.actions,
              }
            : null
        ),
      },
      agentAction: {
        findMany: vi.fn(async () => world.actions),
        findUnique: vi.fn(async ({ where }: any) => world.actions.find((a) => a.id === where.id) ?? null),
        update: vi.fn(async ({ where, data }: any) => {
          const a = world.actions.find((x) => x.id === where.id);
          if (a) Object.assign(a, data);
          return a;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const a of world.actions) {
            if (where.id && a.id !== where.id) continue;
            if (where.strategyId && a.strategyId !== where.strategyId) continue;
            if (where.status && !matchesField(a.status, where.status)) continue;
            Object.assign(a, data);
            count++;
          }
          return { count };
        }),
      },
      $transaction: vi.fn(async (fn: any) =>
        typeof fn === "function"
          ? fn({
              agentAction: {
                findMany: vi.fn(async () => world.actions),
                // A real Prisma.TransactionClient has `update`; this double did
                // not, so any code path that appends to a single row's audit log
                // inside a transaction blew up with a 500.
                update: vi.fn(async ({ where, data }: any) => {
                  const a = world.actions.find((x: any) => x.id === where.id);
                  if (a) Object.assign(a, data);
                  return a;
                }),
                updateMany: vi.fn(async ({ where, data }: any) => {
                  let count = 0;
                  for (const a of world.actions) {
                    if (where.status && !matchesField(a.status, where.status)) continue;
                    Object.assign(a, data);
                    count++;
                  }
                  return { count };
                }),
              },
              paymentRecovery: { findFirst: vi.fn(async () => null) },
              decision: (await import("../../../lib/engine/__tests__/helpers/prismaFakes")).makeDecisionFakes(stores as any).decision,
              decisionEvent: (await import("../../../lib/engine/__tests__/helpers/prismaFakes")).makeDecisionFakes(stores as any).decisionEvent,
              transaction: { findFirst: vi.fn(async () => null), update: vi.fn() },
              payout: { findFirst: vi.fn(async () => null), update: vi.fn() },
            })
          : undefined
      ),
    },
  };
});

vi.mock("@/lib/auth", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/ai/agents", () => ({ runAgent: vi.fn(async () => "narration") }));
vi.mock("@/lib/razorpay/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/razorpay/client")>("@/lib/razorpay/client");
  return {
    ...actual,
    createRecoveryPaymentLink: vi.fn(async (_a: number, _d: string, key?: string) => ({
      id: `plink_${key}`,
      short_url: `/sandbox/checkout?paymentLinkId=plink_${key}`,
      status: "created",
    })),
  };
});

const SESSION_A = { userId: "u1", name: "U", email: "u@x.com", businessId: "biz-A", businessName: "A" };
const SESSION_B = { userId: "u2", name: "V", email: "v@x.com", businessId: "biz-B", businessName: "B" };

function req(url: string, body: unknown) {
  return new Request(url, { method: "POST", body: JSON.stringify(body) });
}

async function resetWorld(actionStatus = "PENDING") {
  stores.intents.length = 0;
  stores.decisions.length = 0;
  stores.events.length = 0;
  world.cash = 10000000;
  world.invoices = [{ id: "inv-1", amount: 4400000, customerName: "Acme", status: "OVERDUE", businessId: "biz-A" }];
  world.actions = [
    {
      id: "action-1",
      strategyId: "strategy-1",
      actionType: "PRIORITIZE_COLLECTIONS",
      amount: 4400000,
      status: actionStatus,
      auditLog: [],
      targetPayoutId: null,
      targetTransactionId: null,
    },
  ];
  await seedFreshDecision(prisma, stores as any, {
    businessId: "biz-A",
    strategyId: "strategy-1",
    strategyType: "FULL_INTERVENTION",
    actions: [{ type: "PRIORITIZE_COLLECTIONS", amount: 4400000 }],
    status: actionStatus === "APPROVED" ? "APPROVED" : "PRESENTED",
  });
}

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue(SESSION_A as any);
});

describe("PART 25 - Double-click and duplicate requests", () => {
  it("double-clicking Approve produces one approval, not two", async () => {
    await resetWorld("PENDING");
    const { POST } = await import("../approve/route");

    const [r1, r2] = await Promise.all([
      POST(req("http://x/api/approve", { strategyId: "strategy-1" })),
      POST(req("http://x/api/approve", { strategyId: "strategy-1" })),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Exactly one APPROVED event in the append-only log.
    const approvals = stores.events.filter((e) => e.eventType === "APPROVED");
    expect(approvals).toHaveLength(1);
  });

  it("double-clicking Approve does not restamp who approved", async () => {
    await resetWorld("PENDING");
    const { POST } = await import("../approve/route");

    await POST(req("http://x/api/approve", { strategyId: "strategy-1" }));
    const firstApprover = stores.decisions[0].approvalSnapshot?.approvedBy;

    vi.mocked(getSession).mockResolvedValue({ ...SESSION_A, userId: "someone-else" } as any);
    await POST(req("http://x/api/approve", { strategyId: "strategy-1" }));

    expect(stores.decisions[0].approvalSnapshot?.approvedBy).toBe(firstApprover);
  });

  it("double-clicking Execute issues exactly one payment link", async () => {
    await resetWorld("APPROVED");
    const { POST } = await import("../execute/route");
    const { createRecoveryPaymentLink } = await import("@/lib/razorpay/client");

    await Promise.all([
      POST(req("http://x/api/execute", { strategyId: "strategy-1" })),
      POST(req("http://x/api/execute", { strategyId: "strategy-1" })),
    ]);

    // One invoice, one link - the duplicate request must not create a second.
    expect(vi.mocked(createRecoveryPaymentLink).mock.calls.length).toBe(1);
    expect(stores.intents).toHaveLength(1);
  });

  it("a duplicate Execute after completion reuses the recorded intent", async () => {
    await resetWorld("APPROVED");
    const { POST } = await import("../execute/route");
    const { createRecoveryPaymentLink } = await import("@/lib/razorpay/client");

    await POST(req("http://x/api/execute", { strategyId: "strategy-1" }));
    const callsAfterFirst = vi.mocked(createRecoveryPaymentLink).mock.calls.length;

    await POST(req("http://x/api/execute", { strategyId: "strategy-1" }));
    expect(vi.mocked(createRecoveryPaymentLink).mock.calls.length).toBe(callsAfterFirst);
  });

  it("a refresh mid-execution never reports a false success", async () => {
    await resetWorld("APPROVED");
    const { POST } = await import("../execute/route");

    const res = await POST(req("http://x/api/execute", { strategyId: "strategy-1" }));
    const body = await res.json();

    // The link exists but nothing has settled. A page reloading here must be
    // told exactly that.
    expect(body.settlementConfirmed).toBe(false);
    expect(body.steps[0].status).toBe("EXECUTING");
    expect(body.after).toBe(world.cash); // committed balance, not the hoped-for one
    expect(body.afterIfAllSettles).toBeGreaterThan(body.after);
  });

  it("an unknown execution is surfaced for manual verification, not retried", async () => {
    await resetWorld("APPROVED");
    const { createRecoveryPaymentLink } = await import("@/lib/razorpay/client");
    vi.mocked(createRecoveryPaymentLink).mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const { POST } = await import("../execute/route");
    const body = await (await POST(req("http://x/api/execute", { strategyId: "strategy-1" }))).json();

    expect(body.executionOutcome).toBe("EXECUTION_UNKNOWN");
    expect(body.requiresManualVerification).toBe(true);
    // The decision must NOT have advanced to EXECUTED or NOT_EXECUTED.
    expect(stores.decisions[0].status).toBe("APPROVED");
  });

  it("a second request after an unknown execution does not re-issue the payment", async () => {
    await resetWorld("APPROVED");
    const { createRecoveryPaymentLink } = await import("@/lib/razorpay/client");
    vi.mocked(createRecoveryPaymentLink).mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const { POST } = await import("../execute/route");
    await POST(req("http://x/api/execute", { strategyId: "strategy-1" }));
    const callsAfterFirst = vi.mocked(createRecoveryPaymentLink).mock.calls.length;

    await POST(req("http://x/api/execute", { strategyId: "strategy-1" }));
    expect(vi.mocked(createRecoveryPaymentLink).mock.calls.length).toBe(callsAfterFirst);
  });

  it("opening a stale strategy is refused server-side with a reason", async () => {
    await resetWorld("PENDING");
    // The world moves after the decision was fingerprinted.
    world.cash = 20000000;

    const { POST } = await import("../approve/route");
    const res = await POST(req("http://x/api/approve", { strategyId: "strategy-1" }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("STRATEGY_STALE");
    expect(body.classification).toBe("MATERIAL_CHANGE");
    expect(body.message).toMatch(/regenerate/i);
    // Refusal is audited.
    expect(stores.events.some((e) => e.eventType === "STALE_BLOCKED")).toBe(true);
  });

  it("switching business mid-request cannot reach the other tenant's strategy", async () => {
    await resetWorld("APPROVED");
    vi.mocked(getSession).mockResolvedValue(SESSION_B as any);

    const { POST } = await import("../execute/route");
    const res = await POST(req("http://x/api/execute", { strategyId: "strategy-1" }));

    // biz-B has no such business row, let alone the strategy.
    expect([403, 404]).toContain(res.status);
    expect(stores.intents).toHaveLength(0);
  });

  it("rejecting a stale strategy is always allowed", async () => {
    await resetWorld("PENDING");
    world.cash = 20000000; // materially stale

    const { POST } = await import("../approve/route");
    const res = await POST(req("http://x/api/approve", { strategyId: "strategy-1", action: "reject" }));

    // Declining a recommendation that no longer applies must never be blocked.
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("REJECTED");
  });
});

describe("PART 25 - UI in-flight guards (structural)", () => {
  /**
   * Weaker than the contract tests above: this reads source rather than
   * behaviour. It exists so a guard cannot be deleted silently, not as proof
   * that the rendered component behaves correctly.
   */
  it("the approval and execution pages both guard against re-entry", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const root = path.resolve(__dirname, "../../..");

    const approval = fs.readFileSync(path.join(root, "app/approval/page.tsx"), "utf-8");
    expect(approval).toMatch(/if \(!strategyId \|\| approving\) return;/);

    const execution = fs.readFileSync(path.join(root, "app/execution/page.tsx"), "utf-8");
    expect(execution).toMatch(/if \(!strategyId \|\| executing\) return;/);
  });
});
