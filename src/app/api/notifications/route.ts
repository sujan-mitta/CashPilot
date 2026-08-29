import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getPreferences, getRecentAlerts, getRecentDeliveryAudits, updatePreferences } from "@/lib/notifications/alertStore";
import { assessBusinessHealth } from "@/lib/notifications/healthAssessment";
import { parseJsonBody } from "@/lib/errors";
import { logger } from "@/lib/observability";

/**
 * GET /api/notifications
 *
 * Returns recent alerts, current health assessment, and preferences for the authenticated tenant.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session || !session.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const businessId = session.businessId;
    const [preferences, recentAlerts, deliveryAudits, currentHealth] = await Promise.all([
      getPreferences(businessId),
      getRecentAlerts(businessId, 20),
      getRecentDeliveryAudits(businessId, 20),
      assessBusinessHealth(businessId),
    ]);

    return NextResponse.json({
      success: true,
      businessId,
      preferences,
      currentHealth,
      recentAlerts,
      deliveryAudits,
    });
  } catch (error) {
    logger.error("Error fetching notifications data", { error: String(error) });
    return NextResponse.json({ error: "Failed to retrieve notification data" }, { status: 500 });
  }
}

/**
 * POST /api/notifications
 *
 * Updates notification preferences for the authenticated tenant.
 */
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session || !session.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = await parseJsonBody<Record<string, unknown>>(req);
    if (!parsed.ok) return parsed.response;

    const body = parsed.data;
    const updated = await updatePreferences(session.businessId, {
      criticalAlertsEnabled: typeof body.criticalAlertsEnabled === "boolean" ? body.criticalAlertsEnabled : undefined,
      warningAlertsEnabled: typeof body.warningAlertsEnabled === "boolean" ? body.warningAlertsEnabled : undefined,
      weeklyDigestEnabled: typeof body.weeklyDigestEnabled === "boolean" ? body.weeklyDigestEnabled : undefined,
      criticalCooldownHours: typeof body.criticalCooldownHours === "number" ? body.criticalCooldownHours : undefined,
      warningCooldownHours: typeof body.warningCooldownHours === "number" ? body.warningCooldownHours : undefined,
      offlineThresholdMinutes: typeof body.offlineThresholdMinutes === "number" ? body.offlineThresholdMinutes : undefined,
      recipientEmail: typeof body.recipientEmail === "string" ? body.recipientEmail : undefined,
    });

    logger.info("Notification preferences updated", {
      businessId: session.businessId,
      userId: session.userId,
    });

    return NextResponse.json({
      success: true,
      preferences: updated,
    });
  } catch (error) {
    logger.error("Error updating notification preferences", { error: String(error) });
    return NextResponse.json({ error: "Failed to update notification preferences" }, { status: 500 });
  }
}
