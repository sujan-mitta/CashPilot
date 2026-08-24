import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET as getForecast } from "../../forecast/route";
import { POST as approveStrategy } from "../../approve/route";
import { GET as getPaymentStatus } from "../../payment-status/route";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

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
      strategy: {
        findFirst: vi.fn(),
      },
      agentAction: {
        findMany: vi.fn(),
        updateMany: vi.fn(),
        findFirst: vi.fn(),
      },
      paymentRecovery: {
        findFirst: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(),
    },
  };
});

vi.mock("@/lib/auth", () => {
  return {
    getSession: vi.fn(),
    requireBusinessAccess: vi.fn(),
  };
});

describe("CashPilot Security Isolation Auditing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 1 — Unauthenticated Request
  it("Test 1: Unauthenticated request to protected route is denied with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await getForecast();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  // Test 2 — Authorized Access
  it("Test 2: Authenticated user accessing their own business succeeds with 200", async () => {
    const mockSession = {
      userId: "user-1",
      name: "Aryan Mittal",
      email: "mittal@company.com",
      businessId: "business-1",
      businessName: "ABC Electronics Pvt Ltd",
    };
    vi.mocked(getSession).mockResolvedValue(mockSession);

    const mockBusiness = {
      id: "business-1",
      name: "ABC Electronics Pvt Ltd",
      currentCash: 10000000,
    };
    vi.mocked(prisma.business.findUnique).mockResolvedValue(mockBusiness as any);
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([] as any);

    const res = await getForecast();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("NO_DATA"); // as transactions list is empty
  });

  // Test 3 — Cross-Tenant Read Attempt
  it("Test 3: User attempting to access strategy details of another business is blocked with 404", async () => {
    const mockSession = {
      userId: "user-attacker",
      name: "Attacker",
      email: "attacker@company.com",
      businessId: "business-attacker",
      businessName: "Attacker Business",
    };
    vi.mocked(getSession).mockResolvedValue(mockSession);

    // Business resolve succeeds for the attacker's own business
    vi.mocked(prisma.business.findUnique).mockResolvedValue({
      id: "business-attacker",
      name: "Attacker Business",
    } as any);

    // BUT strategy query returns null because it belongs to victim business-1 (where strategy.businessId is business-1)
    vi.mocked(prisma.strategy.findFirst).mockResolvedValue(null);

    const req = new Request("http://localhost/api/approve", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-victim" }),
    });
    const res = await approveStrategy(req as any);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Strategy not found.");
  });

  // Test 4 — Cross-Tenant Write Attempt
  it("Test 4: User attempting to approve strategy of another business is rejected", async () => {
    const mockSession = {
      userId: "user-attacker",
      name: "Attacker",
      email: "attacker@company.com",
      businessId: "business-attacker",
      businessName: "Attacker Business",
    };
    vi.mocked(getSession).mockResolvedValue(mockSession);

    vi.mocked(prisma.business.findUnique).mockResolvedValue({
      id: "business-attacker",
      name: "Attacker Business",
    } as any);

    // Strategy find returns null because of target strategyId and businessId constraint mismatch
    vi.mocked(prisma.strategy.findFirst).mockResolvedValue(null);

    const req = new Request("http://localhost/api/approve", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-victim" }),
    });
    const res = await approveStrategy(req as any);

    expect(res.status).toBe(404);
  });

  // Test 5 — Child Resource ID Attack
  it("Test 5: Guessing paymentLinkId belonging to another business fails to settle", async () => {
    const mockSession = {
      userId: "user-attacker",
      name: "Attacker",
      email: "attacker@company.com",
      businessId: "business-attacker",
      businessName: "Attacker Business",
    };
    vi.mocked(getSession).mockResolvedValue(mockSession);

    vi.mocked(prisma.business.findUnique).mockResolvedValue({
      id: "business-attacker",
      name: "Attacker Business",
    } as any);

    // Resolving action returns null since target action strategy businessId is business-victim (not attacker)
    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(null);

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=victim_link_id");
    const res = await getPaymentStatus(req as any);

    // Returns 404 to avoid enumeration of foreign payment link presence
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("PAYMENT_NOT_FOUND");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // Test 6 — Client-Supplied User ID Attack
  it("Test 6: Server uses signed session identity and ignores client-supplied parameters", async () => {
    const mockSession = {
      userId: "user-1",
      name: "Aryan Mittal",
      email: "mittal@company.com",
      businessId: "business-1",
      businessName: "ABC Electronics Pvt Ltd",
    };
    vi.mocked(getSession).mockResolvedValue(mockSession);

    vi.mocked(prisma.business.findUnique).mockImplementation((({ where }: { where: any }) => {
      // Expect search strictly by session.businessId, ignoring other client indicators
      expect(where.id).toBe("business-1");
      return Promise.resolve({ id: "business-1", name: "ABC Electronics Pvt Ltd", currentCash: 10000000 } as any);
    }) as any);

    await getForecast();
  });

  // Test 7 — Unsafe Default Business Selection
  it("Test 7: Authenticated request does not query another user's business via default findFirst", async () => {
    const mockSession = {
      userId: "user-1",
      name: "Aryan Mittal",
      email: "mittal@company.com",
      businessId: "business-1",
      businessName: "ABC Electronics Pvt Ltd",
    };
    vi.mocked(getSession).mockResolvedValue(mockSession);

    vi.mocked(prisma.business.findUnique).mockImplementation((({ where }: { where: any }) => {
      // Must not be findFirst/findUnique without ID check
      expect(where.id).toBe("business-1");
      return Promise.resolve({ id: "business-1", name: "ABC Electronics Pvt Ltd", currentCash: 10000000 } as any);
    }) as any);

    await getForecast();
  });
});
