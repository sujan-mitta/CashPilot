import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runAgent } from "@/lib/ai/agents";
import { investigatorPrompt, recommenderPrompt } from "@/lib/ai/prompts";
import { buildForecast, calculateRunway } from "@/lib/engine/forecast";
import { buildMovementsForBusiness } from "@/lib/forecast/movements";
import { calculateRisk } from "@/lib/engine/riskDetector";
import { identifyRootCauses } from "@/lib/engine/rootCause";
import { calculateLiquiditySafetyRequirement } from "@/lib/engine/liquiditySafety";
import { errorMessage } from "@/lib/errors";
import { logger } from "@/lib/observability";

interface ActionDefinition {
  label: string;
  amount: number;
}

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { type } = await req.json().catch(() => ({}));
    if (!type || (type !== "investigation" && type !== "strategies")) {
      return NextResponse.json(
        { error: "Invalid explanation type. Expected 'investigation' or 'strategies'." },
        { status: 400 }
      );
    }

    const business = await prisma.business.findUnique({
      where: { id: session.businessId },
      include: {
        transactions: true,
        invoices: true,
        payouts: true,
      },
    });

    if (!business) {
      return NextResponse.json({ error: "Business not found." }, { status: 404 });
    }

    if (type === "investigation") {
      // Run deterministic calculations
      const movements = await buildMovementsForBusiness(prisma, business.id, business.transactions);
      const forecast = buildForecast(business.currentCash, movements);
      const { requiredBuffer } = await calculateLiquiditySafetyRequirement(business.id, prisma);
      const runway = calculateRunway(forecast, requiredBuffer);

      const finalBalance = forecast[forecast.length - 1]?.closingBalance ?? business.currentCash;
      const riskLevel = calculateRisk(runway.minimumBalance, requiredBuffer);

      // Calculate root causes
      const failedPaymentsTotal = business.transactions
        .filter((t) => t.status === "FAILED" && t.type === "INFLOW")
        .reduce((sum, t) => sum + t.amount, 0);

      const overdueInvoicesTotal = business.invoices
        .filter((i) => i.status === "OVERDUE")
        .reduce((sum, i) => sum + i.amount, 0);

      const payoutsBeforeCollectionsTotal = business.payouts
        .filter((p) => runway.crisisDay && p.scheduledDate < (forecast[runway.crisisDay - 1]?.date ?? new Date()))
        .reduce((sum, p) => sum + p.amount, 0);

      const payrollAmount = business.payouts
        .filter((p) => p.vendor.toLowerCase().includes("payroll") || p.vendor.toLowerCase().includes("salary"))
        .reduce((sum, p) => sum + p.amount, 0);

      const causes = identifyRootCauses({
        overdueInvoicesTotal,
        failedPaymentsTotal,
        payoutsBeforeCollectionsTotal,
        payrollBeforeCollections: payoutsBeforeCollectionsTotal > 0,
        payrollAmount,
      });

      const promptInput = {
        currentCash: business.currentCash,
        projectedBalance: finalBalance,
        riskLevel,
        crisisDay: runway.crisisDay,
        rootCauses: causes.map((rc) => ({
          type: rc.type,
          amount: rc.amount,
          detail: rc.detail,
        })),
      };

      const fallbackNarration = `The projected deficit is caused by timing gaps in scheduled obligations arriving faster than committed inflows. Failed payments and overdue receivables also contribute to the cash crunch.`;

      const aiNarrative = await runAgent(
        investigatorPrompt(promptInput),
        fallbackNarration
      );

      return NextResponse.json({ narrative: aiNarrative });
    }

    if (type === "strategies") {
      // Fetch saved strategies
      const dbStrategies = await prisma.strategy.findMany({
        where: { businessId: business.id },
      });

      if (dbStrategies.length === 0) {
        return NextResponse.json({ error: "No strategies found to explain." }, { status: 404 });
      }

      // Map to prompt input format
      const recommended = dbStrategies.find((s) => s.recommended);
      const alternatives = dbStrategies.filter((s) => !s.recommended);

      if (!recommended) {
        return NextResponse.json({ error: "No recommended strategy found." }, { status: 404 });
      }

      // Parse actions from JSON safely
      const parseActions = (actionsJson: unknown): ActionDefinition[] => {
        try {
          const parsed = typeof actionsJson === "string" ? JSON.parse(actionsJson) : actionsJson;
          return Array.isArray(parsed) ? (parsed as ActionDefinition[]) : [];
        } catch {
          return [];
        }
      };

      const promptInput = {
        recommendedStrategy: {
          name: recommended.name,
          projectedBalance: recommended.projectedBalance,
          riskLevel: recommended.riskLevel as string,
          score: recommended.score,
          actions: parseActions(recommended.actions),
        },
        alternatives: alternatives.map((s) => ({
          name: s.name,
          projectedBalance: s.projectedBalance,
          riskLevel: s.riskLevel as string,
          score: s.score,
        })),
      };

      const fallbackNarration = `The deterministic engine recommends the optimized recovery strategy to eliminate the deficit while minimizing operational disruption.`;

      const aiNarrative = await runAgent(
        recommenderPrompt(promptInput),
        fallbackNarration
      );

      return NextResponse.json({ narrative: aiNarrative });
    }

    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  } catch (error) {
    logger.error("AI explain endpoint error:", { error: String(error) });
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
