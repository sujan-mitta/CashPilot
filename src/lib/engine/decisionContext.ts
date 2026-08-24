import { FINANCIAL_CONFIG } from "./financialConfig";
import { calculateLiquiditySafetyRequirement, extractObligations } from "./liquiditySafety";
import {
  computeContextFingerprint,
  DecisionContext,
  ContextObligation,
  ContextActionTarget,
  ContextMovement,
  FingerprintDetail,
} from "./strategyFreshness";

export interface ContextActionInput {
  type: string;
  amount: number;
  targetPayoutId?: string | null;
  targetTransactionId?: string | null;
}

/**
 * Gathers the financial facts a recommendation rests on and fingerprints them.
 *
 * Used at BOTH ends of the freshness check - once when the decision is created
 * and again at approval/execution - so the two sides are computed by identical
 * code from identical sources. Any divergence in how the two were assembled
 * would show up as spurious staleness.
 */
export async function buildDecisionContext(
  client: any,
  businessId: string,
  options: {
    strategyType: string;
    actions: ContextActionInput[];
    today?: Date;
    /** Reuse an already-computed buffer instead of recomputing it. */
    requiredBuffer?: number;
  }
): Promise<FingerprintDetail> {
  const today = options.today ?? new Date();
  let incomplete = false;

  const business = await client.business.findUnique({ where: { id: businessId } });
  if (!business) {
    incomplete = true;
  }

  let transactions: any[] = [];
  let payouts: any[] = [];
  try {
    transactions = (await client.transaction?.findMany({ where: { businessId } })) ?? [];
  } catch {
    incomplete = true;
  }
  try {
    payouts = (await client.payout?.findMany({ where: { businessId } })) ?? [];
  } catch {
    incomplete = true;
  }

  let requiredBuffer = options.requiredBuffer;
  if (requiredBuffer === undefined) {
    try {
      const safety = await calculateLiquiditySafetyRequirement(businessId, client, today);
      requiredBuffer = safety.requiredBuffer;
    } catch {
      incomplete = true;
      requiredBuffer = FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR;
    }
  }

  // Obligations, reduced to identity + the fields that change a recommendation.
  const obligations: ContextObligation[] = extractObligations(payouts, transactions, today).map(
    (o) => {
      const payout = payouts.find((p: any) => p.id === o.sourceId);
      return {
        sourceType: payout ? ("PAYOUT" as const) : ("TRANSACTION" as const),
        sourceId: o.sourceId,
        amount: o.amount,
        dueDate: o.dueDate.toISOString().split("T")[0],
        criticality: o.priority,
        status: payout
          ? payout.status
          : transactions.find((t: any) => t.id === o.sourceId)?.status ?? "UNKNOWN",
      };
    }
  );

  // The specific records each action manipulates. If one of these vanishes or
  // has already settled, the plan is acting on a world that no longer exists.
  const actionTargets: ContextActionTarget[] = options.actions.map((a) => {
    if (a.targetPayoutId) {
      const payout = payouts.find((p: any) => p.id === a.targetPayoutId);
      return {
        actionType: a.type,
        targetType: "PAYOUT" as const,
        targetId: a.targetPayoutId,
        amount: payout?.amount ?? a.amount,
        targetStatus: payout?.status ?? null,
        targetExists: !!payout,
      };
    }
    if (a.targetTransactionId) {
      const tx = transactions.find((t: any) => t.id === a.targetTransactionId);
      return {
        actionType: a.type,
        targetType: "TRANSACTION" as const,
        targetId: a.targetTransactionId,
        amount: tx?.amount ?? a.amount,
        targetStatus: tx?.status ?? null,
        targetExists: !!tx,
      };
    }
    // PRIORITIZE_COLLECTIONS acts on the whole overdue set rather than one row.
    return {
      actionType: a.type,
      targetType: a.type === "PRIORITIZE_COLLECTIONS" ? ("INVOICE_SET" as const) : ("NONE" as const),
      targetId: null,
      amount: a.amount,
      targetStatus: null,
      targetExists: true,
    };
  });

  // Every movement, identified absolutely. No rolling window, so the clock
  // advancing cannot by itself make a strategy look stale.
  const movements: ContextMovement[] = transactions
    .filter((t: any) => typeof t?.id === "string")
    .map((t: any) => ({
      id: t.id,
      amount: t.amount ?? 0,
      type: t.type,
      status: t.status,
      date: new Date(t.expectedDate).toISOString().split("T")[0],
    }));

  const context: DecisionContext = {
    strategyType: options.strategyType,
    startingCash: business?.currentCash ?? 0,
    requiredBuffer: requiredBuffer ?? FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR,
    forecastHorizonDays: FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
    movements,
    obligations,
    actionTargets,
    engineVersion: FINANCIAL_CONFIG.ENGINE_VERSION,
    scoringConfigVersion: FINANCIAL_CONFIG.SCORING_CONFIG_VERSION,
    liquidityConfigVersion: FINANCIAL_CONFIG.LIQUIDITY_CONFIG_VERSION,
    ...(incomplete ? { incomplete: true } : {}),
  };

  return computeContextFingerprint(context);
}

export interface ObligationSnapshotEntry {
  id: string;
  sourceType: "PAYOUT" | "TRANSACTION";
  sourceId: string;
  amount: number;
  originalDueDate: string;
  criticality: "CRITICAL" | "HIGH" | "NORMAL";
  /** What the recommendation intended to happen to this obligation. */
  expectedAction: "PROTECT" | "RESCHEDULE" | "PAUSE";
  statusAtDecision: string;
}

/**
 * Snapshots the critical obligations a recommendation is responsible for
 * (PART 16), with stable identity so each one can later be checked against the
 * ledger individually. Aggregate counts alone cannot be verified after the fact,
 * which is why `actualCriticalObligationsProtected` was stuck at null.
 */
export function buildObligationSnapshot(
  context: DecisionContext
): ObligationSnapshotEntry[] {
  const rescheduled = new Set(
    context.actionTargets
      .filter((t) => t.actionType === "RESCHEDULE_PAYOUT" && t.targetId)
      .map((t) => t.targetId as string)
  );
  const paused = new Set(
    context.actionTargets
      .filter((t) => t.actionType === "PAUSE_EXPENSE" && t.targetId)
      .map((t) => t.targetId as string)
  );

  return context.obligations
    .filter((o) => o.criticality === "CRITICAL" || o.criticality === "HIGH")
    .map((o) => ({
      id: `${o.sourceType}:${o.sourceId}`,
      sourceType: o.sourceType,
      sourceId: o.sourceId,
      amount: o.amount,
      originalDueDate: o.dueDate,
      criticality: o.criticality,
      expectedAction: rescheduled.has(o.sourceId)
        ? ("RESCHEDULE" as const)
        : paused.has(o.sourceId)
        ? ("PAUSE" as const)
        : ("PROTECT" as const),
      statusAtDecision: o.status,
    }));
}
