import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildForecast, transactionsToMovements, calculateRunway } from "@/lib/engine/forecast";
import { calculateRisk } from "@/lib/engine/riskDetector";
import { getSession } from "@/lib/auth";
import { calculateLiquiditySafetyRequirement, extractObligations, calculateTemporalRequiredLiquidity } from "@/lib/engine/liquiditySafety";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const business = await prisma.business.findUnique({
      where: { id: session.businessId },
    });
    if (!business) {
      return NextResponse.json({
        status: "NO_DATA",
        business: null,
        forecast: null,
      });
    }

    const transactions = await prisma.transaction.findMany({
      where: { businessId: business.id },
    });

    const payouts = prisma.payout
      ? await prisma.payout.findMany({ where: { businessId: business.id } })
      : [];

    if (transactions.length === 0) {
      return NextResponse.json({
        status: "NO_DATA",
        business: {
          id: business.id,
          name: business.name,
          currentCash: business.currentCash,
        },
        forecast: null,
      });
    }

    const today = new Date();
    const movements = transactionsToMovements(transactions);
    const days = buildForecast(business.currentCash, movements, 14, today);
    const safetyReq = await calculateLiquiditySafetyRequirement(business.id, prisma, today);
    const requiredBuffer = safetyReq.requiredBuffer;
    const obligations = extractObligations(payouts, transactions, today);
    const temporalMetrics = calculateTemporalRequiredLiquidity(days, movements, obligations, requiredBuffer, today);

    const runwayMetrics = calculateRunway(days, requiredBuffer);
    const riskLevel = calculateRisk(runwayMetrics.minimumBalance, requiredBuffer);

    // Convert dates to string ISO strings for JSON serialization compatibility
    const formattedDays = days.map((d) => ({
      date: d.date.toISOString(),
      openingBalance: d.openingBalance,
      expectedInflows: d.expectedInflows,
      expectedOutflows: d.expectedOutflows,
      projectedBalance: d.closingBalance,
    }));

    // Find the ISO dates corresponding to runway event indices if they exist
    const firstBelowSafetyThreshold = runwayMetrics.firstDayBelowSafety
      ? days[runwayMetrics.firstDayBelowSafety - 1].date.toISOString()
      : null;

    const firstNegativeDay = runwayMetrics.crisisDay
      ? days[runwayMetrics.crisisDay - 1].date.toISOString()
      : null;

    return NextResponse.json({
      status: "SUCCESS",
      business: {
        id: business.id,
        name: business.name,
        currentCash: business.currentCash,
      },
      forecast: {
        horizonDays: 14,
        safetyThreshold: requiredBuffer,
        safetyRequirement: safetyReq,
        days: formattedDays,
        runway: {
          firstBelowSafetyThreshold,
          firstNegativeDay,
          minimumProjectedBalance: runwayMetrics.minimumBalance,
        },
        riskLevel,
        criticalObligations: {
          count: temporalMetrics.criticalObligationsCount,
          amount: temporalMetrics.criticalObligationsAmount,
          protected: temporalMetrics.criticalObligationsProtected,
        },
        temporalRisk: {
          firstCriticalDate: temporalMetrics.firstCriticalDate,
          criticalAmount: temporalMetrics.criticalAmount,
        },
      },
    });
  } catch (error: any) {
    console.error("API error in forecast:", error);
    return NextResponse.json(
      {
        status: "ERROR",
        error: "Unable to generate the latest forecast.",
        detail: error.message,
      },
      { status: 500 }
    );
  }
}
