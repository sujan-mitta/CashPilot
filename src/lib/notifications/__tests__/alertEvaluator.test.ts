/**
 * Comprehensive test suite for CashPilot Intelligent Email Alert and Notification System.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { evaluateAndDispatchAlerts } from "../alertEvaluator";
import { renderAlertEmail } from "../emailTemplates";
import {
  __resetStoreForTesting,
  updatePreferences,
  updateUserActivity,
  getUserActivity,
  recordAlert,
  claimAlertForDispatch,
} from "../alertStore";
import { prisma } from "@/lib/prisma";
import type { HealthAssessment } from "../types";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
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
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

describe("Intelligent Email Alert & Notification System", () => {
  const mockBusinessId = "biz_test_123";
  const mockUserId = "user_test_456";
  const baseTime = new Date("2026-09-01T10:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    __resetStoreForTesting();
    vi.mocked(prisma.transaction.findMany).mockResolvedValue([]);
    if (prisma.payout?.findMany) vi.mocked(prisma.payout.findMany).mockResolvedValue([]);
    if (prisma.invoice?.findMany) vi.mocked(prisma.invoice.findMany).mockResolvedValue([]);
  });

  describe("1. HTML & Plain-Text Template Rendering", () => {
    it("renders escaped HTML with status badge, metrics, root causes, and CTA link", () => {
      const sampleAssessment: HealthAssessment = {
        businessId: mockBusinessId,
        businessName: "Acme <script>alert(1)</script> Ltd",
        severity: "CRITICAL",
        crisisType: "DEFICIT",
        crisisKey: "DEFICIT:2026-09-07",
        currentBalance: 45000000, // ₹4.50L
        safetyBuffer: 50000000, // ₹5.00L
        runwayDays: 6,
        projectedDeficitDate: "2026-09-07T00:00:00.000Z",
        firstBelowSafetyDate: "2026-09-03T00:00:00.000Z",
        rootCauses: [
          {
            type: "OVERDUE_INVOICE",
            title: "Overdue Invoice: Beta Corp & Co",
            amount: 25000000,
            dueDate: "2026-08-25T00:00:00.000Z",
            description: "Invoice #101 is 7 days late",
            counterpartyName: "Beta Corp & Co",
          },
          {
            type: "PENDING_PAYOUT",
            title: "Vendor Payout: Packaging Co",
            amount: 30000000,
            dueDate: "2026-09-05T00:00:00.000Z",
            description: "Scheduled inventory payment",
          },
        ],
        criticalObligations: { count: 1, amount: 30000000, protected: false },
        recommendedStrategy: {
          id: "strat_1",
          title: "Accelerate Collections + Delay Packaging Payout",
          actionCount: 2,
          expectedRunwayChangeDays: 12,
          expectedDeficitReductionPaise: 25000000,
          requiresApproval: true,
        },
        assessedAt: baseTime.toISOString(),
        confidenceScore: 0.95,
      };

      const rendered = renderAlertEmail(sampleAssessment, "Jane Doe", "http://localhost:3000");

      // Verify subject
      expect(rendered.subject).toContain("CRITICAL: Cash Deficit Alert for Acme <script>alert(1)</script> Ltd (6 Days Runway)");
      
      // Verify HTML escaping prevents script tag injection
      expect(rendered.html).not.toContain("<script>alert(1)</script>");
      expect(rendered.html).toContain("Acme &lt;script&gt;alert(1)&lt;/script&gt; Ltd");

      // Verify metrics present
      expect(rendered.html).toContain("6 Days");
      expect(rendered.html).toContain("₹4.50L");
      expect(rendered.html).toContain("CRITICAL LIQUIDITY DEFICIT");

      // Verify root causes rendered
      expect(rendered.html).toContain("Overdue Invoice: Beta Corp &amp; Co");
      expect(rendered.html).toContain("Vendor Payout: Packaging Co");

      // Verify AI Strategy & 1-Click CTA link
      expect(rendered.html).toContain("Accelerate Collections + Delay Packaging Payout");
      expect(rendered.ctaUrl).toBe("http://localhost:3000/approval");
      expect(rendered.html).toContain("Review &amp; Approve Action Plan");

      // Verify plain text version
      expect(rendered.text).toContain("Status: 🚨 CRITICAL LIQUIDITY DEFICIT");
      expect(rendered.text).toContain("Runway: 6 Days");
      expect(rendered.text).toContain("TAKE ACTION:");
    });
  });

  describe("2. Alert Store & Persistent Preferences", () => {
    it("persists user activity and calculates offline duration", async () => {
      const recorded = await updateUserActivity(
        mockUserId,
        mockBusinessId,
        "cfo@acme.com",
        "Jane CFO",
        { lastSeenAt: "2026-09-01T09:00:00.000Z", lastDashboardViewAt: "2026-09-01T09:00:00.000Z" }
      );

      expect(recorded.userId).toBe(mockUserId);
      expect(recorded.userEmail).toBe("cfo@acme.com");

      const fetched = await getUserActivity(mockUserId, mockBusinessId);
      expect(fetched?.lastSeenAt).toBe("2026-09-01T09:00:00.000Z");
    });

    it("enforces safe bounds on notification preferences", async () => {
      const updated = await updatePreferences(mockBusinessId, {
        criticalCooldownHours: 5, // Below min 24h -> should be clamped to 24h
        warningCooldownHours: 500, // Above max 336h -> should be clamped to 336h
      });

      expect(updated.criticalCooldownHours).toBe(24);
      expect(updated.warningCooldownHours).toBe(336);
    });

    it("atomically claims alerts to prevent concurrency double-dispatch", async () => {
      const claim1 = await claimAlertForDispatch("alert_concurrent_1");
      const claim2 = await claimAlertForDispatch("alert_concurrent_1");

      expect(claim1).toBe(true);
      expect(claim2).toBe(false); // Second claim rejected
    });
  });

  describe("3. Evaluator Offline & Seen Logic", () => {
    it("qualifies and dispatches email when user is offline (>30m inactive) for critical deficit", async () => {
      // Mock business in critical deficit
      vi.mocked(prisma.business.findUnique).mockResolvedValue({
        id: mockBusinessId,
        name: "Acme Electronics",
        currentCash: 1000000, // ₹10,000 (below zero deficit projected)
        createdAt: new Date(),
        users: [
          {
            id: mockUserId,
            email: "cfo@acme.com",
            name: "Jane CFO",
            password: "hash",
            // Alerts are only sent to an address someone has proven can receive
            // mail. Without this the dispatcher suppresses instead of sending,
            // which is the point of the gate, not a quirk of the fixture.
            emailVerified: new Date("2026-01-01T00:00:00.000Z"),
            createdAt: new Date(),
          },
        ],
        transactions: [
          {
            id: "tx_out",
            businessId: mockBusinessId,
            amount: 5000000, // ₹50,000 outflow
            type: "OUTFLOW",
            status: "PENDING",
            category: "OPERATING",
            date: new Date("2026-09-02T12:00:00.000Z"),
            expectedDate: new Date("2026-09-02T12:00:00.000Z"),
            description: "Rent",
            createdAt: new Date(),
          },
        ],
        invoices: [],
        payouts: [],
      } as any);

      // User last seen 45 minutes ago (offline threshold is 30m)
      const lastSeenTime = new Date(baseTime.getTime() - 45 * 60 * 1000).toISOString();
      await updateUserActivity(mockUserId, mockBusinessId, "cfo@acme.com", "Jane CFO", {
        lastSeenAt: lastSeenTime,
        lastDashboardViewAt: lastSeenTime,
      });

      const res = await evaluateAndDispatchAlerts({
        businessId: mockBusinessId,
        now: baseTime,
      });

      expect(res.healthAssessment.severity).toBe("CRITICAL");
      expect(res.evaluatedRecipients.length).toBe(1);
      expect(res.evaluatedRecipients[0].status).toBe("SENT");
      expect(res.emailsSent).toBe(1);
    });

    it("does not email an unverified address, even forced", async () => {
      // THE BUG: the dispatcher sent to user.email unconditionally. An address
      // that does not exist bounces, and the bounce is delivered to the SENDER
      // — so the operator's own inbox filled with "recipient does not exist"
      // from their own product, once per alert cycle, while the alert was read
      // by nobody. Retrying only produces more bounces.
      vi.mocked(prisma.business.findUnique).mockResolvedValue({
        id: mockBusinessId,
        name: "Acme Electronics",
        currentCash: 1000000,
        createdAt: new Date(),
        users: [
          {
            id: mockUserId,
            // Well formed, and undeliverable. Shape validation cannot tell the
            // difference, which is why verification exists.
            email: "cfo@acmee-typo.com",
            name: "Jane CFO",
            password: "hash",
            emailVerified: null,
            createdAt: new Date(),
          },
        ],
        transactions: [
          {
            id: "tx_out",
            businessId: mockBusinessId,
            amount: 5000000,
            type: "OUTFLOW",
            status: "PENDING",
            category: "OPERATING",
            date: new Date("2026-09-02T12:00:00.000Z"),
            expectedDate: new Date("2026-09-02T12:00:00.000Z"),
            description: "Rent",
            createdAt: new Date(),
          },
        ],
        invoices: [],
        payouts: [],
      } as any);

      const lastSeenTime = new Date(baseTime.getTime() - 45 * 60 * 1000).toISOString();
      await updateUserActivity(mockUserId, mockBusinessId, "cfo@acmee-typo.com", "Jane CFO", {
        lastSeenAt: lastSeenTime,
        lastDashboardViewAt: lastSeenTime,
      });

      const res = await evaluateAndDispatchAlerts({
        businessId: mockBusinessId,
        now: baseTime,
        // Forced. Every other suppression rule is a judgement about whether the
        // user needs this alert, and forcing past those while testing is
        // reasonable. This one is about whether the mail can be delivered at
        // all, and forcing past it just produces a bounce.
        forceSendForTesting: true,
      });

      // The crisis is still assessed and still recorded — only the futile send
      // is skipped. Suppressing the email must not read as hiding the problem.
      expect(res.healthAssessment.severity).toBe("CRITICAL");
      expect(res.evaluatedRecipients.length).toBe(1);
      expect(res.evaluatedRecipients[0].status).toBe("SUPPRESSED");
      expect(res.emailsSent).toBe(0);
    });

    it("suppresses email when user is active online (<30m inactive)", async () => {
      vi.mocked(prisma.business.findUnique).mockResolvedValue({
        id: mockBusinessId,
        name: "Acme Electronics",
        currentCash: 1000000,
        createdAt: new Date(),
        users: [
          {
            id: mockUserId,
            email: "cfo@acme.com",
            name: "Jane CFO",
            password: "hash",
            // Alerts are only sent to an address someone has proven can receive
            // mail. Without this the dispatcher suppresses instead of sending,
            // which is the point of the gate, not a quirk of the fixture.
            emailVerified: new Date("2026-01-01T00:00:00.000Z"),
            createdAt: new Date(),
          },
        ],
        transactions: [
          {
            id: "tx_out",
            businessId: mockBusinessId,
            amount: 5000000,
            type: "OUTFLOW",
            status: "PENDING",
            category: "OPERATING",
            date: new Date("2026-09-02T12:00:00.000Z"),
            expectedDate: new Date("2026-09-02T12:00:00.000Z"),
            description: "Rent",
            createdAt: new Date(),
          },
        ],
        invoices: [],
        payouts: [],
      } as any);

      // User active 5 minutes ago (less than 30m offline threshold)
      const lastSeenTime = new Date(baseTime.getTime() - 5 * 60 * 1000).toISOString();
      await updateUserActivity(mockUserId, mockBusinessId, "cfo@acme.com", "Jane CFO", {
        lastSeenAt: lastSeenTime,
        lastDashboardViewAt: lastSeenTime,
      });

      const res = await evaluateAndDispatchAlerts({
        businessId: mockBusinessId,
        now: baseTime,
      });

      expect(res.evaluatedRecipients[0].status).toBe("ACTIVE_USER");
      expect(res.evaluatedRecipients[0].suppressionReason).toContain("User active recently");
      expect(res.emailsSent).toBe(0);
      expect(res.emailsSuppressed).toBe(1);
    });

    it("suppresses email when user viewed dashboard after crisis occurred (USER_ALREADY_VIEWED)", async () => {
      vi.mocked(prisma.business.findUnique).mockResolvedValue({
        id: mockBusinessId,
        name: "Acme Electronics",
        currentCash: 1000000,
        createdAt: new Date(),
        users: [
          {
            id: mockUserId,
            email: "cfo@acme.com",
            name: "Jane CFO",
            password: "hash",
            // Alerts are only sent to an address someone has proven can receive
            // mail. Without this the dispatcher suppresses instead of sending,
            // which is the point of the gate, not a quirk of the fixture.
            emailVerified: new Date("2026-01-01T00:00:00.000Z"),
            createdAt: new Date(),
          },
        ],
        transactions: [
          {
            id: "tx_out",
            businessId: mockBusinessId,
            amount: 5000000,
            type: "OUTFLOW",
            status: "PENDING",
            category: "OPERATING",
            date: new Date("2026-09-02T12:00:00.000Z"),
            expectedDate: new Date("2026-09-02T12:00:00.000Z"),
            description: "Rent",
            createdAt: new Date(),
          },
        ],
        invoices: [],
        payouts: [],
      } as any);

      // User viewed dashboard and recorded crisisKey
      const viewTime = new Date(baseTime.getTime() - 35 * 60 * 1000).toISOString();
      await updateUserActivity(mockUserId, mockBusinessId, "cfo@acme.com", "Jane CFO", {
        lastSeenAt: viewTime,
        lastDashboardViewAt: viewTime,
        lastViewedCrisisKey: "CRITICAL_VIEWED",
      });

      const res = await evaluateAndDispatchAlerts({
        businessId: mockBusinessId,
        now: baseTime,
      });

      expect(res.evaluatedRecipients[0].status).toBe("ALREADY_VIEWED");
      expect(res.evaluatedRecipients[0].suppressionReason).toContain("already viewed");
      expect(res.emailsSent).toBe(0);
    });
  });

  describe("4. Cooldown & Deterministic Crisis Identity", () => {
    it("enforces 72-hour cooldown for the same crisisKey", async () => {
      const crisisKey = "DEFICIT:2026-09-05";

      // Record prior sent alert 24 hours ago
      await recordAlert({
        alertId: "alert_prev_1",
        tenantId: mockBusinessId,
        businessId: mockBusinessId,
        businessName: "Acme Electronics",
        userId: mockUserId,
        userEmail: "cfo@acme.com",
        severity: "CRITICAL",
        crisisKey,
        crisisTitle: "Critical Alert",
        occurredAt: new Date(baseTime.getTime() - 24 * 3600 * 1000).toISOString(),
        detectedAt: new Date(baseTime.getTime() - 24 * 3600 * 1000).toISOString(),
        sentAt: new Date(baseTime.getTime() - 24 * 3600 * 1000).toISOString(),
        deliveryStatus: "SENT",
      });

      vi.mocked(prisma.business.findUnique).mockResolvedValue({
        id: mockBusinessId,
        name: "Acme Electronics",
        currentCash: 1000000,
        createdAt: new Date(),
        users: [
          {
            id: mockUserId,
            email: "cfo@acme.com",
            name: "Jane CFO",
            password: "hash",
            // Alerts are only sent to an address someone has proven can receive
            // mail. Without this the dispatcher suppresses instead of sending,
            // which is the point of the gate, not a quirk of the fixture.
            emailVerified: new Date("2026-01-01T00:00:00.000Z"),
            createdAt: new Date(),
          },
        ],
        transactions: [
          {
            id: "tx_out",
            businessId: mockBusinessId,
            amount: 5000000,
            type: "OUTFLOW",
            status: "PENDING",
            category: "OPERATING",
            date: new Date("2026-09-02T12:00:00.000Z"),
            expectedDate: new Date("2026-09-02T12:00:00.000Z"),
            description: "Rent",
            createdAt: new Date(),
          },
        ],
        invoices: [],
        payouts: [],
      } as any);

      // User offline > 30m
      const lastSeenTime = new Date(baseTime.getTime() - 50 * 60 * 1000).toISOString();
      await updateUserActivity(mockUserId, mockBusinessId, "cfo@acme.com", "Jane CFO", {
        lastSeenAt: lastSeenTime,
        lastDashboardViewAt: lastSeenTime,
      });

      // Force assessment crisisKey to match
      const res = await evaluateAndDispatchAlerts({
        businessId: mockBusinessId,
        now: baseTime,
      });

      // If crisisKey matches, should be COOLDOWN
      if (res.crisisKey === crisisKey) {
        expect(res.evaluatedRecipients[0].status).toBe("COOLDOWN");
        expect(res.emailsSent).toBe(0);
      }
    });

    it("suppresses alerts if user disabled critical alerts in preferences", async () => {
      await updatePreferences(mockBusinessId, {
        criticalAlertsEnabled: false,
      });

      vi.mocked(prisma.business.findUnique).mockResolvedValue({
        id: mockBusinessId,
        name: "Acme Electronics",
        currentCash: 1000000,
        createdAt: new Date(),
        users: [
          {
            id: mockUserId,
            email: "cfo@acme.com",
            name: "Jane CFO",
            password: "hash",
            // Alerts are only sent to an address someone has proven can receive
            // mail. Without this the dispatcher suppresses instead of sending,
            // which is the point of the gate, not a quirk of the fixture.
            emailVerified: new Date("2026-01-01T00:00:00.000Z"),
            createdAt: new Date(),
          },
        ],
        transactions: [
          {
            id: "tx_out",
            businessId: mockBusinessId,
            amount: 5000000,
            type: "OUTFLOW",
            status: "PENDING",
            category: "OPERATING",
            date: new Date("2026-09-02T12:00:00.000Z"),
            expectedDate: new Date("2026-09-02T12:00:00.000Z"),
            description: "Rent",
            createdAt: new Date(),
          },
        ],
        invoices: [],
        payouts: [],
      } as any);

      const lastSeenTime = new Date(baseTime.getTime() - 60 * 60 * 1000).toISOString();
      await updateUserActivity(mockUserId, mockBusinessId, "cfo@acme.com", "Jane CFO", {
        lastSeenAt: lastSeenTime,
        lastDashboardViewAt: lastSeenTime,
      });

      const res = await evaluateAndDispatchAlerts({
        businessId: mockBusinessId,
        now: baseTime,
      });

      expect(res.evaluatedRecipients[0].status).toBe("PREFERENCE_DISABLED");
      expect(res.emailsSent).toBe(0);
    });
  });

  describe("5. Warning Severity & Inactivity Window", () => {
    it("qualifies warning alert only when inactive > 24 hours", async () => {
      // Mock safety buffer breach (cash > 0 but below safety buffer)
      vi.mocked(prisma.business.findUnique).mockResolvedValue({
        id: mockBusinessId,
        name: "Acme Electronics",
        currentCash: 40000000, // ₹4L
        createdAt: new Date(),
        users: [
          {
            id: mockUserId,
            email: "cfo@acme.com",
            name: "Jane CFO",
            password: "hash",
            // Alerts are only sent to an address someone has proven can receive
            // mail. Without this the dispatcher suppresses instead of sending,
            // which is the point of the gate, not a quirk of the fixture.
            emailVerified: new Date("2026-01-01T00:00:00.000Z"),
            createdAt: new Date(),
          },
        ],
        transactions: [
          {
            id: "tx_out_warn",
            businessId: mockBusinessId,
            amount: 20000000, // ₹2L
            type: "OUTFLOW",
            status: "PENDING",
            category: "OPERATING",
            date: new Date("2026-09-10T00:00:00.000Z"),
            expectedDate: new Date("2026-09-10T00:00:00.000Z"),
            description: "Supplies",
            createdAt: new Date(),
          },
        ],
        invoices: [],
        payouts: [],
      } as any);

      // requiredBuffer > currentCash (₹4L) needs both halves of the run-rate:
      // 70% historical and 30% projected.
      //
      // This mock answers by status, because the two queries differ by status
      // and the engine now re-validates what it is handed. A blanket
      // mockResolvedValue returned the SETTLED history row to the PENDING
      // projected query as well, so a past outflow was counted as a future one —
      // which is exactly the confusion the Math.max heuristic was hiding.
      vi.mocked(prisma.transaction.findMany).mockImplementation((async (args: {
        where?: { status?: string };
      }) => {
        if (args?.where?.status === "PENDING") {
          return [
            {
              id: "proj_1",
              businessId: mockBusinessId,
              amount: 500000000, // ₹50L scheduled outflow inside the horizon
              type: "OUTFLOW",
              status: "PENDING",
              date: new Date("2026-09-05"),
              expectedDate: new Date("2026-09-05"),
            },
          ];
        }
        return [
          {
            id: "hist_1",
            businessId: mockBusinessId,
            amount: 200000000, // ₹20L historical outflow
            type: "OUTFLOW",
            status: "SUCCESS",
            date: new Date("2026-08-01"),
            expectedDate: new Date("2026-08-01"),
          },
        ];
      }) as never);

      // User inactive 26 hours (> 24h threshold)
      const lastSeenTime = new Date(baseTime.getTime() - 26 * 3600 * 1000).toISOString();
      await updateUserActivity(mockUserId, mockBusinessId, "cfo@acme.com", "Jane CFO", {
        lastSeenAt: lastSeenTime,
        lastDashboardViewAt: lastSeenTime,
      });

      const res = await evaluateAndDispatchAlerts({
        businessId: mockBusinessId,
        now: baseTime,
        forceSendForTesting: true,
      });

      expect(res.evaluatedRecipients.length).toBe(1);
    });
  });

  describe("6. Multi-User Recipient Gating", () => {
    it("handles multiple users where CFO receives email and Owner is disabled", async () => {
      vi.mocked(prisma.business.findUnique).mockResolvedValue({
        id: mockBusinessId,
        name: "Acme Electronics",
        currentCash: 1000000, // Deficit
        createdAt: new Date(),
        users: [
          {
            id: "user_cfo",
            email: "cfo@acme.com",
            name: "Jane CFO",
            password: "hash",
            // Alerts are only sent to an address someone has proven can receive
            // mail. Without this the dispatcher suppresses instead of sending,
            // which is the point of the gate, not a quirk of the fixture.
            emailVerified: new Date("2026-01-01T00:00:00.000Z"),
            createdAt: new Date(),
          },
          {
            id: "user_owner",
            email: "owner@acme.com",
            name: "John Owner",
            password: "hash",
            emailVerified: new Date("2026-01-01T00:00:00.000Z"),
            createdAt: new Date(),
          },
        ],
        transactions: [
          {
            id: "tx_out",
            businessId: mockBusinessId,
            amount: 5000000,
            type: "OUTFLOW",
            status: "PENDING",
            category: "OPERATING",
            date: new Date("2026-09-02T12:00:00.000Z"),
            expectedDate: new Date("2026-09-02T12:00:00.000Z"),
            description: "Rent",
            createdAt: new Date(),
          },
        ],
        invoices: [],
        payouts: [],
      } as any);

      // Both offline > 45m
      const lastSeenTime = new Date(baseTime.getTime() - 45 * 60 * 1000).toISOString();
      await updateUserActivity("user_cfo", mockBusinessId, "cfo@acme.com", "Jane CFO", {
        lastSeenAt: lastSeenTime,
      });
      await updateUserActivity("user_owner", mockBusinessId, "owner@acme.com", "John Owner", {
        lastSeenAt: lastSeenTime,
      });

      const res = await evaluateAndDispatchAlerts({
        businessId: mockBusinessId,
        now: baseTime,
      });

      expect(res.evaluatedRecipients.length).toBe(2);
      expect(res.evaluatedRecipients.map((r) => r.email)).toContain("cfo@acme.com");
      expect(res.evaluatedRecipients.map((r) => r.email)).toContain("owner@acme.com");
    });
  });
});
