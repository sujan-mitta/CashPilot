import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET as handleForecast } from "../../../app/api/forecast/route";
import { POST as handleStrategies } from "../../../app/api/strategies/route";
import { prisma } from "../../../lib/prisma";
import { getSession } from "../../../lib/auth";

vi.mock("@/lib/prisma", () => {
  return {
    prisma: {
      business: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      transaction: {
        findMany: vi.fn(),
      },
      payout: {
        findMany: vi.fn(),
      },
      invoice: {
        findMany: vi.fn(),
      },
      strategy: {
        deleteMany: vi.fn(),
        create: vi.fn(),
        findFirst: vi.fn(),
        // The supersede sweep asks which strategies are replaceable before it
        // deletes anything; an empty answer means "nothing to clean up".
        findMany: vi.fn(async () => []),
      },
      agentAction: {
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
      executionIntent: {
        findMany: vi.fn(async () => []),
      },
      decision: {
        create: vi.fn(async ({ data }: any) => ({ id: `decision-${data.strategyId}`, ...data })),
        deleteMany: vi.fn(),
        findFirst: vi.fn(async () => null),
      },
      decisionEvent: {
        create: vi.fn(async ({ data }: any) => ({ id: "evt-1", ...data })),
        deleteMany: vi.fn(),
      },
      $transaction: vi.fn((cb) => cb(prisma)),
    },
  };
});

vi.mock("@/lib/auth", () => {
  return {
    getSession: vi.fn(),
  };
});

describe("CFO Decision Interface & Traceability Contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Forecast API Contract: returns safetyRequirement containing weights, averageDailyOutflow, and confidence level", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "user-1",
      name: "CFO User",
      email: "cfo@company.com",
      businessId: "biz-1",
      businessName: "Acme Corp",
    });

    const mockBusiness = { id: "biz-1", name: "Acme Corp", currentCash: 10000000 };
    const mockTransactions = [
      { id: "tx-1", businessId: "biz-1", amount: 150000, type: "OUTFLOW", status: "PENDING", expectedDate: new Date() },
    ];

    vi.mocked(prisma.business.findUnique).mockResolvedValue(mockBusiness as any);
    vi.mocked(prisma.transaction.findMany).mockResolvedValue(mockTransactions as any);
    vi.mocked(prisma.payout.findMany).mockResolvedValue([]);

    const response = await handleForecast();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.forecast).toBeDefined();
    expect(body.forecast.safetyRequirement).toBeDefined();
    expect(body.forecast.safetyRequirement.requiredBuffer).toBeGreaterThan(0);
    expect(body.forecast.safetyRequirement.averageDailyOutflow).toBeDefined();
    expect(body.forecast.safetyRequirement.confidence).toBeDefined();
    expect(Array.isArray(body.forecast.safetyRequirement.dataWarnings)).toBe(true);
  });

  it("Forecast API Contract: handles empty transaction state gracefully without crashing", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "user-1",
      name: "CFO User",
      email: "cfo@company.com",
      businessId: "biz-1",
      businessName: "Acme Corp",
    });

    vi.mocked(prisma.business.findUnique).mockResolvedValue({ id: "biz-1", name: "Acme Corp", currentCash: 0 } as any);
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);
    vi.mocked(prisma.payout.findMany).mockResolvedValue([]);

    const response = await handleForecast();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("NO_DATA");
    expect(body.forecast).toBeNull();
  });

  it("Forecast API Contract: enforces strict multi-tenant isolation", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "user-1",
      name: "CFO User",
      email: "cfo@company.com",
      businessId: "different-biz",
      businessName: "Different Corp",
    });

    vi.mocked(prisma.business.findUnique).mockResolvedValue(null);

    const response = await handleForecast();
    const body = await response.json();
    expect(body.status).toBe("NO_DATA");
    expect(body.forecast).toBeNull();
  });

  it("Strategies API Contract: persists scoring JSON object and returns safetyRequirement in response", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "user-1",
      name: "CFO User",
      email: "cfo@company.com",
      businessId: "biz-1",
      businessName: "Acme Corp",
    });

    const mockBusiness = { id: "biz-1", name: "Acme Corp", currentCash: 10000000 };
    const mockTransactions = [
      { id: "tx-1", businessId: "biz-1", amount: 24000000, type: "INFLOW", status: "FAILED", expectedDate: new Date() },
    ];

    vi.mocked(prisma.business.findUnique).mockResolvedValue(mockBusiness as any);
    vi.mocked(prisma.transaction.findMany).mockResolvedValue(mockTransactions as any);
    vi.mocked(prisma.invoice.findMany).mockResolvedValue([]);
    vi.mocked(prisma.payout.findMany).mockResolvedValue([]);

    const createdStrategies: any[] = [];
    vi.mocked(prisma.strategy.create).mockImplementation((({ data }: any) => {
      const agentActions = data.agentActions?.create?.map((a: any) => ({
        id: `action-${a.actionType}`,
        status: a.status || "PENDING",
        actionType: a.actionType,
        amount: a.amount,
      })) || [];
      const saved = {
        ...data,
        agentActions,
      };
      createdStrategies.push(saved);
      return Promise.resolve({ id: `strategy-${data.name}`, ...saved });
    }) as any);

    const response = await handleStrategies();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.safetyRequirement).toBeDefined();
    expect(body.strategies.length).toBeGreaterThan(0);

    // Verify database creation block contains scoring JSON
    expect(createdStrategies.length).toBeGreaterThan(0);
    for (const created of createdStrategies) {
      expect(created.scoring).toBeDefined();
      expect(created.scoring.finalScore).toBeDefined();
      expect(created.scoring.counterfactual).toBeDefined();
      expect(created.scoring.deferredObligations).toBeDefined();
    }
  });
});
