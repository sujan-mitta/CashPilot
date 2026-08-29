import { addDays } from "date-fns";
import { buildForecast, DailyMovement, calculateRunway, ForecastDay, RunwayMetrics } from "./forecast";
import { calculateRisk, RiskLevel } from "./riskDetector";
import { FINANCIAL_CONFIG } from "./financialConfig";

/**
 * The canonical strategy names. Single source of truth (PART 37): anything that
 * needs to enumerate or bucket strategies must import this rather than retyping
 * the literals, which is how the strategy-performance endpoint ended up
 * silently matching nothing.
 */
export const STRATEGY_NAMES = [
  "DO_NOTHING",
  "RECOVER_ONLY",
  "RECOVER_AND_COLLECT",
  "FULL_INTERVENTION",
] as const;

export type StrategyName = (typeof STRATEGY_NAMES)[number];

export interface ActionDefinition {
  type: "RECOVER_FAILED_PAYMENTS" | "PRIORITIZE_COLLECTIONS" | "RESCHEDULE_PAYOUT" | "PAUSE_EXPENSE";
  amount: number; // in paise
  label: string;
  targetPayoutId?: string;
  targetTransactionId?: string;
  rescheduleDelayDays?: number;
}

export interface DeferredObligation {
  sourceId: string;
  amount: number;
  originalDueDate: Date;
  newDueDate: Date;
  daysBeyondHorizon: number;
}

export interface StrategyResult {
  name: StrategyName;
  actions: ActionDefinition[];
  projectedBalance: number; // closing balance of last day (in paise)
  riskLevel: RiskLevel;
  runway: RunwayMetrics;
  forecast: ForecastDay[];
  error?: string; // Explicit strategy error tracker
  deferredObligations?: DeferredObligation[];
}

/**
 * Clones and applies actions to the baseline cash movements.
 */
export function applyActionsToMovements(
  baseMovements: DailyMovement[],
  actions: ActionDefinition[],
  startDate: Date
): DailyMovement[] {
  const movements = baseMovements.map((m) => ({ ...m }));

  actions.forEach((action) => {
    if (action.type === "RECOVER_FAILED_PAYMENTS") {
      // Pull recovered failed payment forward to Day 2 as an inflow
      movements.push({
        date: addDays(startDate, 2),
        inflows: action.amount,
        outflows: 0,
        description: "Recovered failed payment (Action)",
        isRecovered: true,
        transactionId: action.targetTransactionId,
      });
    }

    if (action.type === "PRIORITIZE_COLLECTIONS") {
      // Pull overdue invoice collections forward to Day 1 as an inflow
      movements.push({
        date: addDays(startDate, 1),
        inflows: action.amount,
        outflows: 0,
        description: "Accelerated collection (Action)",
        isAccelerated: true,
      });
    }

    if (action.type === "RESCHEDULE_PAYOUT") {
      if (action.amount === 0) return;

      const targetId = action.targetTransactionId || action.targetPayoutId;
      const idx = movements.findIndex((m) => {
        if (targetId) return m.transactionId === targetId;
        // Fallback for backward compatibility in existing tests
        return m.outflows >= action.amount && m.description?.includes("Packaging Co");
      });

      if (idx >= 0) {
        const originalMovement = movements[idx];
        // Remove the outflow from original date
        movements[idx] = {
          ...originalMovement,
          outflows: originalMovement.outflows - action.amount,
        };
        // Add to the new rescheduled date. The default is the SAME constant the
        // executor applies, so the simulated date and the date the ledger
        // actually receives can no longer disagree.
        const delayDays =
          action.rescheduleDelayDays !== undefined
            ? action.rescheduleDelayDays
            : FINANCIAL_CONFIG.RESCHEDULE_DELAY_DAYS;
        movements.push({
          date: addDays(startDate, delayDays),
          inflows: 0,
          outflows: action.amount,
          description: `Rescheduled payout: ${originalMovement.description || "Vendor Payout"}`,
          transactionId: targetId,
        });
      } else {
        throw new Error("RESCHEDULE_TARGET_NOT_FOUND");
      }
    }

    if (action.type === "PAUSE_EXPENSE") {
      if (action.amount === 0) return;

      const targetId = action.targetTransactionId || action.targetPayoutId;
      const idx = movements.findIndex((m) => {
        if (targetId) return m.transactionId === targetId;
        // Fallback for backward compatibility in existing tests
        return m.outflows >= action.amount && m.description?.includes("SaaS");
      });

      if (idx >= 0) {
        const originalMovement = movements[idx];
        movements[idx] = {
          ...originalMovement,
          outflows: originalMovement.outflows - action.amount,
        };
      }
    }
  });

  return movements;
}

export function generateStrategies(
  currentCash: number,
  baseMovements: DailyMovement[],
  library: {
    recoverFailedPayments: number;
    prioritizeCollections: number;
    reschedulePayout: number;
    pauseExpense: number;
    recoverFailedPaymentsId?: string;
    reschedulePayoutId?: string;
    rescheduleTransactionId?: string;
    pauseExpenseId?: string;
    rescheduleDelayDays?: number;
  },
  startDate: Date = new Date(),
  safetyThreshold?: number
): StrategyResult[] {
  const strategies: { name: StrategyResult["name"]; actions: ActionDefinition[] }[] = [
    { name: "DO_NOTHING", actions: [] },
    {
      name: "RECOVER_ONLY",
      actions: [
        {
          type: "RECOVER_FAILED_PAYMENTS",
          amount: library.recoverFailedPayments,
          label: "Orchestrate recovery links for failed customer payments",
          targetTransactionId: library.recoverFailedPaymentsId,
        },
      ],
    },
    {
      name: "RECOVER_AND_COLLECT",
      actions: [
        {
          type: "RECOVER_FAILED_PAYMENTS",
          amount: library.recoverFailedPayments,
          label: "Orchestrate recovery links for failed customer payments",
          targetTransactionId: library.recoverFailedPaymentsId,
        },
        {
          type: "PRIORITIZE_COLLECTIONS",
          amount: library.prioritizeCollections,
          label: "Accelerate high-priority overdue collections",
        },
      ],
    },
    {
      name: "FULL_INTERVENTION",
      actions: [
        {
          type: "RECOVER_FAILED_PAYMENTS",
          amount: library.recoverFailedPayments,
          label: "Orchestrate recovery links for failed customer payments",
          targetTransactionId: library.recoverFailedPaymentsId,
        },
        {
          type: "PRIORITIZE_COLLECTIONS",
          amount: library.prioritizeCollections,
          label: "Accelerate high-priority overdue collections",
        },
        {
          type: "RESCHEDULE_PAYOUT",
          amount: library.reschedulePayout,
          label: "De-prioritize & reschedule non-critical Packaging Co payout",
          targetPayoutId: library.reschedulePayoutId,
          targetTransactionId: library.rescheduleTransactionId,
          rescheduleDelayDays: library.rescheduleDelayDays,
        },
        {
          type: "PAUSE_EXPENSE",
          amount: library.pauseExpense,
          label: "Pause operational SaaS/recurring subscriptions",
          targetTransactionId: library.pauseExpenseId,
        },
      ],
    },
  ];

  return strategies.map((s) => {
    try {
      const simulatedMovements = applyActionsToMovements(baseMovements, s.actions, startDate);
      const forecast = buildForecast(
        currentCash,
        simulatedMovements,
        FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
        startDate
      );
      const runway = calculateRunway(forecast, safetyThreshold);
      const projectedBalance = forecast[forecast.length - 1]?.closingBalance ?? 0;

      const deferredObligations: DeferredObligation[] = [];
      const horizonDate = addDays(startDate, FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS);

      s.actions.forEach((action) => {
        if (action.type === "RESCHEDULE_PAYOUT") {
          const targetId = action.targetTransactionId || action.targetPayoutId;
          const originalMovement = baseMovements.find((m) => {
            if (targetId) return m.transactionId === targetId;
            return m.outflows >= action.amount && m.description?.includes("Packaging Co");
          });

          if (originalMovement) {
            const originalDueDate = originalMovement.date;
            const delayDays =
              action.rescheduleDelayDays !== undefined
                ? action.rescheduleDelayDays
                : FINANCIAL_CONFIG.RESCHEDULE_DELAY_DAYS;
            const newDueDate = addDays(startDate, delayDays);

            if (newDueDate.getTime() > horizonDate.getTime()) {
              const diffMs = newDueDate.getTime() - horizonDate.getTime();
              const daysBeyondHorizon = Math.round(diffMs / (1000 * 60 * 60 * 24));
              deferredObligations.push({
                sourceId: targetId || originalMovement.transactionId || action.targetPayoutId || "unknown",
                amount: action.amount,
                originalDueDate,
                newDueDate,
                daysBeyondHorizon,
              });
            }
          }
        }
      });

      return {
        name: s.name,
        actions: s.actions,
        projectedBalance,
        riskLevel: calculateRisk(runway.minimumBalance, safetyThreshold),
        runway,
        forecast,
        deferredObligations,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        name: s.name,
        actions: s.actions,
        projectedBalance: 0,
        riskLevel: "HIGH" as const,
        runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: 0, minimumBalanceDay: 1 },
        forecast: [],
        error: errMsg,
      };
    }
  });
}
