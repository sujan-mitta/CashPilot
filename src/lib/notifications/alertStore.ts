/**
 * Production PostgreSQL / Prisma Persistent Alert & Activity Store for CashPilot.
 *
 * Persists:
 * - User activity timestamps (lastSeenAt, lastDashboardViewAt, lastViewedCrisisKey)
 * - Sent alerts history & deterministic crisis keys
 * - Delivery audit logs
 * - Per-tenant & per-user notification preferences
 * - Atomic database-backed dispatch claims for multi-worker concurrency safety
 *
 * Implements fallback for isolated test environments.
 */

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability";
import type {
  AlertRecord,
  DeliveryAuditRecord,
  NotificationPreferences,
  UserActivity,
} from "./types";

const DEFAULT_PREFERENCES: NotificationPreferences = {
  criticalAlertsEnabled: true,
  warningAlertsEnabled: true,
  weeklyDigestEnabled: true,
  criticalCooldownHours: 72,
  warningCooldownHours: 168,
  offlineThresholdMinutes: 30,
};

// Defensive in-memory state used only during unit testing / isolated mock mode
interface InMemoryTestState {
  activities: Record<string, UserActivity>;
  alerts: AlertRecord[];
  deliveryAudits: DeliveryAuditRecord[];
  preferences: Record<string, NotificationPreferences>;
  claimedAlertIds: Record<string, string>;
}

let testStore: InMemoryTestState = {
  activities: {},
  alerts: [],
  deliveryAudits: [],
  preferences: {},
  claimedAlertIds: {},
};

let useTestMockFallback = false;

export function __setUseTestMockFallback(enabled: boolean): void {
  useTestMockFallback = enabled;
}

export function __resetStoreForTesting(): void {
  testStore = {
    activities: {},
    alerts: [],
    deliveryAudits: [],
    preferences: {},
    claimedAlertIds: {},
  };
}

// ── 1. User Activity ────────────────────────────────────────────────────────

/**
 * Retrieves user activity for a specific user and business.
 */
export async function getUserActivity(
  userId: string,
  businessId: string
): Promise<UserActivity | null> {
  if (useTestMockFallback || !prisma?.userActivityRecord) {
    const key = `${businessId}:${userId}`;
    return testStore.activities[key] || null;
  }

  try {
    const record = await prisma.userActivityRecord.findUnique({
      where: {
        businessId_userId: { businessId, userId },
      },
    });

    if (!record) return null;

    const seenIso = record.lastSeenAt.toISOString();
    return {
      userId: record.userId,
      businessId: record.businessId,
      userEmail: record.userEmail ?? "",
      userName: record.userName ?? "",
      lastSeenAt: seenIso,
      lastDashboardViewAt: record.lastDashboardViewAt.toISOString(),
      lastActivityAt: seenIso,
      lastViewedCrisisKey: record.lastViewedCrisisKey,
    };
  } catch (err) {
    logger.warn("Falling back to in-memory activity lookup", { error: String(err) });
    const key = `${businessId}:${userId}`;
    return testStore.activities[key] || null;
  }
}

/**
 * Updates user activity and last dashboard view timestamps in PostgreSQL.
 */
export async function updateUserActivity(
  userId: string,
  businessId: string,
  userEmail: string,
  userName: string | undefined,
  updates: Partial<Pick<UserActivity, "lastSeenAt" | "lastDashboardViewAt" | "lastViewedCrisisKey">>
): Promise<UserActivity> {
  const now = new Date();
  const lastSeenAtDate = updates.lastSeenAt ? new Date(updates.lastSeenAt) : now;
  const lastDashboardViewAtDate = updates.lastDashboardViewAt ? new Date(updates.lastDashboardViewAt) : now;
  const nameString = userName ?? "";

  if (useTestMockFallback || !prisma?.userActivityRecord) {
    const key = `${businessId}:${userId}`;
    const existing = testStore.activities[key] || {
      userId,
      businessId,
      userEmail,
      userName: nameString,
      lastSeenAt: now.toISOString(),
      lastDashboardViewAt: now.toISOString(),
      lastActivityAt: now.toISOString(),
    };

    const updated: UserActivity = {
      ...existing,
      userEmail,
      userName: nameString || existing.userName,
      lastSeenAt: updates.lastSeenAt ?? existing.lastSeenAt,
      lastDashboardViewAt: updates.lastDashboardViewAt ?? existing.lastDashboardViewAt,
      lastActivityAt: updates.lastSeenAt ?? existing.lastActivityAt,
      lastViewedCrisisKey: updates.lastViewedCrisisKey ?? existing.lastViewedCrisisKey,
    };

    testStore.activities[key] = updated;
    return updated;
  }

  try {
    const upserted = await prisma.userActivityRecord.upsert({
      where: {
        businessId_userId: { businessId, userId },
      },
      create: {
        userId,
        businessId,
        userEmail,
        userName: nameString,
        lastSeenAt: lastSeenAtDate,
        lastDashboardViewAt: lastDashboardViewAtDate,
        lastViewedCrisisKey: updates.lastViewedCrisisKey,
      },
      update: {
        userEmail,
        userName: nameString || undefined,
        ...(updates.lastSeenAt ? { lastSeenAt: lastSeenAtDate } : {}),
        ...(updates.lastDashboardViewAt ? { lastDashboardViewAt: lastDashboardViewAtDate } : {}),
        ...(updates.lastViewedCrisisKey !== undefined
          ? { lastViewedCrisisKey: updates.lastViewedCrisisKey }
          : {}),
      },
    });

    const seenIso = upserted.lastSeenAt.toISOString();
    return {
      userId: upserted.userId,
      businessId: upserted.businessId,
      userEmail: upserted.userEmail ?? userEmail,
      userName: upserted.userName ?? nameString,
      lastSeenAt: seenIso,
      lastDashboardViewAt: upserted.lastDashboardViewAt.toISOString(),
      lastActivityAt: seenIso,
      lastViewedCrisisKey: upserted.lastViewedCrisisKey,
    };
  } catch (err) {
    logger.warn("Falling back to in-memory activity update", { error: String(err) });
    const key = `${businessId}:${userId}`;
    const seenIso = updates.lastSeenAt ?? now.toISOString();
    const fallback: UserActivity = {
      userId,
      businessId,
      userEmail,
      userName: nameString,
      lastSeenAt: seenIso,
      lastDashboardViewAt: updates.lastDashboardViewAt ?? now.toISOString(),
      lastActivityAt: seenIso,
      lastViewedCrisisKey: updates.lastViewedCrisisKey ?? null,
    };
    testStore.activities[key] = fallback;
    return fallback;
  }
}

/**
 * Returns all user activities for a business.
 */
export async function getBusinessUserActivities(businessId: string): Promise<UserActivity[]> {
  if (useTestMockFallback || !prisma?.userActivityRecord) {
    return Object.values(testStore.activities).filter((a) => a.businessId === businessId);
  }

  try {
    const records = await prisma.userActivityRecord.findMany({
      where: { businessId },
    });

    return records.map((r) => ({
      userId: r.userId,
      businessId: r.businessId,
      userEmail: r.userEmail ?? "",
      userName: r.userName ?? "",
      lastSeenAt: r.lastSeenAt.toISOString(),
      lastDashboardViewAt: r.lastDashboardViewAt.toISOString(),
      lastActivityAt: r.lastSeenAt.toISOString(),
      lastViewedCrisisKey: r.lastViewedCrisisKey,
    }));
  } catch (err) {
    logger.warn("Falling back to in-memory activities list", { error: String(err) });
    return Object.values(testStore.activities).filter((a) => a.businessId === businessId);
  }
}

// ── 2. Notification Preferences ─────────────────────────────────────────────

/**
 * Retrieves notification preferences for a business and user.
 */
export async function getPreferences(
  businessId: string,
  userId?: string
): Promise<NotificationPreferences> {
  const targetUserId = userId || "default";

  if (useTestMockFallback || !prisma?.notificationPreference) {
    const key = `${businessId}:${targetUserId}`;
    const legacyBizKey = businessId;
    return testStore.preferences[key] || testStore.preferences[legacyBizKey] || { ...DEFAULT_PREFERENCES };
  }

  try {
    const record = await prisma.notificationPreference.findFirst({
      where: {
        businessId,
        ...(userId ? { userId } : {}),
      },
      orderBy: { updatedAt: "desc" },
    });

    if (!record) {
      return { ...DEFAULT_PREFERENCES };
    }

    return {
      criticalAlertsEnabled: record.criticalEmailEnabled,
      warningAlertsEnabled: record.warningEmailEnabled,
      weeklyDigestEnabled: record.weeklyDigestEnabled,
      criticalCooldownHours: record.criticalCooldownHours,
      warningCooldownHours: record.warningCooldownHours,
      offlineThresholdMinutes: record.offlineThresholdMinutes,
      recipientEmail: record.recipientEmail ?? undefined,
    };
  } catch (err) {
    logger.warn("Falling back to in-memory preferences lookup", { error: String(err) });
    return testStore.preferences[`${businessId}:${targetUserId}`] || { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Updates notification preferences with safe bounds checking.
 */
export async function updatePreferences(
  businessId: string,
  updates: Partial<NotificationPreferences>,
  userId?: string
): Promise<NotificationPreferences> {
  const targetUserId = userId || "default";
  const current = await getPreferences(businessId, targetUserId);

  const boundedCriticalCooldown = updates.criticalCooldownHours !== undefined
    ? Math.max(24, Math.min(168, updates.criticalCooldownHours))
    : current.criticalCooldownHours;

  const boundedWarningCooldown = updates.warningCooldownHours !== undefined
    ? Math.max(48, Math.min(336, updates.warningCooldownHours))
    : current.warningCooldownHours;

  const boundedOfflineMinutes = updates.offlineThresholdMinutes !== undefined
    ? Math.max(15, Math.min(1440, updates.offlineThresholdMinutes))
    : current.offlineThresholdMinutes;

  const updatedPrefs: NotificationPreferences = {
    criticalAlertsEnabled: updates.criticalAlertsEnabled ?? current.criticalAlertsEnabled,
    warningAlertsEnabled: updates.warningAlertsEnabled ?? current.warningAlertsEnabled,
    weeklyDigestEnabled: updates.weeklyDigestEnabled ?? current.weeklyDigestEnabled,
    criticalCooldownHours: boundedCriticalCooldown,
    warningCooldownHours: boundedWarningCooldown,
    offlineThresholdMinutes: boundedOfflineMinutes,
    recipientEmail: updates.recipientEmail ?? current.recipientEmail,
  };

  if (useTestMockFallback || !prisma?.notificationPreference) {
    testStore.preferences[`${businessId}:${targetUserId}`] = updatedPrefs;
    testStore.preferences[businessId] = updatedPrefs;
    return updatedPrefs;
  }

  try {
    await prisma.notificationPreference.upsert({
      where: {
        businessId_userId: { businessId, userId: targetUserId },
      },
      create: {
        businessId,
        userId: targetUserId,
        criticalEmailEnabled: updatedPrefs.criticalAlertsEnabled,
        warningEmailEnabled: updatedPrefs.warningAlertsEnabled,
        weeklyDigestEnabled: updatedPrefs.weeklyDigestEnabled,
        criticalCooldownHours: updatedPrefs.criticalCooldownHours,
        warningCooldownHours: updatedPrefs.warningCooldownHours,
        offlineThresholdMinutes: updatedPrefs.offlineThresholdMinutes,
        recipientEmail: updatedPrefs.recipientEmail,
      },
      update: {
        criticalEmailEnabled: updatedPrefs.criticalAlertsEnabled,
        warningEmailEnabled: updatedPrefs.warningAlertsEnabled,
        weeklyDigestEnabled: updatedPrefs.weeklyDigestEnabled,
        criticalCooldownHours: updatedPrefs.criticalCooldownHours,
        warningCooldownHours: updatedPrefs.warningCooldownHours,
        offlineThresholdMinutes: updatedPrefs.offlineThresholdMinutes,
        recipientEmail: updatedPrefs.recipientEmail,
      },
    });

    return updatedPrefs;
  } catch (err) {
    logger.warn("Falling back to in-memory preferences update", { error: String(err) });
    testStore.preferences[`${businessId}:${targetUserId}`] = updatedPrefs;
    return updatedPrefs;
  }
}

// ── 3. Alert Records & Lifecycle ─────────────────────────────────────────────

/**
 * Records a new alert decision in PostgreSQL.
 */
export async function recordAlert(record: AlertRecord): Promise<AlertRecord> {
  if (useTestMockFallback || !prisma?.notificationAlertRecord) {
    testStore.alerts.unshift(record);
    if (testStore.alerts.length > 500) {
      testStore.alerts = testStore.alerts.slice(0, 500);
    }
    return record;
  }

  try {
    await prisma.notificationAlertRecord.create({
      data: {
        id: record.alertId,
        tenantId: record.tenantId || record.businessId,
        businessId: record.businessId,
        userId: record.userId,
        severity: record.severity,
        crisisKey: record.crisisKey,
        crisisTitle: record.crisisTitle,
        occurredAt: new Date(record.occurredAt),
        detectedAt: new Date(record.detectedAt),
        viewedAt: record.viewedAt ? new Date(record.viewedAt) : null,
        emailEligibleAt: record.emailEligibleAt ? new Date(record.emailEligibleAt) : null,
        sentAt: record.sentAt ? new Date(record.sentAt) : null,
        deliveryStatus: record.deliveryStatus,
        suppressionReason: record.suppressionReason,
        renderedSubject: record.renderedSubject,
      },
    });

    return record;
  } catch (err) {
    logger.warn("Falling back to in-memory alert record", { error: String(err) });
    testStore.alerts.unshift(record);
    return record;
  }
}

/**
 * Atomically claims an alert for dispatch in PostgreSQL using atomic update semantics.
 *
 * Guarantees that only ONE worker process across multiple serverless/cluster instances
 * can claim and dispatch an alert.
 */
export async function claimAlertForDispatch(alertId: string, workerId?: string): Promise<boolean> {
  const now = new Date();
  const workerTag = workerId || `worker_${process.pid}_${now.getTime()}`;

  if (useTestMockFallback || !prisma?.notificationAlertRecord) {
    if (testStore.claimedAlertIds[alertId]) {
      return false; // Already claimed
    }
    testStore.claimedAlertIds[alertId] = now.toISOString();
    return true;
  }

  try {
    // Atomic update: only update if claimedAt is null
    const result = await prisma.notificationAlertRecord.updateMany({
      where: {
        id: alertId,
        claimedAt: null,
      },
      data: {
        claimedAt: now,
        claimedByWorker: workerTag,
        deliveryStatus: "CLAIMED",
      },
    });

    return result.count > 0;
  } catch (err) {
    // FAIL CLOSED. The in-memory fallback that used to live here granted the
    // claim, which is the one answer this function must never invent.
    //
    // The store is per-process, and on serverless every concurrent invocation
    // is a different process with an empty one. So a transient database fault
    // made every worker believe it held the exclusive claim, and N workers sent
    // N copies of the same email — exactly when the database is unhealthy and
    // retries are most likely.
    //
    // A refused claim costs one delayed alert, recovered on the next scheduled
    // evaluation. A duplicate email cannot be recalled.
    logger.error("Dispatch claim unavailable; refusing to claim", {
      alertId,
      error: String(err),
    });
    return false;
  }
}

/**
 * Updates delivery status of an existing alert.
 */
export async function updateAlertDelivery(
  alertId: string,
  update: Partial<AlertRecord>
): Promise<AlertRecord | null> {
  if (useTestMockFallback || !prisma?.notificationAlertRecord) {
    const alert = testStore.alerts.find((a) => a.alertId === alertId);
    if (!alert) return null;
    Object.assign(alert, update);
    return alert;
  }

  try {
    const updated = await prisma.notificationAlertRecord.update({
      where: { id: alertId },
      data: {
        deliveryStatus: update.deliveryStatus,
        sentAt: update.sentAt ? new Date(update.sentAt) : undefined,
        suppressionReason: update.suppressionReason,
      },
    });

    return {
      alertId: updated.id,
      tenantId: updated.tenantId,
      businessId: updated.businessId,
      businessName: "",
      userId: updated.userId,
      userEmail: "",
      severity: updated.severity as AlertRecord["severity"],
      crisisKey: updated.crisisKey,
      crisisTitle: updated.crisisTitle ?? "",
      occurredAt: updated.occurredAt.toISOString(),
      detectedAt: updated.detectedAt.toISOString(),
      viewedAt: updated.viewedAt?.toISOString() ?? null,
      emailEligibleAt: updated.emailEligibleAt?.toISOString() ?? null,
      sentAt: updated.sentAt?.toISOString() ?? null,
      deliveryStatus: updated.deliveryStatus as AlertRecord["deliveryStatus"],
      suppressionReason: updated.suppressionReason ?? undefined,
      renderedSubject: updated.renderedSubject ?? undefined,
    };
  } catch (err) {
    logger.warn("Falling back to in-memory alert update", { error: String(err) });
    const alert = testStore.alerts.find((a) => a.alertId === alertId);
    if (!alert) return null;
    Object.assign(alert, update);
    return alert;
  }
}

/**
 * Finds the latest sent alert for a crisis key in a business.
 */
export async function findLatestAlertForCrisis(
  businessId: string,
  crisisKey: string
): Promise<AlertRecord | null> {
  if (useTestMockFallback || !prisma?.notificationAlertRecord) {
    const match = testStore.alerts.find(
      (a) =>
        a.businessId === businessId &&
        a.crisisKey === crisisKey &&
        (a.deliveryStatus === "SENT" || a.deliveryStatus === "ACCEPTED" || a.deliveryStatus === "SIMULATED")
    );
    return match ?? null;
  }

  try {
    const record = await prisma.notificationAlertRecord.findFirst({
      where: {
        businessId,
        crisisKey,
        deliveryStatus: {
          in: ["SENT", "ACCEPTED", "SIMULATED"],
        },
      },
      orderBy: { sentAt: "desc" },
    });

    if (!record) return null;

    return {
      alertId: record.id,
      tenantId: record.tenantId,
      businessId: record.businessId,
      businessName: "",
      userId: record.userId,
      userEmail: "",
      severity: record.severity as AlertRecord["severity"],
      crisisKey: record.crisisKey,
      crisisTitle: record.crisisTitle ?? "",
      occurredAt: record.occurredAt.toISOString(),
      detectedAt: record.detectedAt.toISOString(),
      viewedAt: record.viewedAt?.toISOString() ?? null,
      emailEligibleAt: record.emailEligibleAt?.toISOString() ?? null,
      sentAt: record.sentAt?.toISOString() ?? null,
      deliveryStatus: record.deliveryStatus as AlertRecord["deliveryStatus"],
      suppressionReason: record.suppressionReason ?? undefined,
      renderedSubject: record.renderedSubject ?? undefined,
    };
  } catch (err) {
    // FAIL CLOSED. This is the "have we already emailed about this crisis?"
    // gate, and `null` here means "no, send it".
    //
    // Falling back to an empty per-process store answered `null` for every
    // crisis, so a database fault silently disabled deduplication altogether.
    // Throwing instead lets the caller suppress this evaluation and retry on
    // the next tick, which is the recoverable failure of the two.
    logger.error("Crisis dedup lookup unavailable; refusing to assume unsent", {
      businessId,
      crisisKey,
      error: String(err),
    });
    throw err;
  }
}

/**
 * Returns recent alerts for a business (tenant-scoped).
 */
export async function getRecentAlerts(businessId: string, limit = 20): Promise<AlertRecord[]> {
  if (useTestMockFallback || !prisma?.notificationAlertRecord) {
    return testStore.alerts.filter((a) => a.businessId === businessId).slice(0, limit);
  }

  try {
    const records = await prisma.notificationAlertRecord.findMany({
      where: { businessId },
      orderBy: { detectedAt: "desc" },
      take: limit,
    });

    return records.map((r) => ({
      alertId: r.id,
      tenantId: r.tenantId,
      businessId: r.businessId,
      businessName: "",
      userId: r.userId,
      userEmail: "",
      severity: r.severity as AlertRecord["severity"],
      crisisKey: r.crisisKey,
      crisisTitle: r.crisisTitle ?? "",
      occurredAt: r.occurredAt.toISOString(),
      detectedAt: r.detectedAt.toISOString(),
      viewedAt: r.viewedAt?.toISOString() ?? null,
      emailEligibleAt: r.emailEligibleAt?.toISOString() ?? null,
      sentAt: r.sentAt?.toISOString() ?? null,
      deliveryStatus: r.deliveryStatus as AlertRecord["deliveryStatus"],
      suppressionReason: r.suppressionReason ?? undefined,
      renderedSubject: r.renderedSubject ?? undefined,
    }));
  } catch (err) {
    logger.warn("Falling back to in-memory recent alerts", { error: String(err) });
    return testStore.alerts.filter((a) => a.businessId === businessId).slice(0, limit);
  }
}

// ── 4. Delivery Audit Logs ───────────────────────────────────────────────────

/**
 * Records a delivery audit record in PostgreSQL.
 */
export async function recordDeliveryAudit(audit: DeliveryAuditRecord): Promise<void> {
  if (useTestMockFallback || !prisma?.notificationDeliveryAudit) {
    testStore.deliveryAudits.unshift(audit);
    if (testStore.deliveryAudits.length > 1000) {
      testStore.deliveryAudits = testStore.deliveryAudits.slice(0, 1000);
    }
    return;
  }

  try {
    await prisma.notificationDeliveryAudit.create({
      data: {
        id: audit.auditId,
        alertId: audit.alertId,
        businessId: audit.businessId,
        recipientEmail: audit.recipientEmail,
        provider: audit.provider,
        attemptedAt: new Date(audit.attemptedAt),
        status: audit.status,
        providerMessageId: audit.providerMessageId,
        errorCode: audit.errorCode,
        errorMessageSanitized: audit.errorMessageSanitized,
      },
    });
  } catch (err) {
    logger.warn("Falling back to in-memory delivery audit record", { error: String(err) });
    testStore.deliveryAudits.unshift(audit);
  }
}

/**
 * Returns recent delivery audits for a business (tenant-scoped).
 */
export async function getRecentDeliveryAudits(
  businessId: string,
  limit = 20
): Promise<DeliveryAuditRecord[]> {
  if (useTestMockFallback || !prisma?.notificationDeliveryAudit) {
    return testStore.deliveryAudits.filter((d) => d.businessId === businessId).slice(0, limit);
  }

  try {
    const records = await prisma.notificationDeliveryAudit.findMany({
      where: { businessId },
      orderBy: { attemptedAt: "desc" },
      take: limit,
    });

    return records.map((r) => ({
      auditId: r.id,
      alertId: r.alertId,
      businessId: r.businessId,
      recipientEmail: r.recipientEmail,
      provider: r.provider as DeliveryAuditRecord["provider"],
      attemptedAt: r.attemptedAt.toISOString(),
      status: r.status as DeliveryAuditRecord["status"],
      providerMessageId: r.providerMessageId ?? undefined,
      errorCode: r.errorCode ?? undefined,
      errorMessageSanitized: r.errorMessageSanitized ?? undefined,
    }));
  } catch (err) {
    logger.warn("Falling back to in-memory recent audits", { error: String(err) });
    return testStore.deliveryAudits.filter((d) => d.businessId === businessId).slice(0, limit);
  }
}
