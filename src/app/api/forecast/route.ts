import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildForecast, calculateRunway } from "@/lib/engine/forecast";
import { buildForecastContextForBusiness } from "@/lib/forecast/movements";
import { buildScenarios } from "@/lib/forecast/scenarios";
import { calculateRisk } from "@/lib/engine/riskDetector";
import { getSession } from "@/lib/auth";
import { calculateLiquiditySafetyRequirement, extractObligations, calculateTemporalRequiredLiquidity } from "@/lib/engine/liquiditySafety";
import { errorMessage } from "@/lib/errors";
import { logger } from "@/lib/observability";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import { getLatestFinancialState, toSnapshot } from "@/lib/state/store";
import {
  checkForecastConsistency,
  type ForecastConsistencyResult,
} from "@/lib/state/forecastConsistency";

/** The few numbers a scenario is worth showing; the full day series is not. */
function summarise(s: {
  closingBalance: number;
  minimumBalance: number;
  minimumBalanceDay: number;
  firstDayBelowSafety: number | null;
}) {
  return {
    closingBalance: s.closingBalance,
    minimumBalance: s.minimumBalance,
    minimumBalanceDay: s.minimumBalanceDay,
    firstDayBelowSafety: s.firstDayBelowSafety,
  };
}

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
    const { movements, events } = await buildForecastContextForBusiness(
      prisma,
      business.id,
      transactions,
      { now: today }
    );
    const days = buildForecast(
      business.currentCash,
      movements,
      FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
      today
    );
    const safetyReq = await calculateLiquiditySafetyRequirement(business.id, prisma, today);
    const requiredBuffer = safetyReq.requiredBuffer;
    const obligations = extractObligations(payouts, transactions, today);
    const temporalMetrics = calculateTemporalRequiredLiquidity(days, movements, obligations, requiredBuffer, today);

    const runwayMetrics = calculateRunway(days, requiredBuffer);
    const riskLevel = calculateRisk(runwayMetrics.minimumBalance, requiredBuffer);

    // Built from the same events as `days`, so the band can never disagree with
    // the line it brackets.
    const scenarios = buildScenarios(business.currentCash, events, {
      horizonDays: FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
      startDate: today,
      requiredBuffer,
    });

    // Convert dates to string ISO strings for JSON serialization compatibility
    const formattedDays = days.map((d) => ({
      date: d.date.toISOString(),
      openingBalance: d.openingBalance,
      expectedInflows: d.expectedInflows,
      expectedOutflows: d.expectedOutflows,
      projectedBalance: d.closingBalance,
      // What the day's totals are made of. Sent so the dashboard can answer
      // "what IS that Rs 8,00,000" without a second request, which for a
      // fourteen-row table would be fourteen round trips to say what the
      // forecast already knew.
      movements: d.movements ?? [],
    }));

    // Find the ISO dates corresponding to runway event indices if they exist
    const firstBelowSafetyThreshold = runwayMetrics.firstDayBelowSafety
      ? days[runwayMetrics.firstDayBelowSafety - 1].date.toISOString()
      : null;

    const firstNegativeDay = runwayMetrics.crisisDay
      ? days[runwayMetrics.crisisDay - 1].date.toISOString()
      : null;

    // B-7b: cross-check this forecast against the materialised financial state.
    //
    // The forecast is computed from canonical rows and the state from the
    // reconciled brain. When two independent paths disagree, something is wrong
    // that neither can see alone. Read AFTER the forecast so a slow state query
    // cannot delay the figure the operator came for, and failure-tolerant
    // because an unavailable state must degrade the CHECK, never the forecast.
    let consistency: ForecastConsistencyResult;
    try {
      const latestState = await getLatestFinancialState(prisma, business.id);
      consistency = checkForecastConsistency(
        {
          cashPosition: business.currentCash,
          expectedInflows: days.reduce((sum, d) => sum + d.expectedInflows, 0),
          expectedOutflows: days.reduce((sum, d) => sum + d.expectedOutflows, 0),
          projectedMinimumBalance: runwayMetrics.minimumBalance,
        },
        latestState ? toSnapshot(latestState) : null,
        latestState?.stateVersion ?? null
      );
    } catch (err) {
      // Not comparable, and honest about why. Silently reporting AGREES here
      // would be the one thing this check exists to prevent.
      logger.warn("Forecast consistency check unavailable", {
        businessId: business.id,
        error: errorMessage(err),
      });
      consistency = {
        verdict: "NOT_COMPARABLE",
        stateVersion: null,
        findings: [],
        summary:
          "The materialised financial state could not be read, so this forecast has " +
          "not been cross-checked against one.",
      };
    }

    return NextResponse.json({
      status: "SUCCESS",
      business: {
        id: business.id,
        name: business.name,
        currentCash: business.currentCash,
      },
      consistency,
      forecast: {
        horizonDays: FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
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
        /**
         * Phase 10/13. The plausible range around the headline forecast, and
         * how much of it rests on measured behaviour rather than assumption.
         *
         * `degenerate: true` means all three scenarios coincide - which is a
         * statement about how little we know, not about the future being
         * certain, and is why `confidence.level` is LOW in that case.
         * Scenarios are derived from the SAME events as `days`, so BASE always
         * matches the line above it.
         */
        scenarios: {
          degenerate: scenarios.degenerate,
          optimistic: summarise(scenarios.optimistic),
          base: summarise(scenarios.base),
          conservative: summarise(scenarios.conservative),
        },
        confidence: {
          level: scenarios.confidence.level,
          eventsTotal: scenarios.confidence.eventsTotal,
          eventsWithMeasuredTiming: scenarios.confidence.eventsWithMeasuredTiming,
          widestBandDays: scenarios.confidence.widestBandDays,
          outcomeSpread: scenarios.confidence.outcomeSpread,
          reasons: scenarios.confidence.reasons,
        },
      },
    });
  } catch (error) {
    // `detail` used to carry errorMessage(error) straight to the browser. A
    // Prisma/pg failure names tables, columns and sometimes the connection, so
    // it is logged for an operator and never returned.
    logger.error("API error in forecast", { error: errorMessage(error) });
    return NextResponse.json(
      {
        status: "ERROR",
        error: "Unable to generate the latest forecast.",
      },
      { status: 500 }
    );
  }
}
