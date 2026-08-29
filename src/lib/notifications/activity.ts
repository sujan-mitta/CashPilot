/**
 * User activity and offline detection helpers.
 */

import { getUserActivity, updateUserActivity } from "./alertStore";
import type { UserActivity } from "./types";

export interface ActivityEvaluation {
  userId: string;
  isOffline: boolean;
  minutesInactive: number;
  hoursInactive: number;
  lastSeenAt: string | null;
  lastDashboardViewAt: string | null;
  hasViewedCrisis: boolean;
}

/**
 * Checks whether a user is offline relative to a given threshold.
 */
export async function evaluateUserOffline(
  userId: string,
  businessId: string,
  offlineThresholdMinutes: number,
  crisisKey?: string | null,
  now: Date = new Date()
): Promise<ActivityEvaluation> {
  const record = await getUserActivity(userId, businessId);

  if (!record || !record.lastSeenAt) {
    return {
      userId,
      isOffline: true, // No prior activity recorded -> offline
      minutesInactive: 999999,
      hoursInactive: 9999,
      lastSeenAt: null,
      lastDashboardViewAt: null,
      hasViewedCrisis: false,
    };
  }

  const lastSeen = new Date(record.lastSeenAt);
  const diffMs = Math.max(0, now.getTime() - lastSeen.getTime());
  const minutesInactive = diffMs / (1000 * 60);
  const hoursInactive = minutesInactive / 60;

  const hasViewedCrisis = Boolean(
    crisisKey &&
      (record.lastViewedCrisisKey === crisisKey ||
        record.lastViewedCrisisKey === "CRITICAL_VIEWED")
  );

  return {
    userId,
    isOffline: minutesInactive >= offlineThresholdMinutes,
    minutesInactive,
    hoursInactive,
    lastSeenAt: record.lastSeenAt,
    lastDashboardViewAt: record.lastDashboardViewAt,
    hasViewedCrisis,
  };
}

/**
 * Records a user activity event.
 */
export async function recordUserActivityPing(
  userId: string,
  businessId: string,
  userEmail: string,
  userName?: string,
  crisisKey?: string | null,
  now: Date = new Date()
): Promise<UserActivity> {
  return updateUserActivity(userId, businessId, userEmail, userName || "", {
    lastSeenAt: now.toISOString(),
    lastDashboardViewAt: now.toISOString(),
    lastViewedCrisisKey: crisisKey,
  });
}
