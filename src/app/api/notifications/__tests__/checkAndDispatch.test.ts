import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";

// Mock dependencies before importing route
vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/notifications/alertEvaluator", () => ({
  evaluateAndDispatchAlerts: vi.fn(),
}));

import { GET, POST } from "../check-and-dispatch/route";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { evaluateAndDispatchAlerts } from "@/lib/notifications/alertEvaluator";

describe("Phase 33: Production Scheduler & Dispatch Authorization", () => {
  const mockCronSecret = "test_cron_secret_abcdef123456";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = mockCronSecret;
  });

  describe("1. Vercel Cron Configuration Verification", () => {
    it("verifies vercel.json contains valid 10-minute cron configuration for check-and-dispatch", () => {
      const vercelJsonPath = path.resolve(process.cwd(), "vercel.json");
      expect(fs.existsSync(vercelJsonPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(vercelJsonPath, "utf-8"));
      expect(content.crons).toBeDefined();
      expect(Array.isArray(content.crons)).toBe(true);
      expect(content.crons.length).toBe(1);

      const cronEntry = content.crons[0];
      expect(cronEntry.path).toBe("/api/notifications/check-and-dispatch");
      expect(cronEntry.schedule).toBe("*/10 * * * *");
    });
  });

  describe("2. Cron Authentication & Authorization", () => {
    it("authorizes GET request with Bearer CRON_SECRET header (Vercel Cron standard)", async () => {
      vi.mocked(prisma.business.findMany).mockResolvedValue([{ id: "biz_1" }, { id: "biz_2" }] as any);
      vi.mocked(evaluateAndDispatchAlerts).mockResolvedValue({
        businessId: "biz_1",
        businessName: "Acme",
        assessedAt: new Date().toISOString(),
        healthAssessment: { severity: "HEALTHY" } as any,
        evaluationStatus: "SUPPRESSED",
        evaluatedRecipients: [],
        crisisKey: null,
        emailsAttempted: 0,
        emailsSent: 0,
        emailsSuppressed: 0,
      });

      const req = new Request("http://localhost:3000/api/notifications/check-and-dispatch", {
        method: "GET",
        headers: {
          authorization: `Bearer ${mockCronSecret}`,
        },
      });

      const res = await GET(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.invoker).toBe("CRON_SCHEDULER");
      expect(data.evaluatedCount).toBe(2);
    });

    it("authorizes POST request with x-cron-secret header", async () => {
      vi.mocked(prisma.business.findMany).mockResolvedValue([{ id: "biz_1" }] as any);
      vi.mocked(evaluateAndDispatchAlerts).mockResolvedValue({
        businessId: "biz_1",
        businessName: "Acme",
        assessedAt: new Date().toISOString(),
        healthAssessment: { severity: "HEALTHY" } as any,
        evaluationStatus: "SUPPRESSED",
        evaluatedRecipients: [],
        crisisKey: null,
        emailsAttempted: 0,
        emailsSent: 0,
        emailsSuppressed: 0,
      });

      const req = new Request("http://localhost:3000/api/notifications/check-and-dispatch", {
        method: "POST",
        headers: {
          "x-cron-secret": mockCronSecret,
          "content-type": "application/json",
        },
        body: JSON.stringify({ businessId: "biz_1" }),
      });

      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.invoker).toBe("CRON_SCHEDULER");
      expect(data.evaluatedCount).toBe(1);
    });

    it("rejects unauthorized request with invalid secret and no user session", async () => {
      vi.mocked(getSession).mockResolvedValue(null as any);

      const req = new Request("http://localhost:3000/api/notifications/check-and-dispatch", {
        method: "GET",
        headers: {
          authorization: "Bearer wrong_secret",
        },
      });

      const res = await GET(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain("Unauthorized");
    });

    it("authorizes authenticated user session when cron secret is absent", async () => {
      vi.mocked(getSession).mockResolvedValue({
        userId: "user_123",
        businessId: "biz_tenant_1",
      } as any);

      vi.mocked(evaluateAndDispatchAlerts).mockResolvedValue({
        businessId: "biz_tenant_1",
        businessName: "Tenant 1",
        assessedAt: new Date().toISOString(),
        healthAssessment: { severity: "HEALTHY" } as any,
        evaluationStatus: "SUPPRESSED",
        evaluatedRecipients: [],
        crisisKey: null,
        emailsAttempted: 0,
        emailsSent: 0,
        emailsSuppressed: 0,
      });

      const req = new Request("http://localhost:3000/api/notifications/check-and-dispatch", {
        method: "POST",
      });

      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.invoker).toBe("AUTHENTICATED_USER");
      expect(data.evaluatedCount).toBe(1);
    });
  });

  describe("3. Telemetry & Execution Summary", () => {
    it("returns detailed metrics including sent, suppressed, failed counts and durationMs", async () => {
      vi.mocked(prisma.business.findMany).mockResolvedValue([{ id: "biz_1" }] as any);
      vi.mocked(evaluateAndDispatchAlerts).mockResolvedValue({
        businessId: "biz_1",
        businessName: "Acme",
        assessedAt: new Date().toISOString(),
        healthAssessment: { severity: "CRITICAL" } as any,
        evaluationStatus: "SENT",
        evaluatedRecipients: [
          { userId: "u1", email: "cfo@acme.com", status: "SENT" },
        ],
        crisisKey: "DEFICIT:2026-09-02",
        emailsAttempted: 1,
        emailsSent: 1,
        emailsSuppressed: 0,
      });

      const req = new Request("http://localhost:3000/api/notifications/check-and-dispatch", {
        method: "GET",
        headers: {
          authorization: `Bearer ${mockCronSecret}`,
        },
      });

      const res = await GET(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.totalEmailsSent).toBe(1);
      expect(data.totalEmailsSuppressed).toBe(0);
      expect(data.totalFailed).toBe(0);
      expect(typeof data.durationMs).toBe("number");
    });
  });
});
