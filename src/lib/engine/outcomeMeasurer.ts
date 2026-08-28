import { prisma } from "../prisma";
import { buildForecast, DailyMovement } from "./forecast";
import { FINANCIAL_CONFIG, isUsableAmount, safeRatio } from "./financialConfig";
import {
  transitionDecision,
  validateDecisionTransition,
  InvalidDecisionTransitionError,
} from "./decisionStateMachine";
import { DecisionStatus, OutcomePhase, Prisma } from "../../../generated/prisma/client";
import {
  measureObligationSnapshot,
  summariseObligationOutcomes,
  ObligationRecordReader,
  ObligationOutcome,
  ObligationSummary,
} from "./obligationOutcome";

/**
 * Shapes of the Json snapshot columns.
 *
 * Prisma types a Json column as JsonValue, which carries no structure. These
 * interfaces record what the engine actually writes into those columns, so that
 * reading a snapshot back is checked rather than assumed. They are intentionally
 * tolerant (every field optional): a snapshot written by an older engine version
 * may be missing fields, and measurement must degrade to "unknown", never crash.
 */
export interface DeferredObligationItem {
  sourceId?: string;
  amount?: number;
  originalDueDate?: string | Date | null;
  newDueDate?: string | Date | null;
}

interface ForecastSnapshot {
  startingCash?: number;
  minimumBalance?: number;
  deficitDays?: number;
  requiredLiquidity?: number;
  deferredObligations?: DeferredObligationItem[] | { items?: DeferredObligationItem[] };
}

interface ExecutionSnapshotShape {
  outcome?: string;
  requiresManualVerification?: boolean;
}

/** Narrows a Json column to a snapshot. An absent or non-object value reads as empty. */
function readSnapshot<T extends object>(value: unknown): T {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : ({} as T);
}

/**
 * Outcome status.
 *
 * PARTIALLY_MEASURED exists because a deferred obligation can land *after* the
 * measurement window closes. Claiming SUCCESS while a rescheduled liability is
 * still unobserved would be exactly the dishonesty PRINCIPLE 3 forbids
 * ("deficit elimination != liability elimination").
 */
export type OutcomePhaseValue =
  | "NOT_STARTED"
  | "WINDOW_OPEN"
  | "WINDOW_COMPLETE"
  | "POST_HORIZON_PENDING"
  | "FINAL_MEASURED"
  | "UNRESOLVED_AFTER_WINDOW";

export type OutcomeStatus =
  | "SUCCESS"
  | "PARTIAL_SUCCESS"
  | "PARTIALLY_MEASURED"
  | "FAILED"
  | "OUTCOME_PENDING"
  | "REJECTED"
  | "NOT_EXECUTED"
  | "RECONCILIATION_MISMATCH";

/**
 * Solvency and safety are reported as SEPARATE dimensions (PART 15/17).
 * A business holding Rs 1 is solvent but nowhere near safe; collapsing the two
 * into one boolean is how a system ends up calling a near-miss a success.
 */
export type SolvencyStatus = "SOLVENT" | "INSOLVENT" | "UNKNOWN";
export type SafetyStatus = "ABOVE_SAFETY_BUFFER" | "BELOW_SAFETY_BUFFER" | "UNKNOWN";
export type BaselineComparison = "IMPROVED" | "UNCHANGED" | "WORSE" | "UNKNOWN";

export interface DeferredObligationOutcome {
  sourceId: string;
  amount: number;
  originalDueDate: string;
  predictedNewDueDate: string;
  /** Was the obligation observable inside the measurement window at all? */
  measurable: boolean;
  /**
   * HELD          - still deferred to (at least) the predicted date.
   * SETTLED_EARLY - the liability came due sooner than the plan promised.
   * BEYOND_WINDOW - falls after the measurement window; genuinely unmeasured.
   * UNVERIFIABLE  - the underlying record no longer exists / cannot be read.
   */
  verdict: "HELD" | "SETTLED_EARLY" | "BEYOND_WINDOW" | "UNVERIFIABLE";
  observedDueDate: string | null;
  observedStatus: string | null;
}

export interface ActualOutcomePayload {
  status: OutcomeStatus;

  /** Independent dimensions. Never collapse these. */
  solvency: SolvencyStatus;
  safety: SafetyStatus;
  vsBaseline: BaselineComparison;

  /**
   * Measured financial reality. `null` means "not measured", never 0.
   * PART 22: a missing figure must not be silently substituted with zero,
   * because zero is a legible and reassuring balance in its own right.
   */
  actualMinimumBalance: number | null;
  actualFinalBalance: number | null;
  actualDeficitDays: number | null;
  actualCoverageRatio: number | null;

  /**
   * DERIVED from per-obligation evidence (PART 17). Null only when the decision
   * carries no obligation snapshot to check against.
   */
  actualCriticalObligationsProtected: number | null;
  obligationOutcomes: ObligationOutcome[];
  obligationSummary: ObligationSummary | null;

  /** MEASURED deferred obligation outcomes - never copied from the prediction. */
  deferredObligationOutcomes: DeferredObligationOutcome[];
  unmeasuredDeferredCount: number;
  unmeasuredDeferredAmount: number;

  predictionError: {
    minimumBalance: number | null;
    deficitDays: number | null;
  };

  varianceClassification: "LOW_VARIANCE" | "HIGH_VARIANCE_OUTCOME" | "UNKNOWN";
  measurementCompleteness: "COMPLETE" | "PARTIAL" | "NOT_STARTED";
  /** Mirrors Decision.outcomePhase so a stored payload is self-describing. */
  outcomePhase: OutcomePhaseValue;
  /** The horizon THIS decision is measured over; may exceed the forecast horizon. */
  outcomeHorizonDays: number;
  /** Only settled money counted; see `evidenceBasis`. */
  evidenceBasis: string;
  dataWarnings: string[];
  measuredAt: string | null;
  /** Engine version that produced the MEASUREMENT (not the decision). */
  measurementEngineVersion: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Movements from VERIFIED money only.
 *
 * PART 11 / PRINCIPLE 5: actual outcome may only be built from settled financial
 * facts. A PENDING inflow is an intent, not cash; counting it would let an
 * unpaid invoice masquerade as a recovered one. Outflows are treated as real
 * once they are no longer FAILED, because an unpaid bill still burdens the
 * business and understating outflows would flatter the result.
 */
export function verifiedMovements(
  transactions: {
    id?: string;
    amount: number;
    type: "INFLOW" | "OUTFLOW";
    status: string;
    expectedDate: Date;
    description?: string | null;
  }[]
): { movements: DailyMovement[]; ignoredUnsettledInflows: number } {
  const movements: DailyMovement[] = [];
  let ignoredUnsettledInflows = 0;

  for (const t of transactions) {
    if (!isUsableAmount(t.amount)) continue;

    if (t.type === "INFLOW") {
      if (t.status !== "SUCCESS") {
        // PENDING or FAILED inflow: money we have not actually received.
        if (t.status !== "FAILED") ignoredUnsettledInflows++;
        continue;
      }
      movements.push({
        date: new Date(t.expectedDate),
        inflows: t.amount,
        outflows: 0,
        description: t.description || undefined,
        transactionId: t.id,
      });
    } else {
      if (t.status === "FAILED") continue; // cancelled/paused outflow
      movements.push({
        date: new Date(t.expectedDate),
        inflows: 0,
        outflows: t.amount,
        description: t.description || undefined,
        transactionId: t.id,
      });
    }
  }

  return { movements, ignoredUnsettledInflows };
}

/**
 * Verifies each PREDICTED deferred obligation against the live record.
 *
 * This is the only honest way to answer "did the deferral actually hold?".
 * Reading the count back out of our own prediction - which is what a naive
 * implementation does - measures nothing at all.
 */
export async function measureDeferredObligations(
  client: ObligationRecordReader,
  predictedDeferred: DeferredObligationItem[],
  windowEnd: Date
): Promise<DeferredObligationOutcome[]> {
  const results: DeferredObligationOutcome[] = [];

  for (const item of predictedDeferred || []) {
    const sourceId: string = item?.sourceId ?? "unknown";
    const amount: number = isUsableAmount(item?.amount) ? item.amount : 0;
    const originalDueDate = item?.originalDueDate ? new Date(item.originalDueDate) : null;
    const predictedNewDueDate = item?.newDueDate ? new Date(item.newDueDate) : null;

    const base: DeferredObligationOutcome = {
      sourceId,
      amount,
      originalDueDate: originalDueDate ? originalDueDate.toISOString().split("T")[0] : "unknown",
      predictedNewDueDate: predictedNewDueDate
        ? predictedNewDueDate.toISOString().split("T")[0]
        : "unknown",
      measurable: false,
      verdict: "UNVERIFIABLE",
      observedDueDate: null,
      observedStatus: null,
    };

    // The predicted landing date is outside the window we can observe.
    // PART 12: this stays visible and unmeasured rather than being assumed good.
    if (predictedNewDueDate && predictedNewDueDate.getTime() > windowEnd.getTime()) {
      results.push({ ...base, verdict: "BEYOND_WINDOW" });
      continue;
    }

    let observedDate: Date | null = null;
    let observedStatus: string | null = null;

    try {
      const payout = client?.payout
        ? await client.payout.findFirst({ where: { id: sourceId } })
        : null;
      if (payout) {
        observedDate = new Date(payout.scheduledDate);
        observedStatus = payout.status;
      } else {
        const tx = client?.transaction
          ? await client.transaction.findFirst({ where: { id: sourceId } })
          : null;
        if (tx) {
          observedDate = new Date(tx.expectedDate);
          observedStatus = tx.status;
        }
      }
    } catch {
      // Fall through as UNVERIFIABLE rather than guessing.
    }

    if (!observedDate) {
      results.push(base);
      continue;
    }

    const observed = {
      ...base,
      measurable: true,
      observedDueDate: observedDate.toISOString().split("T")[0],
      observedStatus,
    };

    if (predictedNewDueDate && observedDate.getTime() >= predictedNewDueDate.getTime()) {
      results.push({ ...observed, verdict: "HELD" });
    } else {
      // The liability came due earlier than the plan promised: the deferral
      // did not hold, and the cash relief we predicted did not materialise.
      results.push({ ...observed, verdict: "SETTLED_EARLY" });
    }
  }

  return results;
}

/**
 * Deterministically measures the actual financial outcome of a decision once the
 * measurement window has closed.
 *
 * Idempotent: once a decision is OUTCOME_MEASURED it is returned untouched.
 * Never rewrites baselineSnapshot / recommendedSnapshot / engineVersion.
 */
/**
 * A measured decision. Prisma types the `actualOutcome` column as an opaque
 * JsonValue, but this function only ever writes an ActualOutcomePayload into it,
 * so the return type restores that structure for callers.
 */
export type MeasuredDecision = Omit<
  Prisma.DecisionGetPayload<{ include: { strategy: true } }>,
  "actualOutcome"
> & { actualOutcome: ActualOutcomePayload };

export async function measureDecisionOutcome(
  decisionId: string,
  todayOverride?: Date
): Promise<MeasuredDecision> {
  const decision = await prisma.decision.findUnique({
    where: { id: decisionId },
    include: { strategy: true },
  });

  if (!decision) {
    throw new Error("Decision not found.");
  }

  // Idempotency: history is closed.
  if (decision.status === "OUTCOME_MEASURED") {
    return decision as unknown as MeasuredDecision;
  }

  const today = todayOverride || new Date();

  // PART 19: the outcome horizon is a property of THIS decision. A strategy that
  // pushed an obligation to day 20 needs day 20 measured, even though the
  // forecast itself remains a 14-day document.
  const outcomeHorizonDays =
    typeof decision.outcomeMeasurementHorizonDays === "number" &&
    decision.outcomeMeasurementHorizonDays > 0
      ? decision.outcomeMeasurementHorizonDays
      : FINANCIAL_CONFIG.OUTCOME_WINDOW_DAYS;

  const forecastWindowEnd = new Date(
    decision.createdAt.getTime() + FINANCIAL_CONFIG.OUTCOME_WINDOW_DAYS * MS_PER_DAY
  );
  const outcomeWindowEnd = new Date(
    decision.createdAt.getTime() + outcomeHorizonDays * MS_PER_DAY
  );

  // ---------------------------------------------------------------------
  // Window still open: record that we have NOT measured, using nulls.
  // No status transition happens here - a decision does not become
  // OUTCOME_MEASURED just because someone looked at it.
  // ---------------------------------------------------------------------
  // The forecast window has closed but a deferred obligation still lies ahead.
  // The decision is not finished being measured, and must not be closed out.
  if (today >= forecastWindowEnd && today < outcomeWindowEnd) {
    const interim: ActualOutcomePayload = {
      status: "PARTIALLY_MEASURED",
      solvency: "UNKNOWN",
      safety: "UNKNOWN",
      vsBaseline: "UNKNOWN",
      actualMinimumBalance: null,
      actualFinalBalance: null,
      actualDeficitDays: null,
      actualCoverageRatio: null,
      actualCriticalObligationsProtected: null,
      obligationOutcomes: [],
      obligationSummary: null,
      deferredObligationOutcomes: [],
      unmeasuredDeferredCount: 0,
      unmeasuredDeferredAmount: 0,
      predictionError: { minimumBalance: null, deficitDays: null },
      varianceClassification: "UNKNOWN",
      measurementCompleteness: "PARTIAL",
      outcomePhase: "POST_HORIZON_PENDING",
      outcomeHorizonDays,
      evidenceBasis:
        "Forecast window closed; deferred obligations still lie ahead of the outcome horizon.",
      dataWarnings: [
        `Forecast window (${FINANCIAL_CONFIG.OUTCOME_WINDOW_DAYS} days) has closed, but this decision deferred an obligation to day ${outcomeHorizonDays}. Measurement continues.`,
      ],
      measuredAt: null,
      measurementEngineVersion: FINANCIAL_CONFIG.ENGINE_VERSION,
    };

    await prisma.decision.update({
      where: { id: decisionId },
      data: {
        actualOutcome: interim as unknown as Prisma.InputJsonValue,
        outcomePhase: OutcomePhase.POST_HORIZON_PENDING,
      },
    });
    return (await prisma.decision.findUnique({
      where: { id: decisionId },
      include: { strategy: true },
    })) as unknown as MeasuredDecision;
  }

  if (today < outcomeWindowEnd) {
    const pendingOutcome: ActualOutcomePayload = {
      status: "OUTCOME_PENDING",
      solvency: "UNKNOWN",
      safety: "UNKNOWN",
      vsBaseline: "UNKNOWN",
      actualMinimumBalance: null,
      actualFinalBalance: null,
      actualDeficitDays: null,
      actualCoverageRatio: null,
      actualCriticalObligationsProtected: null,
      obligationOutcomes: [],
      obligationSummary: null,
      deferredObligationOutcomes: [],
      unmeasuredDeferredCount: 0,
      unmeasuredDeferredAmount: 0,
      predictionError: { minimumBalance: null, deficitDays: null },
      varianceClassification: "UNKNOWN",
      measurementCompleteness: "NOT_STARTED",
      outcomePhase: "WINDOW_OPEN",
      outcomeHorizonDays: outcomeHorizonDays,
      evidenceBasis: "Not yet measured.",
      dataWarnings: [
        `Outcome measurement window (${FINANCIAL_CONFIG.OUTCOME_WINDOW_DAYS} days) is still open.`,
      ],
      measuredAt: null,
      measurementEngineVersion: FINANCIAL_CONFIG.ENGINE_VERSION,
    };

    await prisma.decision.update({
      where: { id: decisionId },
      data: {
        actualOutcome: pendingOutcome as unknown as Prisma.InputJsonValue,
        outcomePhase: OutcomePhase.WINDOW_OPEN,
      },
    });
    return (await prisma.decision.findUnique({
      where: { id: decisionId },
      include: { strategy: true },
    })) as unknown as MeasuredDecision;
  }

  // A decision that cannot legally reach OUTCOME_MEASURED is left alone rather
  // than force-mutated (PART 3).
  if (!validateDecisionTransition(decision.status, DecisionStatus.OUTCOME_MEASURED)) {
    throw new InvalidDecisionTransitionError(
      decision.status,
      DecisionStatus.OUTCOME_MEASURED
    );
  }

  const baseline = readSnapshot<ForecastSnapshot>(decision.baselineSnapshot);
  const recommended = readSnapshot<ForecastSnapshot>(decision.recommendedSnapshot);
  const dataWarnings: string[] = [];

  const transactions = await prisma.transaction.findMany({
    where: {
      businessId: decision.businessId,
      expectedDate: { gte: decision.createdAt, lte: outcomeWindowEnd },
    },
  });

  if (transactions.length === 0) {
    dataWarnings.push("No transaction history found within the outcome window.");
  }

  const { movements, ignoredUnsettledInflows } = verifiedMovements(transactions);
  if (ignoredUnsettledInflows > 0) {
    dataWarnings.push(
      `${ignoredUnsettledInflows} inflow(s) were still unsettled at measurement time and were excluded from actuals.`
    );
  }

  const startingCash = isUsableAmount(baseline.startingCash) ? baseline.startingCash : null;
  if (startingCash === null) {
    dataWarnings.push("Baseline starting cash is unavailable; balances cannot be reconstructed.");
  }

  let actualMinimumBalance: number | null = null;
  let actualFinalBalance: number | null = null;
  let actualDeficitDays: number | null = null;

  if (startingCash !== null) {
    const actualDays = buildForecast(
      startingCash,
      movements,
      FINANCIAL_CONFIG.OUTCOME_WINDOW_DAYS,
      decision.createdAt
    );
    if (actualDays.length > 0) {
      actualMinimumBalance = Math.min(...actualDays.map((d) => d.closingBalance));
      actualFinalBalance = actualDays[actualDays.length - 1].closingBalance;
      actualDeficitDays = actualDays.filter((d) => d.closingBalance < 0).length;
    }
  }

  // -------------------------------------------------------------------------
  // Deferred obligations: verified against live records (PART 13).
  // -------------------------------------------------------------------------
  // Two shapes are in the wild: a bare array (older engine) and { items } (current).
  const predictedDeferred: DeferredObligationItem[] = Array.isArray(
    recommended.deferredObligations
  )
    ? recommended.deferredObligations
    : Array.isArray(recommended.deferredObligations?.items)
    ? recommended.deferredObligations.items
    : [];

  const deferredObligationOutcomes = await measureDeferredObligations(
    prisma,
    predictedDeferred,
    outcomeWindowEnd
  );

  const unmeasured = deferredObligationOutcomes.filter(
    (d) => d.verdict === "BEYOND_WINDOW" || d.verdict === "UNVERIFIABLE"
  );
  const unmeasuredDeferredAmount = unmeasured.reduce((sum, d) => sum + d.amount, 0);
  const brokenDeferrals = deferredObligationOutcomes.filter((d) => d.verdict === "SETTLED_EARLY");

  if (unmeasured.length > 0) {
    dataWarnings.push(
      `${unmeasured.length} deferred obligation(s) fall outside the measurement window and remain unverified.`
    );
  }
  if (brokenDeferrals.length > 0) {
    dataWarnings.push(
      `${brokenDeferrals.length} deferred obligation(s) came due earlier than the plan promised.`
    );
  }

  // -------------------------------------------------------------------------
  // Independent dimensions (PART 15/17). Do not collapse.
  // -------------------------------------------------------------------------
  const requiredLiquidity = isUsableAmount(baseline.requiredLiquidity)
    ? baseline.requiredLiquidity
    : null;

  const solvency: SolvencyStatus =
    actualMinimumBalance === null ? "UNKNOWN" : actualMinimumBalance >= 0 ? "SOLVENT" : "INSOLVENT";

  let safety: SafetyStatus = "UNKNOWN";
  if (actualMinimumBalance !== null && requiredLiquidity !== null) {
    safety =
      actualMinimumBalance >= requiredLiquidity ? "ABOVE_SAFETY_BUFFER" : "BELOW_SAFETY_BUFFER";
  } else if (requiredLiquidity === null) {
    dataWarnings.push("Required liquidity is unavailable; safety status cannot be determined.");
  }

  const baselineMinimum = isUsableAmount(baseline.minimumBalance) ? baseline.minimumBalance : null;
  const baselineDeficitDays = isUsableAmount(baseline.deficitDays) ? baseline.deficitDays : null;

  let vsBaseline: BaselineComparison = "UNKNOWN";
  if (actualMinimumBalance !== null && baselineMinimum !== null) {
    if (actualMinimumBalance > baselineMinimum) vsBaseline = "IMPROVED";
    else if (actualMinimumBalance < baselineMinimum) vsBaseline = "WORSE";
    else vsBaseline = "UNCHANGED";
  }

  const actualCoverageRatio = safeRatio(actualMinimumBalance, requiredLiquidity);

  const predictedMinimum = isUsableAmount(recommended.minimumBalance)
    ? recommended.minimumBalance
    : null;
  const predictedDeficitDays = isUsableAmount(recommended.deficitDays)
    ? recommended.deficitDays
    : null;

  const minBalanceError =
    actualMinimumBalance !== null && predictedMinimum !== null
      ? actualMinimumBalance - predictedMinimum
      : null;
  const deficitDaysError =
    actualDeficitDays !== null && predictedDeficitDays !== null
      ? actualDeficitDays - predictedDeficitDays
      : null;

  let varianceClassification: ActualOutcomePayload["varianceClassification"] = "UNKNOWN";
  if (minBalanceError !== null && startingCash !== null && startingCash !== 0) {
    varianceClassification =
      Math.abs(minBalanceError) > Math.abs(startingCash) * FINANCIAL_CONFIG.OUTCOME_VARIANCE_THRESHOLD
        ? "HIGH_VARIANCE_OUTCOME"
        : "LOW_VARIANCE";
    if (varianceClassification === "HIGH_VARIANCE_OUTCOME") {
      dataWarnings.push(
        "Actual minimum balance deviated significantly from the simulation prediction."
      );
    }
  }

  // PART 16-17: each snapshotted obligation is checked against its live record
  // and the aggregate DERIVED from those verdicts. Nothing is copied from the
  // prediction.
  const obligationSnapshot: unknown[] = Array.isArray(decision.obligationSnapshot)
    ? decision.obligationSnapshot
    : [];

  const obligationOutcomes = await measureObligationSnapshot(
    prisma,
    obligationSnapshot,
    outcomeWindowEnd
  );
  const obligationSummary =
    obligationOutcomes.length > 0 ? summariseObligationOutcomes(obligationOutcomes) : null;

  const actualCriticalObligationsProtected = obligationSummary
    ? obligationSummary.protectedCount
    : null;

  if (obligationSnapshot.length === 0) {
    dataWarnings.push(
      "This decision carries no obligation snapshot, so critical-obligation protection cannot be verified."
    );
  }
  if (obligationSummary && obligationSummary.unresolvedCount > 0) {
    dataWarnings.push(
      `${obligationSummary.unresolvedCount} critical obligation(s) could not be resolved within the measurement horizon.`
    );
  }
  if (obligationSummary?.criticalBreach) {
    dataWarnings.push("A critical obligation was demonstrably breached.");
  }

  // -------------------------------------------------------------------------
  // Classification.
  //
  // Ordering matters. Decision-level terminal facts win first (a rejected
  // decision has no financial outcome of its own to grade). Then genuine
  // regression. Then incompleteness. Only a fully measured, solvent,
  // deficit-free, liability-free result may be called SUCCESS.
  // -------------------------------------------------------------------------
  // PRECEDENCE (PART 20), highest first. Each rung is mutually exclusive with
  // the ones below it, so no two rules can ever fire and disagree:
  //
  //   1. decision-level terminal facts  - a rejected decision has no financial
  //                                       outcome of its own to grade
  //   2. no reliable actual data        - PARTIALLY_MEASURED, never FAILED
  //   3. critical obligation breached   - FAILED regardless of balances
  //   4. worse than doing nothing       - FAILED
  //   5. unresolved external execution  - cannot be SUCCESS
  //   6. broken deferral                - cannot be SUCCESS
  //   7. unmeasured deferred liability  - cannot be SUCCESS
  //   8. solvent and deficit-free       - SUCCESS
  //   9. improved but not whole         - PARTIAL_SUCCESS
  //  10. otherwise                      - FAILED
  let status: OutcomeStatus;

  const executionUnresolved =
    readSnapshot<ExecutionSnapshotShape>(decision.executionSnapshot).outcome ===
      "EXECUTION_UNKNOWN" ||
    readSnapshot<ExecutionSnapshotShape>(decision.executionSnapshot)
      .requiresManualVerification === true;

  if (decision.status === "REJECTED") {
    status = "REJECTED";
  } else if (decision.status === "NOT_EXECUTED") {
    status = "NOT_EXECUTED";
  } else if (decision.status === "RECONCILIATION_MISMATCH") {
    status = "RECONCILIATION_MISMATCH";
  } else if (actualMinimumBalance === null) {
    status = "PARTIALLY_MEASURED";
    dataWarnings.push("Actual balances could not be reconstructed from available data.");
  } else if (obligationSummary?.criticalBreach) {
    // A breached critical obligation is a failure even if the balance looks fine.
    status = "FAILED";
  } else if (vsBaseline === "WORSE") {
    status = "FAILED";
  } else if (executionUnresolved) {
    // PRINCIPLE 10 / PART 20: we do not know whether the money moved, so we
    // certainly do not know that the intervention worked.
    status = "PARTIALLY_MEASURED";
    dataWarnings.push(
      "External execution was never resolved; the outcome cannot be certified."
    );
  } else if (brokenDeferrals.length > 0) {
    status = "PARTIAL_SUCCESS";
  } else if (unmeasured.length > 0 || (obligationSummary?.unresolvedCount ?? 0) > 0) {
    status = "PARTIALLY_MEASURED";
  } else if (solvency === "SOLVENT" && actualDeficitDays === 0) {
    status = "SUCCESS";
  } else if (
    vsBaseline === "IMPROVED" ||
    (baselineDeficitDays !== null &&
      actualDeficitDays !== null &&
      actualDeficitDays < baselineDeficitDays)
  ) {
    status = "PARTIAL_SUCCESS";
  } else {
    status = "FAILED";
  }

  const stillUnresolved =
    unmeasured.length > 0 ||
    actualMinimumBalance === null ||
    (obligationSummary?.unresolvedCount ?? 0) > 0 ||
    executionUnresolved;

  const measurementCompleteness: ActualOutcomePayload["measurementCompleteness"] =
    stillUnresolved ? "PARTIAL" : "COMPLETE";

  // The outcome horizon has passed. Anything still unresolved now is
  // permanently unresolved - there is no later window to wait for.
  const outcomePhase: OutcomePhaseValue = stillUnresolved
    ? "UNRESOLVED_AFTER_WINDOW"
    : "FINAL_MEASURED";

  const outcomePayload: ActualOutcomePayload = {
    status,
    solvency,
    safety,
    vsBaseline,
    actualMinimumBalance,
    actualFinalBalance,
    actualDeficitDays,
    actualCoverageRatio: actualCoverageRatio === null ? null : parseFloat(actualCoverageRatio.toFixed(4)),
    actualCriticalObligationsProtected,
    obligationOutcomes,
    obligationSummary,
    deferredObligationOutcomes,
    unmeasuredDeferredCount: unmeasured.length,
    unmeasuredDeferredAmount,
    predictionError: { minimumBalance: minBalanceError, deficitDays: deficitDaysError },
    varianceClassification,
    measurementCompleteness,
    outcomePhase,
    outcomeHorizonDays,
    evidenceBasis:
      "Settled inflows only (status=SUCCESS); non-cancelled outflows; deferred obligations verified against live payout/transaction records.",
    dataWarnings,
    measuredAt: today.toISOString(),
    measurementEngineVersion: FINANCIAL_CONFIG.ENGINE_VERSION,
  };

  // Decision.status closes only now, when measurement has genuinely finished -
  // either everything resolved, or the horizon passed with evidence permanently
  // unavailable. OUTCOME_MEASURED is terminal, so it is written exactly once.
  await transitionDecision(
    prisma,
    { id: decisionId },
    DecisionStatus.OUTCOME_MEASURED,
    {
      actualOutcome: outcomePayload as unknown as Prisma.InputJsonValue,
      outcomeMeasuredAt: today,
      finalOutcomeMeasuredAt: today,
      outcomePhase: outcomePhase as OutcomePhase,
    },
    {
      audit: {
        actorType: "SYSTEM",
        metadata: {
          outcomeStatus: status,
          outcomePhase,
          outcomeHorizonDays,
          protectedObligations: actualCriticalObligationsProtected,
        },
      },
    }
  );

  return (await prisma.decision.findUnique({
    where: { id: decisionId },
    include: { strategy: true },
  })) as unknown as MeasuredDecision;
}
