import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { evaluateAndDispatchAlerts } from "@/lib/notifications/alertEvaluator";
import { parseJsonBody } from "@/lib/errors";
import { logger } from "@/lib/observability";
import { secretsMatch } from "@/lib/auth/constantTime";
import { syncFinancialBrain } from "@/lib/brain/sync";

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

    // Escape hatch: `?skipSync=1` runs alerts without the brain sync. If sync
    // ever becomes the reason the cron times out, the operator must still be
    // able to get crisis alerts out.
    const skipSync = new URL(req.url).searchParams.get("skipSync") === "1";

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
    let totalSynced = 0;
    let totalSyncFailed = 0;

    for (const bizId of businessesToEvaluate) {
      // ── B-6: bring the brain up to date BEFORE assessing health ────────
      //
      // Until now state advanced only when a human ran `npm run brain:sync`,
      // so entity links, claims, reconciliation and the materialised state
      // were as old as the last time someone remembered. This is the
      // automatic trigger, and it runs first because the order in spec §10 is
      // causal: an assessment made before the sync is an assessment of
      // yesterday's understanding.
      //
      // Contained SEPARATELY from the notification evaluation on purpose. Sync
      // is derived bookkeeping; a crisis alert is the thing the operator
      // actually needs. If sync fails, the assessment still runs — it reads
      // canonical rows, so it is not blocked by stale derived state — and the
      // failure is reported rather than silently skipping the alert.
      //
      // Not wrapped in a transaction, deliberately. Every stage is idempotent,
      // a full-tenant sync can be long, and holding a write transaction across
      // it would block the money path (spec §10).
      let syncError: string | null = null;
      if (!skipSync) {
        try {
          await syncFinancialBrain(prisma, bizId);
          totalSynced++;
        } catch (err) {
          totalSyncFailed++;
          syncError = String(err);
          logger.error("Brain sync failed for business; continuing to alerts", {
            businessId: bizId,
            error: syncError,
          });
        }
      }

      try {
        const res = await evaluateAndDispatchAlerts({ businessId: bizId });
        totalEmailsSent += res.emailsSent;
        totalEmailsSuppressed += res.emailsSuppressed;

        results.push({
          businessId: bizId,
          synced: !skipSync && !syncError,
          syncError,
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
          synced: !skipSync && !syncError,
          syncError,
          status: "FAILED",
          error: String(bizErr),
        });
      }
    }

    const durationMs = Date.now() - startTime;
    logger.info("Notification check-and-dispatch cycle completed", {
      evaluatedCount: businessesToEvaluate.length,
      brainSynced: totalSynced,
      brainSyncFailed: totalSyncFailed,
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
