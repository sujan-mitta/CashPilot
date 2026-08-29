import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { evaluateAndDispatchAlerts } from "@/lib/notifications/alertEvaluator";
import { parseJsonBody } from "@/lib/errors";
import { logger } from "@/lib/observability";

/**
 * POST /api/notifications/check-and-dispatch
 *
 * Internal scheduled execution route to evaluate financial health and dispatch
 * qualified notifications.
 *
 * Security: Requires either a valid internal CRON_SECRET or an authenticated user session.
 */
export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const cronHeader = req.headers.get("x-cron-secret") || "";
    const cronSecret = process.env.CRON_SECRET;

    const isCronAuthorized =
      (cronSecret && cronHeader === cronSecret) ||
      (cronSecret && authHeader === `Bearer ${cronSecret}`);

    let targetBusinessId: string | null = null;

    if (!isCronAuthorized) {
      // Fallback: Verify authenticated user session
      const session = await getSession();
      if (!session || !session.businessId) {
        return NextResponse.json(
          { error: "Unauthorized: Missing internal secret or user session" },
          { status: 401 }
        );
      }
      targetBusinessId = session.businessId;
    } else {
      // For cron dispatch, optional businessId filter
      try {
        const parsed = await parseJsonBody<{ businessId?: string }>(req);
        if (parsed.ok && parsed.data?.businessId) {
          targetBusinessId = String(parsed.data.businessId);
        }
      } catch {
        // Evaluate all businesses if none specified
      }
    }

    const businessesToEvaluate: string[] = [];
    if (targetBusinessId) {
      businessesToEvaluate.push(targetBusinessId);
    } else {
      const allBusinesses = await prisma.business.findMany({ select: { id: true } });
      businessesToEvaluate.push(...allBusinesses.map((b) => b.id));
    }

    const results = [];
    for (const bizId of businessesToEvaluate) {
      try {
        const res = await evaluateAndDispatchAlerts({ businessId: bizId });
        results.push({
          businessId: bizId,
          status: res.evaluationStatus,
          severity: res.healthAssessment?.severity,
          crisisKey: res.crisisKey,
          emailsSent: res.emailsSent,
          emailsSuppressed: res.emailsSuppressed,
        });
      } catch (bizErr) {
        logger.error("Failed to evaluate business notifications", {
          businessId: bizId,
          error: String(bizErr),
        });
        results.push({
          businessId: bizId,
          status: "FAILED",
          error: String(bizErr),
        });
      }
    }

    return NextResponse.json({
      success: true,
      evaluatedCount: businessesToEvaluate.length,
      results,
    });
  } catch (error) {
    logger.error("Check-and-dispatch endpoint error", { error: String(error) });
    return NextResponse.json({ error: "Notification evaluation failed" }, { status: 500 });
  }
}
