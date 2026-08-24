import { addDays } from "date-fns";
import { SCORING_CONFIG } from "./scorer";
import { FINANCIAL_CONFIG } from "./financialConfig";
import { ForecastDay, DailyMovement } from "./forecast";
import {
  FinancialRecordReader,
  PayoutRecord,
  TransactionRecord,
} from "../db/records";

export interface LiquiditySafetyRequirement {
  requiredBuffer: number;
  methodology: string;
  averageDailyOutflow: number;
  coverageDays: number;
  absoluteFloorApplied: boolean;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  dataWarnings: string[];
}

export interface CashObligation {
  id: string;
  amount: number;
  dueDate: Date;
  type: "PAYOUT" | "PAYROLL" | "TAX" | "RENT" | "LOAN" | "EXPENSE" | "OTHER";
  priority: "CRITICAL" | "HIGH" | "NORMAL";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  sourceId: string;
}

/**
 * Calculates a scale-appropriate, mathematically justified liquidity safety requirement.
 * 
 * Uses a hybrid model combining:
 * 1. Historical run-rate of successful outflows in the last 30 days (70% weight)
 * 2. Projected upcoming scheduled outflows in the next 14 days (30% weight)
 * 
 * Ensures the safety buffer scales gracefully with the size/volume of the business.
 */
export async function calculateLiquiditySafetyRequirement(
  businessId: string,
  prismaClient: FinancialRecordReader,
  today: Date = new Date()
): Promise<LiquiditySafetyRequirement> {
  const dataWarnings: string[] = [];
  let confidence: "HIGH" | "MEDIUM" | "LOW" = "HIGH";

  // Defensive check for transaction client presence (common in unit tests with partial mocks)
  let historicalTransactions: TransactionRecord[] = [];
  if (prismaClient.transaction) {
    const thirtyDaysAgo = addDays(today, -FINANCIAL_CONFIG.HISTORICAL_LOOKBACK_DAYS);
    historicalTransactions = await prismaClient.transaction.findMany({
      where: {
        businessId,
        type: "OUTFLOW",
        status: "SUCCESS",
        expectedDate: {
          gte: thirtyDaysAgo,
          lte: today,
        },
      },
    });
  } else {
    dataWarnings.push("Transaction database client not available.");
  }

  const totalHistoricalOutflow = historicalTransactions.reduce((sum: number, t: TransactionRecord) => sum + t.amount, 0);
  const historicalDailyOutflow = totalHistoricalOutflow / FINANCIAL_CONFIG.HISTORICAL_LOOKBACK_DAYS;

  // Defensive checks for projected transactions and payouts
  let projectedTransactions: TransactionRecord[] = [];
  let projectedPayouts: PayoutRecord[] = [];

  const fourteenDaysLater = addDays(today, FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS);
  if (prismaClient.transaction) {
    projectedTransactions = await prismaClient.transaction.findMany({
      where: {
        businessId,
        type: "OUTFLOW",
        status: "PENDING",
        expectedDate: {
          gte: today,
          lte: fourteenDaysLater,
        },
      },
    });
  }

  if (prismaClient.payout) {
    projectedPayouts = await prismaClient.payout.findMany({
      where: {
        businessId,
        status: "SCHEDULED",
        scheduledDate: {
          gte: today,
          lte: fourteenDaysLater,
        },
      },
    });
  } else {
    dataWarnings.push("Payout database client not available.");
  }

  const totalProjectedOutflow =
    projectedTransactions.reduce((sum: number, t: TransactionRecord) => sum + t.amount, 0) +
    projectedPayouts.reduce((sum: number, p: PayoutRecord) => sum + p.amount, 0);
  const projectedDailyOutflow = totalProjectedOutflow / FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS;

  // 3. Compute weighted daily run-rate
  let averageDailyOutflow = 0;
  let methodology = "";

  if (historicalTransactions.length > 0) {
    // Weighted model: 70% historical run-rate, 30% upcoming schedule
    averageDailyOutflow = 0.7 * historicalDailyOutflow + 0.3 * projectedDailyOutflow;
    methodology = "Weighted 70% historical run-rate (30-day) and 30% projected outflows (14-day).";
    if (historicalTransactions.length < 5) {
      confidence = "MEDIUM";
      dataWarnings.push("Limited historical outflow data points (less than 5 transactions).");
    }
  } else if (totalProjectedOutflow > 0) {
    // Projected-only model
    averageDailyOutflow = projectedDailyOutflow;
    methodology = "No historical outflow data available; using 100% projected scheduled outflows (14-day).";
    confidence = "MEDIUM";
    dataWarnings.push("No historical outflow data; safety buffer estimated purely from future projections.");
  } else {
    // Zero activity model
    averageDailyOutflow = 0;
    methodology = "No operating outflows detected (historical or projected).";
    confidence = "LOW";
    dataWarnings.push("Zero operating outflows detected; using absolute minimum floor.");
  }

  // Check for large outliers in historical data to warn the business of skewness
  if (historicalTransactions.length > 0) {
    const maxHistorical = Math.max(...historicalTransactions.map((t) => t.amount));
    if (maxHistorical > FINANCIAL_CONFIG.OUTLIER_MULTIPLE * averageDailyOutflow && averageDailyOutflow > 0) {
      dataWarnings.push("Large historical transaction outlier detected; safety buffer may be slightly elevated.");
      confidence = "MEDIUM";
    }
  }

  // 4. Apply safety buffer coverage days and floor
  let requiredBuffer = Math.round(averageDailyOutflow * SCORING_CONFIG.SAFETY_BUFFER_COVERAGE_DAYS);
  let absoluteFloorApplied = false;

  if (requiredBuffer < SCORING_CONFIG.SAFETY_BUFFER_MIN_FLOOR) {
    requiredBuffer = SCORING_CONFIG.SAFETY_BUFFER_MIN_FLOOR;
    absoluteFloorApplied = true;
  }

  return {
    requiredBuffer,
    methodology,
    averageDailyOutflow: Math.round(averageDailyOutflow),
    coverageDays: SCORING_CONFIG.SAFETY_BUFFER_COVERAGE_DAYS,
    absoluteFloorApplied,
    confidence,
    dataWarnings,
  };
}

/**
 * Extracts obligations from the database payout and pending transaction lists.
 */
export function extractObligations(
  payouts: PayoutRecord[],
  transactions: TransactionRecord[],
  today: Date = new Date()
): CashObligation[] {
  const obligations: CashObligation[] = [];
  const dataWarnings: string[] = [];

  // 1. Process Payouts
  payouts.forEach((p) => {
    if (p.status === "SCHEDULED" || p.status === "RESCHEDULED") {
      if (p.amount <= 0) return; // Exclude negative or zero amounts

      let priority: CashObligation["priority"] = "NORMAL";
      if (p.criticality === "HIGH") {
        priority = "CRITICAL";
      } else if (p.criticality === "MEDIUM") {
        priority = "HIGH";
      }

      let type: CashObligation["type"] = "PAYOUT";
      const vendorLower = p.vendor?.toLowerCase() || "";
      if (vendorLower.includes("payroll") || vendorLower.includes("salary")) {
        type = "PAYROLL";
      } else if (vendorLower.includes("tax") || vendorLower.includes("gst")) {
        type = "TAX";
      } else if (vendorLower.includes("rent")) {
        type = "RENT";
      }

      if (!p.scheduledDate) {
        dataWarnings.push(`Payout ${p.id} has missing due date; excluding.`);
        return;
      }

      obligations.push({
        id: `payout-${p.id}`,
        amount: p.amount,
        dueDate: new Date(p.scheduledDate),
        type,
        priority,
        confidence: "HIGH",
        sourceId: p.id,
      });
    }
  });

  // 2. Process Pending Outflow Transactions
  transactions.forEach((t) => {
    if (t.type === "OUTFLOW" && t.status === "PENDING") {
      if (t.amount <= 0) return; // Exclude negative or zero amounts

      // Excluded before the duplicate comparison rather than after it. The old
      // ordering computed `new Date(t.expectedDate)` on a possibly-null value -
      // harmless in practice, because the guard below discarded the row anyway,
      // but it meant the comparison ran against the epoch. Guarding first states
      // the intent and removes the null dereference.
      if (!t.expectedDate) {
        dataWarnings.push(`Transaction ${t.id} has missing due date; excluding.`);
        return;
      }
      const expectedDate = new Date(t.expectedDate);

      // Prevent double counting against payouts
      const isDuplicate = obligations.some(
        (o) => o.sourceId === t.id || (o.amount === t.amount && Math.abs(o.dueDate.getTime() - expectedDate.getTime()) < 1000 * 60 * 60)
      );

      if (!isDuplicate) {
        let type: CashObligation["type"] = "EXPENSE";
        const descLower = t.description?.toLowerCase() || "";
        if (descLower.includes("saas") || descLower.includes("recurring") || descLower.includes("subscription")) {
          type = "EXPENSE";
        }

        obligations.push({
          id: `tx-${t.id}`,
          amount: t.amount,
          dueDate: expectedDate,
          type,
          priority: "NORMAL",
          confidence: "MEDIUM",
          sourceId: t.id,
        });
      }
    }
  });

  return obligations;
}

/**
 * Resolves the required liquidity curve day-by-day based on upcoming critical obligations.
 * Employs identity-based target exclusions to prevent double-counting.
 */
export function calculateTemporalRequiredLiquidity(
  forecast: ForecastDay[],
  movements: DailyMovement[],
  obligations: CashObligation[],
  operationalBuffer: number,
  startDate: Date = new Date()
): {
  requiredLiquidityByDay: number[];
  criticalObligationsCount: number;
  criticalObligationsAmount: number;
  criticalObligationsProtected: boolean;
  firstCriticalDate: string | null;
  criticalAmount: number;
} {
  const horizonDays = forecast.length;
  const requiredLiquidityByDay: number[] = new Array(horizonDays).fill(operationalBuffer);

  // Normalize startDate to start of day in UTC
  const startUtc = new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate()
  ));

  const horizonEnd = addDays(startUtc, horizonDays);

  // Filter for critical/high priority obligations due within the forecast horizon
  const criticalInHorizon = obligations.filter((o) => {
    const isCritical = o.priority === "CRITICAL" || o.priority === "HIGH";
    const inHorizon = o.dueDate >= startUtc && o.dueDate <= horizonEnd;
    return isCritical && inHorizon && o.amount > 0;
  });

  // Calculate required liquidity day-by-day
  for (let d = 0; d < horizonDays; d++) {
    const dayDate = new Date(startUtc.getTime() + (d + 1) * 24 * 60 * 60 * 1000);
    let maxRequiredForDay = operationalBuffer;

    for (let t = d; t < horizonDays; t++) {
      const targetDate = new Date(startUtc.getTime() + (t + 1) * 24 * 60 * 60 * 1000);
      
      // Include obligations due in the future window STRICTLY after dayDate
      const activeObligations = criticalInHorizon.filter((o) => {
        const oDate = new Date(Date.UTC(o.dueDate.getUTCFullYear(), o.dueDate.getUTCMonth(), o.dueDate.getUTCDate()));
        const dDate = new Date(Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth(), dayDate.getUTCDate()));
        return oDate > dDate && oDate <= targetDate;
      });
      const totalObligationAmount = activeObligations.reduce((sum, o) => sum + o.amount, 0);

      let inflows = 0;
      let outflowsExcludingObligations = 0;

      // Exclude current day movements since they are already committed to closing balance of day d
      for (let i = d + 1; i <= t; i++) {
        const currentDayDate = new Date(startUtc.getTime() + (i + 1) * 24 * 60 * 60 * 1000);
        const dayMovements = movements.filter((m) => {
          return (
            m.date.getUTCFullYear() === currentDayDate.getUTCFullYear() &&
            m.date.getUTCMonth() === currentDayDate.getUTCMonth() &&
            m.date.getUTCDate() === currentDayDate.getUTCDate()
          );
        });

        inflows += dayMovements.reduce((sum, m) => sum + m.inflows, 0);
        
        // Exclude active obligation outflows to prevent double counting
        const dayOutflows = dayMovements.reduce((sum, m) => {
          const isObligationOutflow = activeObligations.some((o) => o.sourceId === m.transactionId);
          return sum + (isObligationOutflow ? 0 : m.outflows);
        }, 0);
        outflowsExcludingObligations += dayOutflows;
      }

      const netMovements = inflows - outflowsExcludingObligations;
      const required = operationalBuffer + totalObligationAmount - netMovements;
      if (required > maxRequiredForDay) {
        maxRequiredForDay = required;
      }
    }

    requiredLiquidityByDay[d] = Math.round(maxRequiredForDay);
  }

  const sortedCritical = [...criticalInHorizon].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const firstCritical = sortedCritical[0] || null;

  // Verify protection status of each obligation
  let criticalObligationsProtected = true;
  criticalInHorizon.forEach((o) => {
    const day = forecast.find((f) => {
      return (
        f.date.getUTCFullYear() === o.dueDate.getUTCFullYear() &&
        f.date.getUTCMonth() === o.dueDate.getUTCMonth() &&
        f.date.getUTCDate() === o.dueDate.getUTCDate()
      );
    });
    if (day && day.closingBalance < 0) {
      criticalObligationsProtected = false;
    }
  });

  return {
    requiredLiquidityByDay,
    criticalObligationsCount: criticalInHorizon.length,
    criticalObligationsAmount: criticalInHorizon.reduce((sum, o) => sum + o.amount, 0),
    criticalObligationsProtected,
    firstCriticalDate: firstCritical ? firstCritical.dueDate.toISOString().split("T")[0] : null,
    criticalAmount: firstCritical ? firstCritical.amount : 0,
  };
}
