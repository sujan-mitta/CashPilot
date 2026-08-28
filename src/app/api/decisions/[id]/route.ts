import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { measureDecisionOutcome } from "@/lib/engine/outcomeMeasurer";
import { errorMessage } from "@/lib/errors";
import { logger } from "@/lib/observability";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";

export async function GET(
  req: NextRequest,
  // Next 16 types the second argument's `params` as a Promise. The previous
  // union also allowed a bare object, which no longer satisfies the generated
  // RouteContext constraint and failed `tsc --noEmit`. Awaiting a non-promise
  // is a no-op at runtime, so callers passing a plain object still work.
  context: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;

    const decision = await prisma.decision.findFirst({
      where: { id, businessId: session.businessId },
      include: {
        strategy: {
          include: { agentActions: true },
        },
      },
    });

    if (!decision) {
      return NextResponse.json({ error: "Decision not found" }, { status: 404 });
    }

    // Proactively measure outcomes if window is closed and not yet measured.
    //
    // The horizon comes from the DECISION, not a literal 14. `Decision.
    // outcomeMeasurementHorizonDays` exists precisely because a strategy that
    // defers an obligation past the forecast window needs a longer measurement
    // window to observe it - /api/strategies computes and stores it per
    // decision. Hardcoding 14 threw that away and measured a deferred payout
    // BEFORE it came due, which is the one case the field was added for.
    const now = new Date();
    const horizonDays =
      typeof decision.outcomeMeasurementHorizonDays === "number" &&
      decision.outcomeMeasurementHorizonDays > 0
        ? decision.outcomeMeasurementHorizonDays
        : FINANCIAL_CONFIG.OUTCOME_WINDOW_DAYS;
    const windowEnd = new Date(decision.createdAt.getTime() + horizonDays * 24 * 60 * 60 * 1000);
    if (decision.status !== "OUTCOME_MEASURED" && now >= windowEnd) {
      const updated = await measureDecisionOutcome(decision.id, now);
      return NextResponse.json(updated);
    }

    return NextResponse.json(decision);
  } catch (error) {
    logger.error("API error in single decision GET", { error: errorMessage(error) });
    return NextResponse.json({ error: "Could not load that decision." }, { status: 500 });
  }
}
