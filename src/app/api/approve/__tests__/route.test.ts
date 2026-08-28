import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../route";
import { prisma } from "@/lib/prisma";
import { seedFreshDecision } from "../../../../lib/engine/__tests__/helpers/prismaFakes";

const stores = vi.hoisted(() => ({
  intents: [] as any[],
  decisions: [] as any[],
  events: [] as any[],
}));

vi.mock("@/lib/prisma", async () => {
  const { makeExecutionIntentFake, makeDecisionFakes } = await import(
    "../../../../lib/engine/__tests__/helpers/prismaFakes"
  );
  const executionIntentFake = makeExecutionIntentFake(stores as any);
  const decisionFakes = makeDecisionFakes(stores as any);
  return {
    prisma: {
      executionIntent: executionIntentFake,
      decision: decisionFakes.decision,
      decisionEvent: decisionFakes.decisionEvent,
      transaction: { findMany: vi.fn(async () => []) },
      payout: { findMany: vi.fn(async () => []) },
      strategy: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      business: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
      },
      paymentRecovery: {
        findFirst: vi.fn(),
      },
      agentAction: {
        findMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(),
    },
  };
});

vi.mock("@/lib/auth", () => {
  return {
    getSession: vi.fn(() => Promise.resolve({ userId: "mock-user-id", name: "Mock User", email: "mock@company.com", businessId: "business-1", businessName: "Mock Business" })),
  };
});

describe("Approve Strategy Route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Concurrent Approval: duplicate approval requests return HTTP 200 idempotently", async () => {
    const mockStrategy = {
      id: "strategy-1",
      name: "FULL_INTERVENTION",
      createdAt: new Date(),
      agentActions: [
        { id: "action-1", status: "PENDING", actionType: "PAUSE_EXPENSE", amount: 1500000 },
        { id: "action-2", status: "PENDING", actionType: "PRIORITIZE_COLLECTIONS", amount: 4400000 },
      ],
    };

    const mockBusiness = { id: "business-1", name: "Mock Business", currentCash: 10000000 };
    vi.mocked(prisma.business.findFirst).mockResolvedValue(mockBusiness as any);
    vi.mocked(prisma.business.findUnique).mockResolvedValue(mockBusiness as any);
    vi.mocked(prisma.strategy.findFirst).mockResolvedValue(mockStrategy as any);

    // Approval now runs a server-side freshness gate, so the strategy needs a
    // decision whose fingerprint matches the world it is about to be checked
    // against. Seeded from the same builder the gate uses.
    stores.decisions.length = 0;
    stores.events.length = 0;
    await seedFreshDecision(prisma, stores as any, {
      businessId: "business-1",
      strategyId: "strategy-1",
      strategyType: "FULL_INTERVENTION",
      actions: [
        { type: "PAUSE_EXPENSE", amount: 1500000 },
        { type: "PRIORITIZE_COLLECTIONS", amount: 4400000 },
      ],
      status: "PRESENTED",
    });

    // Mock first call: transaction succeeds (updateMany returns count: 2)
    let callCount = 0;
    vi.mocked(prisma.$transaction).mockImplementation((cb) => {
      callCount++;
      const txContext = {
        paymentRecovery: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        agentAction: {
          findMany: vi.fn().mockResolvedValue(mockStrategy.agentActions as any),
          // Present on a real Prisma.TransactionClient. The audit trail is
          // appended per row, which needs `update`, not `updateMany`.
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: callCount === 1 ? 2 : 0 }),
        },
      };
      return cb(txContext as any);
    });

    // Mock prisma.agentAction.findMany (for refetch inside error handler/idempotency check)
    vi.mocked(prisma.agentAction.findMany).mockResolvedValue([
      { id: "action-1", status: "APPROVED" },
      { id: "action-2", status: "APPROVED" },
    ] as any);

    const req1 = new Request("http://localhost/api/approve", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    });
    const req2 = new Request("http://localhost/api/approve", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    });

    const [res1, res2] = await Promise.all([
      POST(req1),
      POST(req2)
    ]);

    const body1 = await res1.json();
    const body2 = await res2.json();

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(body1.status).toBe("APPROVED");
    expect(body2.status).toBe("APPROVED");
  });
});
