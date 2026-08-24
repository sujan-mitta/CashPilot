import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST as handleExplain } from "../route";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { runAgent } from "@/lib/ai/agents";

vi.mock("@/lib/prisma", () => {
  return {
    prisma: {
      business: {
        findUnique: vi.fn(),
      },
      strategy: {
        findMany: vi.fn(),
      },
    },
  };
});

vi.mock("@/lib/auth", () => {
  return {
    getSession: vi.fn(),
  };
});

vi.mock("@/lib/ai/agents", () => {
  return {
    runAgent: vi.fn(() => Promise.resolve("Mocked AI Narrative")),
  };
});

describe("AI Explanation Generation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/explain returns 401 if unauthorized", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const req = new Request("http://localhost/api/explain", {
      method: "POST",
      body: JSON.stringify({ type: "investigation" }),
    });

    const res = await handleExplain(req);
    expect(res.status).toBe(401);
  });

  it("POST /api/explain returns 400 if invalid type is passed", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "user-1",
      name: "Aryan Mittal",
      email: "mittal@company.com",
      businessId: "business-1",
      businessName: "ABC Electronics Pvt Ltd",
    });

    const req = new Request("http://localhost/api/explain", {
      method: "POST",
      body: JSON.stringify({ type: "invalid-type" }),
    });

    const res = await handleExplain(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid explanation type");
  });

  it("POST /api/explain generates investigation summary", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "user-1",
      name: "Aryan Mittal",
      email: "mittal@company.com",
      businessId: "business-1",
      businessName: "ABC Electronics Pvt Ltd",
    });

    vi.mocked(prisma.business.findUnique).mockResolvedValue({
      id: "business-1",
      currentCash: 100000000,
      transactions: [
        { amount: 24000000, type: "INFLOW", status: "FAILED", expectedDate: new Date() },
      ],
      invoices: [
        { amount: 30000000, status: "OVERDUE", dueDate: new Date() },
      ],
      payouts: [
        { amount: 80000000, vendor: "Payroll Run", scheduledDate: new Date() },
      ],
    } as any);

    const req = new Request("http://localhost/api/explain", {
      method: "POST",
      body: JSON.stringify({ type: "investigation" }),
    });

    const res = await handleExplain(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.narrative).toBe("Mocked AI Narrative");
    expect(runAgent).toHaveBeenCalled();
  });

  it("POST /api/explain generates strategies trade-off comparison", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "user-1",
      name: "Aryan Mittal",
      email: "mittal@company.com",
      businessId: "business-1",
      businessName: "ABC Electronics Pvt Ltd",
    });

    vi.mocked(prisma.business.findUnique).mockResolvedValue({
      id: "business-1",
      currentCash: 100000000,
      transactions: [],
      invoices: [],
      payouts: [],
    } as any);

    vi.mocked(prisma.strategy.findMany).mockResolvedValue([
      {
        name: "RECOVER_AND_COLLECT",
        projectedBalance: 26000000,
        riskLevel: "LOW",
        score: 80,
        recommended: true,
        actions: JSON.stringify([{ label: "Recover failed payment", amount: 24000000 }]),
      },
      {
        name: "DO_NOTHING",
        projectedBalance: -42000000,
        riskLevel: "HIGH",
        score: 35,
        recommended: false,
        actions: JSON.stringify([]),
      },
    ] as any);

    const req = new Request("http://localhost/api/explain", {
      method: "POST",
      body: JSON.stringify({ type: "strategies" }),
    });

    const res = await handleExplain(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.narrative).toBe("Mocked AI Narrative");
    expect(runAgent).toHaveBeenCalled();
  });
});
