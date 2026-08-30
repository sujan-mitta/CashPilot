import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { evaluateAndDispatchAlerts } from "@/lib/notifications/alertEvaluator";
import { parseJsonBody } from "@/lib/errors";
import { logger } from "@/lib/observability";
import { secretsMatch } from "@/lib/auth/constantTime";

interface CheckAndDispatchOptions {
  req: Request;
  method: "GET" | "POST";
}

async function handleCheckAndDispatch({ req, method }: CheckAndDispatchOptions) {
  const startTime = Date.now();
  try {
    const authHeader = req.headers.get("authorization") || "";
    const cronHeader = req.headers.get("x-cron-secret") || "";
    const cronSecret = process.env.CRON_SECRET;

    // Constant-time, to match the webhook HMAC and password paths. `===`
    // short-circuits at the first differing byte; the signal is buried under
    // network jitter over HTTP, but a secret check that is not constant-time is
    // the odd one out in this codebase.
    const isCronAuthorized =
      secretsMatch(cronHeader, cronSecret) ||
      secretsMatch(authHeader, cronSecret ? `Bearer ${cronSecret}` : null);

    let targetBusinessId: string | null = null;

    if (!isCronAuthorized) {
      // Fallback: Verify authenticated user session
      const session = await getSession();
      if (!session || !session.businessId) {
        logger.warn("Unauthorized check-and-dispatch request", {
          method,
          hasAuthHeader: Boolean(authHeader),
          hasCronHeader: Boolean(cronHeader),
        });
        return NextResponse.json(
          { error: "Unauthorized: Missing internal secret or valid user session" },
          { status: 401 }
        );
      }
      targetBusinessId = session.businessId;
    } else if (method === "POST") {
      // For POST cron dispatch, optional businessId filter
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

    logger.info("Notification check-and-dispatch cycle started", {
      method,
      isCron: isCronAuthorized,
      targetBusinessCount: businessesToEvaluate.length,
      isSingleTenant: Boolean(targetBusinessId),
    });

    let totalEmailsSent = 0;
    let totalEmailsSuppressed = 0;
    let totalFailed = 0;

    const results = [];
    for (const bizId of businessesToEvaluate) {
      try {
        const res = await evaluateAndDispatchAlerts({ businessId: bizId });
        totalEmailsSent += res.emailsSent;
        totalEmailsSuppressed += res.emailsSuppressed;

        results.push({
          businessId: bizId,
          status: res.evaluationStatus,
          severity: res.healthAssessment?.severity ?? "UNKNOWN",
          crisisKey: res.crisisKey,
          emailsSent: res.emailsSent,
          emailsSuppressed: res.emailsSuppressed,
        });
      } catch (bizErr) {
        totalFailed++;
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

    const durationMs = Date.now() - startTime;
    logger.info("Notification check-and-dispatch cycle completed", {
      evaluatedCount: businessesToEvaluate.length,
      totalEmailsSent,
      totalEmailsSuppressed,
      totalFailed,
      durationMs,
    });

    return NextResponse.json({
      success: true,
      invoker: isCronAuthorized ? "CRON_SCHEDULER" : "AUTHENTICATED_USER",
      evaluatedCount: businessesToEvaluate.length,
      totalEmailsSent,
      totalEmailsSuppressed,
      totalFailed,
      durationMs,
      results,
    });
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error("Check-and-dispatch endpoint execution error", {
      error: String(error),
      durationMs,
    });
    return NextResponse.json({ error: "Notification evaluation failed" }, { status: 500 });
  }
}

/**
 * GET /api/notifications/check-and-dispatch
 * Invoked by Vercel Cron on the configured schedule.
 */
export async function GET(req: Request) {
  return handleCheckAndDispatch({ req, method: "GET" });
}

/**
 * POST /api/notifications/check-and-dispatch
 * Invoked by internal webhook or manual tenant trigger.
 */
export async function POST(req: Request) {
  return handleCheckAndDispatch({ req, method: "POST" });
}
