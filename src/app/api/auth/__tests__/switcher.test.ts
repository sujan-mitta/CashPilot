import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET as getBusinesses } from "../businesses/route";
import { POST as switchBusiness } from "../switch/route";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

vi.mock("@/lib/prisma", () => {
  return {
    prisma: {
      user: {
        findUnique: vi.fn(),
      },
      business: {
        findUnique: vi.fn(),
      },
    },
  };
});

vi.mock("@/lib/auth", () => {
  return {
    getSession: vi.fn(),
    signSession: vi.fn(() => "mock-new-session-token"),
    requireBusinessAccess: vi.fn(),
  };
});

vi.mock("next/headers", () => {
  return {
    cookies: vi.fn(() => ({
      set: vi.fn(),
    })),
  };
});

describe("Multi-Tenant Business Switcher API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/auth/businesses returns error 401 if unauthorized", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await getBusinesses();
    expect(res.status).toBe(401);
  });

  it("GET /api/auth/businesses returns list of linked businesses", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "user-1",
      name: "Aryan Mittal",
      email: "mittal@company.com",
      businessId: "business-1",
      businessName: "ABC Electronics Pvt Ltd",
    });

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
      businesses: [
        { id: "business-1", name: "ABC Electronics Pvt Ltd" },
        { id: "business-2", name: "Deficit Inc" },
      ],
    } as any);

    const res = await getBusinesses();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.businesses.length).toBe(2);
    expect(body.businesses[1].name).toBe("Deficit Inc");
  });

  it("POST /api/auth/switch returns error 401 if unauthorized", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const req = new Request("http://localhost/api/auth/switch", {
      method: "POST",
      body: JSON.stringify({ businessId: "business-2" }),
    });
    const res = await switchBusiness(req);
    expect(res.status).toBe(401);
  });

  it("POST /api/auth/switch blocks request with 403 if user is not authorized for targeted business", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "user-1",
      name: "Aryan Mittal",
      email: "mittal@company.com",
      businessId: "business-1",
      businessName: "ABC Electronics Pvt Ltd",
    });

    const { requireBusinessAccess } = await import("@/lib/auth");
    vi.mocked(requireBusinessAccess).mockResolvedValue(false);

    const req = new Request("http://localhost/api/auth/switch", {
      method: "POST",
      body: JSON.stringify({ businessId: "business-unauthorized" }),
    });
    const res = await switchBusiness(req);
    expect(res.status).toBe(403);
  });

  it("POST /api/auth/switch transitions session and sets updated cookie if authorized", async () => {
    vi.mocked(getSession).mockResolvedValue({
      userId: "user-1",
      name: "Aryan Mittal",
      email: "mittal@company.com",
      businessId: "business-1",
      businessName: "ABC Electronics Pvt Ltd",
    });

    const { requireBusinessAccess } = await import("@/lib/auth");
    vi.mocked(requireBusinessAccess).mockResolvedValue(true);

    vi.mocked(prisma.business.findUnique).mockResolvedValue({
      id: "business-2",
      name: "Deficit Inc",
    } as any);

    const req = new Request("http://localhost/api/auth/switch", {
      method: "POST",
      body: JSON.stringify({ businessId: "business-2" }),
    });
    const res = await switchBusiness(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.user.businessName).toBe("Deficit Inc");
    expect(body.user.businessId).toBe("business-2");
  });
});
