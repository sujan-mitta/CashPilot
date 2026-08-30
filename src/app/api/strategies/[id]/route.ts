import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { logger } from "@/lib/observability";

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

    const business = await prisma.business.findUnique({
      where: { id: session.businessId },
    });
    if (!business) {
      return NextResponse.json({ error: "Business not found" }, { status: 404 });
    }

    const strategy = await prisma.strategy.findFirst({
      where: { id, businessId: business.id },
      include: {
        agentActions: true,
      },
    });

    if (!strategy) {
      return NextResponse.json({ error: "Strategy not found" }, { status: 404 });
    }

    // The stored `actions` JSON is the raw engine output, which carries no id —
    // ids live on the AgentAction rows. POST /api/strategies returns actions with
    // ids attached, so do the same here to keep both paths on one shape.
    const storedActions = Array.isArray(strategy.actions)
      ? (strategy.actions as unknown as Array<{ type: string; [key: string]: unknown }>)
      : [];
    const claimed = new Set<string>();
    const actions = storedActions.map((a, idx) => {
      const match = strategy.agentActions.find(
        (dbA) => dbA.actionType === a.type && !claimed.has(dbA.id)
      );
      if (match) claimed.add(match.id);

      return {
        ...a,
        id: match ? match.id : `${strategy.id}-action-${idx}`,
        status: match ? match.status : "SIMULATED",
      };
    });

    // The decision this plan belongs to carries when it stops being executable.
    // Sent so the approval screen can warn BEFORE it refuses, rather than
    // letting the operator read the whole plan, decide, and only then be told
    // it expired (spec §25).
    //
    // Tenant-scoped like everything else here: an id alone is not authorisation.
    const decision = await prisma.decision.findFirst({
      where: { strategyId: strategy.id, businessId: business.id },
      select: { expiresAt: true, status: true, financialStateVersion: true },
    });

    return NextResponse.json({
      ...strategy,
      actions,
      decisionExpiresAt: decision?.expiresAt?.toISOString() ?? null,
      decisionStatus: decision?.status ?? null,
    });
  } catch (error) {
    logger.error("API error in get strategy", { error: errorMessage(error) });
    return NextResponse.json({ error: "Could not load that plan." }, { status: 500 });
  }
}
