import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { measureDecisionOutcome } from "@/lib/engine/outcomeMeasurer";
import { InvalidDecisionTransitionError } from "@/lib/engine/decisionStateMachine";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import { errorMessage } from "@/lib/errors";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Decision history.
 *
 * Paginated and tenant-scoped. Ordering is (createdAt DESC, id DESC) - the id
 * tiebreak matters because several decisions are written inside one transaction
 * and can share a timestamp to the millisecond; without it, page boundaries can
 * repeat or skip rows.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);

    const rawLimit = parseInt(searchParams.get("limit") || "", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), FINANCIAL_CONFIG.DECISION_PAGE_SIZE_MAX)
      : FINANCIAL_CONFIG.DECISION_PAGE_SIZE_DEFAULT;

    const rawOffset = parseInt(searchParams.get("offset") || "", 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    const now = new Date();
    const windowStart = new Date(
      now.getTime() - FINANCIAL_CONFIG.OUTCOME_WINDOW_DAYS * MS_PER_DAY
    );

    // Only decisions whose window has actually closed are candidates for
    // measurement, and only the ones on this page. Previously every decision in
    // the tenant's history was re-examined on every list request.
    const measurable = await prisma.decision.findMany({
      where: {
        businessId: session.businessId,
        status: {
          in: ["EXECUTED", "RECONCILED", "RECONCILIATION_MISMATCH", "NOT_EXECUTED", "REJECTED"],
        },
        createdAt: { lte: windowStart },
      },
      select: { id: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      skip: offset,
    });

    for (const d of measurable) {
      try {
        await measureDecisionOutcome(d.id, now);
      } catch (err) {
        // A decision that cannot legally be measured is left exactly as it is.
        if (err instanceof InvalidDecisionTransitionError) continue;
        console.error(`Error measuring decision ${d.id}:`, err);
      }
    }

    const [decisions, total] = await Promise.all([
      prisma.decision.findMany({
        where: { businessId: session.businessId },
        include: {
          strategy: {
            select: {
              id: true,
              name: true,
              projectedBalance: true,
              riskLevel: true,
              score: true,
              recommended: true,
              createdAt: true,
            },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        skip: offset,
      }),
      prisma.decision.count({ where: { businessId: session.businessId } }),
    ]);

    return NextResponse.json({
      decisions,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + decisions.length < total,
      },
    });
  } catch (error) {
    console.error("API error in decisions list:", error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
