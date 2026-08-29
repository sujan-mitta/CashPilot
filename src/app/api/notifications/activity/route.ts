import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { updateUserActivity } from "@/lib/notifications/alertStore";
import { parseJsonBody } from "@/lib/errors";
import { logger } from "@/lib/observability";

/**
 * POST /api/notifications/activity
 *
 * Records user activity / last seen timestamp when viewing the dashboard.
 * Tenant-isolated and authenticated.
 */
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session || !session.businessId || !session.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let crisisKey: string | null = null;
    try {
      const parsed = await parseJsonBody<{ crisisKey?: string }>(req);
      if (parsed.ok && parsed.data?.crisisKey) {
        crisisKey = String(parsed.data.crisisKey);
      }
    } catch {
      // Body is optional for simple heartbeat pings
    }

    const now = new Date().toISOString();
    const updated = await updateUserActivity(
      session.userId,
      session.businessId,
      session.email,
      session.name,
      {
        lastSeenAt: now,
        lastDashboardViewAt: now,
        lastViewedCrisisKey: crisisKey,
      }
    );

    return NextResponse.json({
      success: true,
      activity: {
        userId: updated.userId,
        businessId: updated.businessId,
        lastSeenAt: updated.lastSeenAt,
        lastDashboardViewAt: updated.lastDashboardViewAt,
      },
    });
  } catch (error) {
    logger.error("Error recording user activity", { error: String(error) });
    return NextResponse.json({ error: "Failed to record activity" }, { status: 500 });
  }
}
