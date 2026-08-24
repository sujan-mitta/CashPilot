import { FINANCIAL_CONFIG } from "./financialConfig";

export interface DailyMovement {
  date: Date;
  inflows: number; // in paise
  outflows: number; // in paise
  description?: string;
  isRecovered?: boolean;
  isAccelerated?: boolean;
  transactionId?: string;
}

export interface ForecastDay {
  date: Date;
  openingBalance: number; // in paise
  expectedInflows: number; // in paise
  expectedOutflows: number; // in paise
  closingBalance: number; // in paise
}

export interface RunwayMetrics {
  firstDayBelowSafety: number | null; // Day index (1-based) or null
  crisisDay: number | null; // Day index (1-based) or null
  minimumBalance: number; // in paise
  minimumBalanceDay: number; // Day index (1-based)
}

// Single source of truth lives in financialConfig.ts (Phase 14, PART 37).
const SAFETY_THRESHOLD = FINANCIAL_CONFIG.SAFETY_THRESHOLD;

/**
 * Transforms transaction records into DailyMovements.
 * For the committed view, failed transactions are excluded.
 * For the simulated view, we can overlay recovery actions.
 */
export function transactionsToMovements(
  transactions: { id?: string; amount: number; type: "INFLOW" | "OUTFLOW"; status: string; expectedDate: Date; description: string | null }[]
): DailyMovement[] {
  return transactions
    .filter((t) => t.status !== "FAILED") // failed transactions are not committed inflows
    .map((t) => ({
      date: new Date(t.expectedDate),
      inflows: t.type === "INFLOW" ? t.amount : 0,
      outflows: t.type === "OUTFLOW" ? t.amount : 0,
      description: t.description || undefined,
      transactionId: t.id,
    }));
}

/**
 * Builds a day-by-day cash forecast for the specified number of days (default 14).
 */
export function buildForecast(
  currentCash: number,
  movements: DailyMovement[],
  daysCount: number = FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
  startDate: Date = new Date()
): ForecastDay[] {
  const forecast: ForecastDay[] = [];
  let runningBalance = currentCash;

  // Normalize startDate to start of day in UTC
  const startUtc = new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate()
  ));

  for (let i = 1; i <= daysCount; i++) {
    // Generate dayDate in UTC
    const dayTime = startUtc.getTime() + i * 24 * 60 * 60 * 1000;
    const dayDate = new Date(dayTime);

    // Filter movements using timezone-stable UTC date parts
    const dayMovements = movements.filter((m) => {
      const d = m.date;
      return (
        d.getUTCFullYear() === dayDate.getUTCFullYear() &&
        d.getUTCMonth() === dayDate.getUTCMonth() &&
        d.getUTCDate() === dayDate.getUTCDate()
      );
    });

    const inflows = dayMovements.reduce((sum, m) => sum + m.inflows, 0);
    const outflows = dayMovements.reduce((sum, m) => sum + m.outflows, 0);

    const opening = runningBalance;
    const closing = opening + inflows - outflows;

    forecast.push({
      date: dayDate,
      openingBalance: opening,
      expectedInflows: inflows,
      expectedOutflows: outflows,
      closingBalance: closing,
    });

    runningBalance = closing;
  }

  return forecast;
}

/**
 * Computes the cash runway and crisis days.
 */
export function calculateRunway(
  forecast: ForecastDay[],
  safetyThreshold: number = SAFETY_THRESHOLD
): RunwayMetrics {
  let firstDayBelowSafety: number | null = null;
  let crisisDay: number | null = null;
  let minimumBalance = forecast[0]?.openingBalance ?? 0;
  let minimumBalanceDay = 1;

  forecast.forEach((day, index) => {
    const dayNumber = index + 1; // 1-based day index

    if (day.closingBalance < safetyThreshold && firstDayBelowSafety === null) {
      firstDayBelowSafety = dayNumber;
    }

    if (day.closingBalance < 0 && crisisDay === null) {
      crisisDay = dayNumber;
    }

    if (day.closingBalance < minimumBalance) {
      minimumBalance = day.closingBalance;
      minimumBalanceDay = dayNumber;
    }
  });

  return {
    firstDayBelowSafety,
    crisisDay,
    minimumBalance,
    minimumBalanceDay,
  };
}
