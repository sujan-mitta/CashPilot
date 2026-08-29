/**
 * Persistent alert and activity store for CashPilot notifications.
 *
 * Persists:
 * - User activity timestamps (lastSeenAt, lastDashboardViewAt)
 * - Sent alerts history & crisis keys
 * - Delivery audit logs
 * - Tenant notification preferences
 *
 * Implements atomic writes and thread-safe locking.
 */

import fs from "fs";
import path from "path";
import { logger } from "@/lib/observability";
import type {
  AlertRecord,
  DeliveryAuditRecord,
  NotificationPreferences,
  UserActivity,
} from "./types";

const DATA_DIR = path.resolve(process.cwd(), ".cashpilot_data");
const STORE_FILE = path.join(DATA_DIR, "notification_store.json");

interface PersistedState {
  activities: Record<string, UserActivity>; // key: `${businessId}:${userId}`
  alerts: AlertRecord[];
  deliveryAudits: DeliveryAuditRecord[];
  preferences: Record<string, NotificationPreferences>; // key: `${businessId}`
  claimedAlertIds: Record<string, string>; // alertId -> claimedAt ISO
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  criticalAlertsEnabled: true,
  warningAlertsEnabled: true,
  weeklyDigestEnabled: true,
  criticalCooldownHours: 72,
  warningCooldownHours: 168,
  offlineThresholdMinutes: 30,
};

let inMemoryState: PersistedState | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function ensureDataDirectory(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (err) {
    logger.warn("Could not create data directory", { error: String(err) });
  }
}

function loadState(): PersistedState {
  if (inMemoryState) return inMemoryState;

  ensureDataDirectory();
  if (fs.existsSync(STORE_FILE)) {
    try {
      const raw = fs.readFileSync(STORE_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      inMemoryState = {
        activities: parsed.activities ?? {},
        alerts: Array.isArray(parsed.alerts) ? parsed.alerts : [],
        deliveryAudits: Array.isArray(parsed.deliveryAudits) ? parsed.deliveryAudits : [],
        preferences: parsed.preferences ?? {},
        claimedAlertIds: parsed.claimedAlertIds ?? {},
      };
      return inMemoryState;
    } catch (err) {
      logger.error("Failed to load notification store from disk; starting fresh", { error: String(err) });
    }
  }

  inMemoryState = {
    activities: {},
    alerts: [],
    deliveryAudits: [],
    preferences: {},
    claimedAlertIds: {},
  };
  return inMemoryState;
}

async function persistState(): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    try {
      ensureDataDirectory();
      const state = loadState();
      const tempFile = `${STORE_FILE}.tmp.${Date.now()}`;
      fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf-8");
      fs.renameSync(tempFile, STORE_FILE);
    } catch (err) {
      logger.error("Failed to persist notification state to disk", { error: String(err) });
    }
  });
  await writeQueue;
}

/**
 * Retrieves a user's activity record scoped by business.
 */
export async function getUserActivity(userId: string, businessId: string): Promise<UserActivity | null> {
  const state = loadState();
  const key = `${businessId}:${userId}`;
  return state.activities[key] ?? null;
}

/**
 * Updates or creates a user's activity record.
 */
export async function updateUserActivity(
  userId: string,
  businessId: string,
  userEmail: string,
  userName: string,
  options: {
    lastSeenAt?: string;
    lastDashboardViewAt?: string;
    lastViewedCrisisKey?: string | null;
  } = {}
): Promise<UserActivity> {
  const state = loadState();
  const key = `${businessId}:${userId}`;
  const now = new Date().toISOString();

  const existing = state.activities[key];
  const updated: UserActivity = {
    userId,
    businessId,
    userEmail: userEmail || existing?.userEmail || "unknown@company.com",
    userName: userName || existing?.userName || "User",
    lastSeenAt: options.lastSeenAt || now,
    lastDashboardViewAt: options.lastDashboardViewAt || existing?.lastDashboardViewAt || now,
    lastActivityAt: now,
    lastViewedCrisisKey: options.lastViewedCrisisKey !== undefined ? options.lastViewedCrisisKey : existing?.lastViewedCrisisKey,
    lastViewedCrisisAt: options.lastViewedCrisisKey ? now : existing?.lastViewedCrisisAt,
  };

  state.activities[key] = updated;
  await persistState();
  return updated;
}

/**
 * Retrieves all registered user activity records for a business.
 */
export async function getBusinessUserActivities(businessId: string): Promise<UserActivity[]> {
  const state = loadState();
  const prefix = `${businessId}:`;
  return Object.entries(state.activities)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v);
}

/**
 * Retrieves notification preferences for a business.
 */
export async function getPreferences(businessId: string): Promise<NotificationPreferences> {
  const state = loadState();
  return state.preferences[businessId] ?? { ...DEFAULT_PREFERENCES };
}

/**
 * Updates notification preferences for a business with safe bounds.
 */
export async function updatePreferences(
  businessId: string,
  prefs: Partial<NotificationPreferences>
): Promise<NotificationPreferences> {
  const state = loadState();
  const current = state.preferences[businessId] ?? { ...DEFAULT_PREFERENCES };

  const updated: NotificationPreferences = {
    criticalAlertsEnabled: prefs.criticalAlertsEnabled ?? current.criticalAlertsEnabled,
    warningAlertsEnabled: prefs.warningAlertsEnabled ?? current.warningAlertsEnabled,
    weeklyDigestEnabled: prefs.weeklyDigestEnabled ?? current.weeklyDigestEnabled,
    // Enforce safe bounds (critical cooldown: 24h to 168h)
    criticalCooldownHours: Math.min(
      168,
      Math.max(24, Number(prefs.criticalCooldownHours) || current.criticalCooldownHours)
    ),
    // Enforce safe bounds (warning cooldown: 48h to 336h)
    warningCooldownHours: Math.min(
      336,
      Math.max(48, Number(prefs.warningCooldownHours) || current.warningCooldownHours)
    ),
    // Enforce safe bounds (offline threshold: 15m to 120m)
    offlineThresholdMinutes: Math.min(
      120,
      Math.max(15, Number(prefs.offlineThresholdMinutes) || current.offlineThresholdMinutes)
    ),
    recipientEmail: prefs.recipientEmail?.trim() || current.recipientEmail,
  };

  state.preferences[businessId] = updated;
  await persistState();
  return updated;
}

/**
 * Records a new alert decision in the store.
 */
export async function recordAlert(record: AlertRecord): Promise<AlertRecord> {
  const state = loadState();
  // Unshift so most recent is first
  state.alerts.unshift(record);
  // Keep bounded list (max 500 records)
  if (state.alerts.length > 500) {
    state.alerts = state.alerts.slice(0, 500);
  }
  await persistState();
  return record;
}

/**
 * Atomically claims an alert for dispatch to prevent concurrent double-sends.
 */
export async function claimAlertForDispatch(alertId: string): Promise<boolean> {
  const state = loadState();
  const now = new Date().toISOString();
  if (state.claimedAlertIds[alertId]) {
    return false; // Already claimed by another worker
  }
  state.claimedAlertIds[alertId] = now;
  await persistState();
  return true;
}

/**
 * Updates delivery status of an existing alert.
 */
export async function updateAlertDelivery(
  alertId: string,
  update: Partial<AlertRecord>
): Promise<AlertRecord | null> {
  const state = loadState();
  const alert = state.alerts.find((a) => a.alertId === alertId);
  if (!alert) return null;

  Object.assign(alert, update);
  await persistState();
  return alert;
}

/**
 * Appends a delivery audit record.
 */
export async function recordDeliveryAudit(audit: DeliveryAuditRecord): Promise<void> {
  const state = loadState();
  state.deliveryAudits.unshift(audit);
  if (state.deliveryAudits.length > 1000) {
    state.deliveryAudits = state.deliveryAudits.slice(0, 1000);
  }
  await persistState();
}

/**
 * Finds the latest alert sent for a specific crisis key in a business.
 */
export async function findLatestAlertForCrisis(
  businessId: string,
  crisisKey: string
): Promise<AlertRecord | null> {
  const state = loadState();
  const match = state.alerts.find(
    (a) =>
      a.businessId === businessId &&
      a.crisisKey === crisisKey &&
      (a.deliveryStatus === "SENT" || a.deliveryStatus === "ACCEPTED" || a.deliveryStatus === "SIMULATED")
  );
  return match ?? null;
}

/**
 * Returns recent alerts for a business (tenant-scoped).
 */
export async function getRecentAlerts(businessId: string, limit = 20): Promise<AlertRecord[]> {
  const state = loadState();
  return state.alerts.filter((a) => a.businessId === businessId).slice(0, limit);
}

/**
 * Returns recent delivery audits for a business (tenant-scoped).
 */
export async function getRecentDeliveryAudits(businessId: string, limit = 20): Promise<DeliveryAuditRecord[]> {
  const state = loadState();
  return state.deliveryAudits.filter((d) => d.businessId === businessId).slice(0, limit);
}

/**
 * Clears the store state in tests.
 */
export function __resetStoreForTesting(): void {
  inMemoryState = {
    activities: {},
    alerts: [],
    deliveryAudits: [],
    preferences: {},
    claimedAlertIds: {},
  };
  try {
    if (fs.existsSync(STORE_FILE)) {
      fs.unlinkSync(STORE_FILE);
    }
  } catch {
    // Ignore in tests
  }
}
