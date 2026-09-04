/**
 * Health assessment generator for notifications.
 *
 * Consumes authoritative CashPilot financial models (forecast, runway, safety buffer,
 * temporal obligations, overdue invoices, and recommended strategies) and produces
 * a structured HealthAssessment with deterministic crisisKey.
 */

import { prisma } from "@/lib/prisma";
import { buildForecast, calculateRunway } from "@/lib/engine/forecast";
import { buildForecastContextForBusiness } from "@/lib/forecast/movements";
import {
  calculateLiquiditySafetyRequirement,
  extractObligations,
  calculateTemporalRequiredLiquidity,
} from "@/lib/engine/liquiditySafety";
import { generateStrategies } from "@/lib/engine/strategyEngine";
import { scoreAllStrategies } from "@/lib/engine/scorer";
import { buildActionLibrary } from "@/lib/engine/actionLibrary";
import { HANDLED_RECOVERY_STATUSES } from "@/lib/engine/actionEligibility";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import type {
  AlertSeverity,
  CrisisType,
  HealthAssessment,
  RecommendedStrategySummary,
  RootCauseItem,
} from "./types";
import { buildCrisisKey } from "./crisisIdentity";

/**
 * Assesses the financial health of a business using authoritative CashPilot engine calculations.
 */
export async function assessBusinessHealth(
  businessId: string,
  now: Date = new Date()
): Promise<HealthAssessment | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      transactions: true,
      invoices: true,
      payouts: true,
    },
  });

  if (!business) return null;

  const transactions = business.transactions || [];
  const payouts = business.payouts || [];
  const invoices = business.invoices || [];

  if (transactions.length === 0 && payouts.length === 0 && invoices.length === 0) {
    return {
      businessId: business.id,
      businessName: business.name,
      severity: "HEALTHY",
      crisisType: "HEALTHY",
      crisisKey: null,
      currentBalance: business.currentCash,
      safetyBuffer: 0,
      runwayDays: 999,
      projectedDeficitDate: null,
      firstBelowSafetyDate: null,
      rootCauses: [],
      criticalObligations: { count: 0, amount: 0, protected: true },
      recommendedStrategy: null,
      assessedAt: now.toISOString(),
      confidenceScore: 1.0,
    };
  }

  // 1. Authoritative Forecast Context & Movements
  const { movements } = await buildForecastContextForBusiness(
    prisma,
    business.id,
    transactions,
    { now }
  );

  const days = buildForecast(
    business.currentCash,
    movements,
    FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
    now
  );

  // 2. Authoritative Safety Buffer & Temporal Obligations
  const safetyReq = await calculateLiquiditySafetyRequirement(business.id, prisma, now);
  const requiredBuffer = safetyReq.requiredBuffer;
  const obligations = extractObligations(payouts, transactions, now);
  const temporalMetrics = calculateTemporalRequiredLiquidity(
    days,
    movements,
    obligations,
    requiredBuffer,
    now
  );
  const runwayMetrics = calculateRunway(days, requiredBuffer);

  // 3. Evaluate Dates
  const firstBelowSafetyDate = runwayMetrics.firstDayBelowSafety
    ? days[runwayMetrics.firstDayBelowSafety - 1].date.toISOString()
    : null;

  const projectedDeficitDate = runwayMetrics.crisisDay
    ? days[runwayMetrics.crisisDay - 1].date.toISOString()
    : null;

  const runwayDays = runwayMetrics.firstDayBelowSafety ?? FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS;

  // 4. Determine Severity & Crisis Identity
  let severity: AlertSeverity = "HEALTHY";
  let crisisType: CrisisType = "HEALTHY";
  let crisisKey: string | null = null;

  const hasDeficit = projectedDeficitDate !== null;
  const hasDeficitWithin14Days = runwayMetrics.crisisDay !== null && runwayMetrics.crisisDay < 14;
  const hasUnprotectedObligations =
    !temporalMetrics.criticalObligationsProtected && temporalMetrics.criticalObligationsCount > 0;
  const isBelowSafetyBuffer = business.currentCash < requiredBuffer || firstBelowSafetyDate !== null;

  if (hasDeficit || hasDeficitWithin14Days) {
    severity = "CRITICAL";
    crisisType = "DEFICIT";
    crisisKey = buildCrisisKey({ type: crisisType, projectedDeficitDate });
  } else if (hasUnprotectedObligations) {
    severity = "CRITICAL";
    crisisType = "OBLIGATION_RISK";
    crisisKey = buildCrisisKey({ type: crisisType, criticalObligationDate: temporalMetrics.firstCriticalDate });
  } else if (isBelowSafetyBuffer) {
    severity = "WARNING";
    crisisType = "SAFETY_BUFFER_BREACH";
    crisisKey = buildCrisisKey({ type: crisisType, firstBelowSafetyDate });
  }

  // 5. Derive Top Root Causes
  const rootCauses: RootCauseItem[] = [];

  // Overdue Invoices
  const overdueInvoices = invoices.filter((inv) => inv.status !== "PAID" && new Date(inv.dueDate) < now);
  for (const inv of overdueInvoices.slice(0, 2)) {
    rootCauses.push({
      type: "OVERDUE_INVOICE",
      title: `Overdue Invoice: ${inv.customerName || "Customer"}`,
      amount: inv.amount,
      dueDate: inv.dueDate.toISOString(),
      description: `Invoice for ${inv.customerName} is overdue since ${inv.dueDate.toLocaleDateString("en-IN")}.`,
      counterpartyName: inv.customerName,
    });
  }

  // Pending / Upcoming Payouts
  const upcomingPayouts = payouts.filter((p) => p.status !== "PAID" && new Date(p.scheduledDate) >= now);
  for (const p of upcomingPayouts.slice(0, 2)) {
    rootCauses.push({
      type: "PENDING_PAYOUT",
      title: `Scheduled Payout: ${p.vendor || "Vendor"}`,
      amount: p.amount,
      dueDate: p.scheduledDate.toISOString(),
      description: `Payout to ${p.vendor} scheduled for ${p.scheduledDate.toLocaleDateString("en-IN")}.`,
      counterpartyName: p.vendor,
    });
  }

  // If deficit exists but list is empty, add deficit root cause
  if (rootCauses.length === 0 && hasDeficit && projectedDeficitDate) {
    rootCauses.push({
      type: "NEGATIVE_CASHFLOW",
      title: "Projected Cash Deficit",
      dueDate: projectedDeficitDate,
      description: `Projected cash balance will drop below zero on ${new Date(projectedDeficitDate).toLocaleDateString("en-IN")}.`,
    });
  }

  // 6. Find AI Recommended Strategy
  let recommendedStrategy: RecommendedStrategySummary | null = null;
  try {
    // The same selection the app plans with.
    //
    // This built its own library and had none of the app's rules: it offered
    // debts already recovered, any payout in any status, an expense with no
    // status check, and invoices at face value. An operator could therefore be
    // emailed a recommendation to collect money that had just arrived — the
    // very event that triggered the email.
    //
    // handledTransactionIds is read here too, so a recovery already settled or
    // in flight is not proposed again.
    let handledTransactionIds = new Set<string>();
    try {
      const handled = await prisma.paymentRecovery.findMany({
        where: {
          transaction: { businessId: business.id },
          status: { in: [...HANDLED_RECOVERY_STATUSES] },
        },
        select: { transactionId: true },
      });
      handledTransactionIds = new Set(handled.map((r) => r.transactionId));
    } catch {
      // Same asymmetry the planner reasons about: offering an already-settled
      // debt is recoverable, producing no recommendation at all is not.
    }

    const { library } = buildActionLibrary({
      transactions,
      invoices,
      payouts,
      handledTransactionIds,
    });

    const scoredStrategies = generateStrategies(business.currentCash, movements, library, now, requiredBuffer);
    if (scoredStrategies.length > 0) {
      // Scored, not "the first one with actions".
      //
      // Picking the first non-empty plan meant the email could name a different
      // strategy from the one the app recommends for the same ledger — and did
      // so without any scoring, so it could name a plan that leaves the
      // business below its safety floor while the app recommends one that does
      // not.
      const ranked = scoreAllStrategies(scoredStrategies, requiredBuffer, [], movements);
      const topStrategyName = ranked.find((s) => s.recommended)?.name ?? ranked[0]?.name;
      const topStrategy =
        scoredStrategies.find((s) => s.name === topStrategyName) ?? scoredStrategies[0];
      const stratRunwayDays = topStrategy.runway?.firstDayBelowSafety ?? FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS;
      recommendedStrategy = {
        id: `strategy_${topStrategy.name.toLowerCase()}`,
        title: topStrategy.name.replace(/_/g, " "),
        actionCount: topStrategy.actions.length,
        expectedRunwayChangeDays: Math.max(0, stratRunwayDays - runwayDays),
        expectedDeficitReductionPaise: Math.max(0, topStrategy.projectedBalance - runwayMetrics.minimumBalance),
        requiresApproval: topStrategy.actions.length > 0,
      };
    }
  } catch {
    // Non-fatal if strategies cannot be generated
  }

  return {
    businessId: business.id,
    businessName: business.name,
    severity,
    crisisType,
    crisisKey,
    currentBalance: business.currentCash,
    safetyBuffer: requiredBuffer,
    runwayDays,
    projectedDeficitDate,
    firstBelowSafetyDate,
    rootCauses,
    criticalObligations: {
      count: temporalMetrics.criticalObligationsCount,
      amount: temporalMetrics.criticalObligationsAmount,
      protected: temporalMetrics.criticalObligationsProtected,
    },
    recommendedStrategy,
    assessedAt: now.toISOString(),
    confidenceScore: 1.0,
  };
}
