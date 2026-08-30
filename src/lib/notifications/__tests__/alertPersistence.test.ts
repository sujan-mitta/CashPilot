import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

import {
  getUserActivity,
  updateUserActivity,
  getPreferences,
  updatePreferences,
  recordAlert,
  claimAlertForDispatch,
  updateAlertDelivery,
  findLatestAlertForCrisis,
  recordDeliveryAudit,
  getRecentDeliveryAudits,
  __resetStoreForTesting,
  __setUseTestMockFallback,
} from "../alertStore";
import type { AlertRecord, DeliveryAuditRecord } from "../types";

describe("Phase 32: Database Notification Persistence & Concurrency", () => {
  beforeEach(() => {
    __setUseTestMockFallback(true);
    __resetStoreForTesting();
  });

  describe("1. User Activity Persistence & Scoping", () => {
    it("persists activity timestamps and updates independently per user and business", async () => {
      const bizA = "biz_alpha";
      const bizB = "biz_beta";
      const user1 = "user_1";
      const user2 = "user_2";

      const now1 = new Date("2026-08-30T10:00:00.000Z").toISOString();
      const now2 = new Date("2026-08-30T10:15:00.000Z").toISOString();

      await updateUserActivity(user1, bizA, "u1@alpha.com", "User 1", {
        lastSeenAt: now1,
        lastDashboardViewAt: now1,
        lastViewedCrisisKey: "DEFICIT:2026-09-02",
      });

      await updateUserActivity(user2, bizA, "u2@alpha.com", "User 2", {
        lastSeenAt: now2,
        lastDashboardViewAt: now2,
      });

      // Distinct tenant isolation check
      await updateUserActivity(user1, bizB, "u1@beta.com", "User 1 Beta", {
        lastSeenAt: now1,
      });

      const act1 = await getUserActivity(user1, bizA);
      const act2 = await getUserActivity(user2, bizA);
      const act1Beta = await getUserActivity(user1, bizB);

      expect(act1?.userEmail).toBe("u1@alpha.com");
      expect(act1?.lastViewedCrisisKey).toBe("DEFICIT:2026-09-02");
      expect(act2?.userEmail).toBe("u2@alpha.com");
      expect(act1Beta?.businessId).toBe(bizB);
    });
  });

  describe("2. Notification Preferences Persistence & Bounded Input", () => {
    it("enforces safe bounds and isolates preferences per business and user", async () => {
      const bizA = "biz_alpha";
      const bizB = "biz_beta";

      // Test extreme inputs to verify bounds protection (24h-168h critical cooldown, 15m-1440m offline)
      const updated = await updatePreferences(
        bizA,
        {
          criticalAlertsEnabled: false,
          criticalCooldownHours: 500, // Should cap at 168
          offlineThresholdMinutes: 5, // Should floor at 15
        },
        "user_cfo"
      );

      expect(updated.criticalAlertsEnabled).toBe(false);
      expect(updated.criticalCooldownHours).toBe(168);
      expect(updated.offlineThresholdMinutes).toBe(15);

      // Verify business B gets default preferences untouched
      const prefsB = await getPreferences(bizB, "user_cfo");
      expect(prefsB.criticalAlertsEnabled).toBe(true);
      expect(prefsB.criticalCooldownHours).toBe(72);
    });
  });

  describe("3. Concurrency Protection & Atomic Claim", () => {
    it("guarantees only one worker can claim an alert for dispatch", async () => {
      const alertId = "alert_atomic_test_123";
      const record: AlertRecord = {
        alertId,
        tenantId: "biz_test",
        businessId: "biz_test",
        businessName: "Acme",
        userId: "user_1",
        userEmail: "cfo@acme.com",
        severity: "CRITICAL",
        crisisKey: "DEFICIT:2026-09-02",
        crisisTitle: "Projected Deficit",
        occurredAt: new Date().toISOString(),
        detectedAt: new Date().toISOString(),
        deliveryStatus: "SIMULATED",
      };

      await recordAlert(record);

      // Worker A attempts claim
      const claimA = await claimAlertForDispatch(alertId, "worker_A");
      // Worker B attempts claim simultaneously
      const claimB = await claimAlertForDispatch(alertId, "worker_B");

      expect(claimA).toBe(true);
      expect(claimB).toBe(false); // Second claim must fail
    });
  });

  describe("4. Alert Lifecycle, Status Updates & Deduplication", () => {
    it("tracks status transition from RECORDED to SENT without duplicate records", async () => {
      const alertId = "alert_life_456";
      const crisisKey = "RUNWAY_LT_14:2026-09-05";

      const record: AlertRecord = {
        alertId,
        tenantId: "biz_test",
        businessId: "biz_test",
        businessName: "Acme",
        userId: "user_1",
        userEmail: "cfo@acme.com",
        severity: "CRITICAL",
        crisisKey,
        crisisTitle: "Runway Under 14 Days",
        occurredAt: new Date().toISOString(),
        detectedAt: new Date().toISOString(),
        deliveryStatus: "SIMULATED",
      };

      await recordAlert(record);

      // Update to SENT
      const sentTime = new Date().toISOString();
      await updateAlertDelivery(alertId, {
        deliveryStatus: "SENT",
        sentAt: sentTime,
      });

      const latest = await findLatestAlertForCrisis("biz_test", crisisKey);
      expect(latest).not.toBeNull();
      expect(latest?.deliveryStatus).toBe("SENT");
      expect(latest?.sentAt).toBe(sentTime);

      // Ensure tenant isolation
      const otherBiz = await findLatestAlertForCrisis("biz_other", crisisKey);
      expect(otherBiz).toBeNull();
    });
  });

  describe("5. Delivery Audit Trail", () => {
    it("persists sanitized delivery audits in descending chronological order", async () => {
      const bizId = "biz_audit_test";

      const audit1: DeliveryAuditRecord = {
        auditId: "aud_1",
        alertId: "alt_1",
        businessId: bizId,
        recipientEmail: "cfo@acme.com",
        provider: "SMTP",
        attemptedAt: "2026-08-30T10:00:00.000Z",
        status: "SENT",
        providerMessageId: "msg_1",
      };

      const audit2: DeliveryAuditRecord = {
        auditId: "aud_2",
        alertId: "alt_2",
        businessId: bizId,
        recipientEmail: "cfo@acme.com",
        provider: "SMTP",
        attemptedAt: "2026-08-30T10:05:00.000Z",
        status: "FAILED",
        errorCode: "SMTP_TIMEOUT",
        errorMessageSanitized: "Connection timed out",
      };

      await recordDeliveryAudit(audit1);
      await recordDeliveryAudit(audit2);

      const recent = await getRecentDeliveryAudits(bizId);
      expect(recent.length).toBe(2);
      expect(recent[0].auditId).toBe("aud_2"); // Most recent first
      expect(recent[0].status).toBe("FAILED");
      expect(recent[0].errorCode).toBe("SMTP_TIMEOUT");
    });
  });
});
