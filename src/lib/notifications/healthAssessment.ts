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
    const recoverableFailures = transactions.filter((t) => t.status === "FAILED" && t.type === "INFLOW");
    const failedAmount = recoverableFailures[0]?.amount ?? 0;
    const overdueAmount = invoices
      .filter((i) => i.status === "OVERDUE" || (i.status !== "PAID" && new Date(i.dueDate) < now))
      .reduce((sum, i) => sum + i.amount, 0);
    const packagingPayout = payouts.find((p) => p.vendor === "Packaging Co") || payouts[0];
    const pauseTx = transactions.find((t) => t.description?.includes("SaaS") && t.type === "OUTFLOW");

    const library = {
      recoverFailedPayments: failedAmount,
      prioritizeCollections: overdueAmount,
      reschedulePayout: packagingPayout?.amount ?? 0,
      pauseExpense: pauseTx?.amount ?? 0,
      recoverFailedPaymentsId: recoverableFailures[0]?.id,
      reschedulePayoutId: packagingPayout?.id,
      pauseExpenseId: pauseTx?.id,
    };

    const scoredStrategies = generateStrategies(business.currentCash, movements, library, now, requiredBuffer);
    if (scoredStrategies.length > 0) {
      const topStrategy = scoredStrategies.find((s) => s.actions.length > 0) || scoredStrategies[0];
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
