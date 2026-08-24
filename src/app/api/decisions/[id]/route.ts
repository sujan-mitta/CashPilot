import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { measureDecisionOutcome } from "@/lib/engine/outcomeMeasurer";
import { errorMessage } from "@/lib/errors";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const resolvedParams = "then" in context.params ? await context.params : context.params;
    const { id } = resolvedParams;

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

    // Proactively measure outcomes if window is closed and not yet measured
    const now = new Date();
    const windowEnd = new Date(decision.createdAt.getTime() + 14 * 24 * 60 * 60 * 1000);
    if (decision.status !== "OUTCOME_MEASURED" && now >= windowEnd) {
      const updated = await measureDecisionOutcome(decision.id, now);
      return NextResponse.json(updated);
    }

    return NextResponse.json(decision);
  } catch (error) {
    console.error("API error in single decision GET:", error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
