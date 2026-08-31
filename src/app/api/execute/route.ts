import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runAgent } from "@/lib/ai/agents";
import { actionNarratorPrompt } from "@/lib/ai/prompts";
import { ActionStatus, Prisma } from "../../../../generated/prisma/client";
import { addDays } from "date-fns";
import { getSession } from "@/lib/auth";
import { buildForecast } from "@/lib/engine/forecast";
import { buildMovementsForBusiness } from "@/lib/forecast/movements";
import { validateActionTransition } from "@/lib/engine/stateTransitions";
import { transitionDecision, InvalidDecisionTransitionError } from "@/lib/engine/decisionStateMachine";
import { DecisionStatus, DecisionEventType } from "../../../../generated/prisma/client";
import { FINANCIAL_CONFIG, isUsableAmount } from "@/lib/engine/financialConfig";
import { assertFinanciallySafeConfiguration, ConfigurationError } from "@/lib/config/productionConfig";
import { executeAction } from "@/lib/execution/actionExecutors";
import { sweepAbandonedIntents } from "@/lib/execution/executionIntent";
import { reconcileUnknownIntent } from "@/lib/execution/executor";
import { ExecutionIntentStatus } from "../../../../generated/prisma/client";
import { checkStrategyFreshness, recordStaleBlock, describeStaleness } from "@/lib/engine/freshnessGate";
import { formatINR } from "@/lib/format";
import { logger, withCorrelationId } from "@/lib/observability";
import { errorMessage, parseJsonBody } from "@/lib/errors";

/** One action's outcome, as returned to the client. */
/**
 * A step that never began, as distinct from one that ran and failed.
 *
 * Deliberately not a member of the ActionStatus enum: it describes THIS
 * execution attempt, not the action, whose own status is authoritative and
 * untouched.
 */
export const STEP_NOT_STARTED = "NOT_STARTED";

export interface ExecutedStep {
  id: string;
  action: string;
  status: string;
  result: string;
  narration: string;
  /** Provider ids this step produced. Empty when nothing was dispatched. */
  externalRefs: string[];
  /** Durable intent ids, for correlating with the reconciliation trail. */
  intentIds: string[];
}

export const POST = withCorrelationId(async (req: Request) => {
  try {
    // Execution moves money. If a production deployment is missing a control
    // that guards that, refuse rather than proceed with the guard disabled.
    try {
      assertFinanciallySafeConfiguration();
    } catch (err) {
      if (err instanceof ConfigurationError) {
        return NextResponse.json(
          { error: err.code, message: err.message, missing: err.missing },
          { status: 503 }
        );
      }
      throw err;
    }

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = await parseJsonBody<{ strategyId?: unknown }>(req);
    if (!parsed.ok) return parsed.response;
    const { strategyId } = parsed.data;

    // strategyId must be a non-empty string. A number/array/object would reach
    // Prisma as a mistyped id and surface as a 500; reject it as a 400 here.
    if (typeof strategyId !== "string" || strategyId.trim() === "") {
      return NextResponse.json({ error: "Missing or invalid strategyId parameter." }, { status: 400 });
    }

    const business = await prisma.business.findUnique({
      where: { id: session.businessId },
    });
    if (!business) {
      return NextResponse.json({ error: "Business not found." }, { status: 404 });
    }

    const strategy = await prisma.strategy.findFirst({
      where: { id: strategyId, businessId: business.id },
      include: { agentActions: true },
    });

    if (!strategy) {
      return NextResponse.json({ error: "Strategy not found." }, { status: 404 });
    }

    const before = strategy.projectedBalance;
    const executedSteps: ExecutedStep[] = [];
    /** Every durable intent touched by this run - the observability trail. */
    const executionIntentIds: string[] = [];

    // ------------------------------------------------------------------
    // Recovery pass, before anything else decides what to do.
    //
    // 1. sweep: anything still DISPATCHING past its deadline had its process
    //    die mid-call, so it becomes EXECUTION_UNKNOWN rather than staying
    //    invisibly in flight.
    // 2. reconcile: every UNKNOWN intent for THIS strategy is resolved against
    //    the provider by its stable idempotency key. This is a read - it asks
    //    "did our operation land?" and never re-issues it.
    //
    // Only after this can the run below see a truthful picture. An intent that
    // reconciliation could not resolve stays UNKNOWN and blocks re-dispatch.
    // ------------------------------------------------------------------
    await sweepAbandonedIntents(
      prisma,
      new Date(),
      FINANCIAL_CONFIG.INTENT_DISPATCH_TIMEOUT_MS,
      { businessId: business.id }
    );

    const unknownIntents = await prisma.executionIntent.findMany({
      where: { strategyId, status: ExecutionIntentStatus.UNKNOWN },
      select: { id: true },
    });
    const reconciliationResults: {
      intentId: string;
      resolution: string;
      intentStatusAfter: string;
      retrySafe: boolean;
      reason: string;
    }[] = [];
    for (const u of unknownIntents) {
      try {
        const r = await reconcileUnknownIntent(prisma, u.id);
        reconciliationResults.push({
          intentId: u.id,
          resolution: r.result.status,
          intentStatusAfter: r.intentStatusAfter,
          retrySafe: r.result.retrySafe,
          reason: r.result.reason,
        });
      } catch (err) {
        // Reconciliation failing leaves the intent UNKNOWN, which is the safe
        // state. It must never abort the request.
        logger.error("Reconciliation error for intent", { intentId: u.id, error: String(err) });
        reconciliationResults.push({
          intentId: u.id,
          resolution: "UNKNOWN",
          intentStatusAfter: "UNKNOWN",
          retrySafe: false,
          reason: "Reconciliation attempt threw; the outcome remains undetermined.",
        });
      }
    }

    // Financial State Drift Check
    const currentCash = business.currentCash;
    const originalCash = strategy.startingCash;
    // A zero/absent simulation baseline cannot be drift-checked proportionally,
    // so any movement at all is treated as material rather than skipped.
    const drift =
      isUsableAmount(originalCash) && originalCash > 0
        ? Math.abs(currentCash - originalCash) / originalCash
        : currentCash === originalCash
        ? 0
        : Number.POSITIVE_INFINITY;

    if (drift > FINANCIAL_CONFIG.EXECUTION_DRIFT_THRESHOLD) {
        await transitionDecision(prisma, { strategyId }, DecisionStatus.NOT_EXECUTED, {
          executionSnapshot: {
            outcome: "NOT_EXECUTED",
            error: "STATE_DRIFT_DETECTED",
            message: `Financial state has drifted materially (${Number.isFinite(drift) ? (drift * 100).toFixed(1) + "%" : "baseline unavailable"}) from the simulation baseline. Execution rejected.`,
          },
        });
        return NextResponse.json({
          error: "STATE_DRIFT_DETECTED",
          message: `Financial state has drifted materially (${Number.isFinite(drift) ? (drift * 100).toFixed(1) + "%" : "baseline unavailable"}) from the simulation baseline. Execution rejected.`,
      }, { status: 409 });
    }

    // Freshness gate (PART 11/14). Re-checked here even though approval already
    // ran it: the world can move between the click and this request, and this is
    // the boundary where money actually moves.
    //
    // Skipped once execution has already begun. Executing a strategy changes the
    // very records the fingerprint covers - a rescheduled payout, a paused
    // expense - so re-gating a resumed or duplicated run would flag the
    // strategy's OWN effects as staleness and break idempotency. Freshness was
    // already enforced at the boundary that mattered.
    const executionAlreadyStarted = strategy.agentActions.some(
      (a) =>
        a.status !== ActionStatus.PENDING &&
        a.status !== ActionStatus.APPROVED &&
        a.status !== ActionStatus.STALE
    );

    if (!executionAlreadyStarted) {
      const { verdict, blocked } = await checkStrategyFreshness(prisma, {
        businessId: business.id,
        strategyId,
        strategyType: strategy.name,
        actions: strategy.agentActions.map((a) => ({
          type: a.actionType,
          amount: a.amount,
          targetPayoutId: a.targetPayoutId,
          targetTransactionId: a.targetTransactionId,
        })),
      });

      if (blocked) {
        const decision = await prisma.decision.findFirst({ where: { strategyId } });
        if (decision) await recordStaleBlock(prisma, decision, verdict, session.userId);
        return NextResponse.json(
          {
            error: "STRATEGY_STALE",
            classification: verdict.classification,
            message: describeStaleness(verdict),
            changes: verdict.changes.filter((c) => c.severity !== "MINOR").slice(0, 10),
          },
          { status: 409 }
        );
      }
    }

    // Parameter Tampering & Validity Checks
    for (const action of strategy.agentActions) {
      if (action.amount <= 0) {
        await transitionDecision(prisma, { strategyId }, DecisionStatus.NOT_EXECUTED, {
          executionSnapshot: {
            outcome: "NOT_EXECUTED",
            error: "PARAMETER_TAMPERING",
            message: `Invalid execution parameter: Action amount must be greater than zero.`,
          },
        });
        return NextResponse.json({
          error: "PARAMETER_TAMPERING",
          message: `Invalid execution parameter: Action amount must be greater than zero.`,
        }, { status: 400 });
      }
      if (action.status === "REJECTED") {
        await transitionDecision(prisma, { strategyId }, DecisionStatus.NOT_EXECUTED, {
          executionSnapshot: {
            outcome: "NOT_EXECUTED",
            error: "REJECTED_ACTION_EXECUTION",
            message: `Cannot execute action ${action.id} because it was explicitly rejected.`,
          },
        });
        return NextResponse.json({
          error: "REJECTED_ACTION_EXECUTION",
          message: `Cannot execute action ${action.id} because it was explicitly rejected.`,
        }, { status: 400 });
      }
    }

    // Process each action in the strategy
    for (const action of strategy.agentActions) {
      // Validate transition to EXECUTING
      if (!validateActionTransition(action.status, ActionStatus.EXECUTING)) {
        if (action.status === ActionStatus.COMPLETED || action.status === ActionStatus.EXECUTED) {
          executedSteps.push({
            id: action.id,
            action: action.actionType,
            status: action.status,
            result: action.result || "",
            narration: `Action already completed.`,
            externalRefs: [],
            intentIds: [],
          });
          continue;
        }

        executedSteps.push({
          id: action.id,
          action: action.actionType,
          status: ActionStatus.FAILED,
          result: `State machine block: Cannot transition from ${action.status} to EXECUTING`,
          narration: `Validation check failed.`,
          externalRefs: [],
          intentIds: [],
        });
        continue;
      }

      // 1. Transition to EXECUTING conditionally, as a compare-and-set so that
      //    exactly one request may own the execution.
      //
      //    The claimable set must match what the state machine already permits
      //    into EXECUTING, or the two disagree and the stricter one silently
      //    wins. It previously admitted APPROVED alone while
      //    ALLOWED_TRANSITIONS[FAILED] = [EXECUTING] declared a retry legal - so
      //    a FAILED action passed the gate above, lost the claim here, and was
      //    reported as a "Concurrency block" that no concurrent request caused.
      //    A failed action could therefore never be retried at all.
      //
      //    Admitting FAILED does not weaken duplicate protection: the action
      //    status is workflow state, and it is the durable intent layer - a
      //    stable idempotency key plus the obligation guard - that decides
      //    whether anything is actually re-dispatched to the provider.
      const CLAIMABLE_STATUSES = [ActionStatus.APPROVED, ActionStatus.FAILED];

      const claimResult = await prisma.agentAction.updateMany({
        where: {
          id: action.id,
          status: { in: CLAIMABLE_STATUSES },
        },
        data: { status: ActionStatus.EXECUTING },
      });

      if (claimResult.count === 0) {
        const refetchedAct = await prisma.agentAction.findUnique({
          where: { id: action.id },
        });
        if (refetchedAct && (refetchedAct.status === ActionStatus.COMPLETED || refetchedAct.status === ActionStatus.EXECUTED)) {
          executedSteps.push({
            id: action.id,
            action: action.actionType,
            status: refetchedAct.status,
            result: refetchedAct.result || "",
            narration: `Action already completed.`,
            externalRefs: [],
            intentIds: [],
          });
          continue;
        }

        // Report WHY the claim was refused. "Concurrency block" described a race
        // for every one of these, which sent people looking for a second request
        // that does not exist. Each case below has a different remedy.
        const current = refetchedAct?.status;
        let reason: string;
        if (current === ActionStatus.EXECUTING) {
          // Not an error. A payment link is issued, not settled, so this action
          // sits in EXECUTING until the money is observed arriving.
          reason =
            "Already in flight: this action was claimed by an earlier execution and is awaiting settlement. Re-running it would not issue anything new; settle or cancel the outstanding payment link instead.";
        } else if (current === ActionStatus.EXECUTION_UNKNOWN) {
          reason =
            "The outcome of a previous attempt is undetermined and may already have taken effect. Reconcile it against the provider before it can run again.";
        } else if (current === ActionStatus.RECONCILING) {
          reason = "Settlement is reconciling this action right now.";
        } else {
          reason = `Not in a claimable state (current: ${current ?? "unavailable"}; claimable: ${CLAIMABLE_STATUSES.join(", ")}).`;
        }

        executedSteps.push({
          id: action.id,
          action: action.actionType,
          // NOT a failure, and no longer reported as one.
          //
          // This step did not start, which is not the same as the action
          // failing — in the commonest case the action is healthy and simply
          // already in flight, awaiting settlement of a link that exists. It
          // was previously reported as FAILED, which rendered a red badge on a
          // correct state and read as "execution broke". Observed live: an
          // operator re-ran the action repeatedly against a guard that was
          // right to refuse, because the screen said it had failed.
          //
          // ExecutedStep.status is a plain string on the API response and is
          // not persisted, so this value costs no migration and cannot reach
          // the AgentAction enum.
          status: STEP_NOT_STARTED,
          result: reason,
          narration: `Execution not started.`,
          externalRefs: [],
          intentIds: [],
        });
        continue;
      }

      // ------------------------------------------------------------------
      // Durable execution.
      //
      // executeAction records the INTENT before touching anything external, so
      // a crash between here and the provider leaves a recoverable row rather
      // than an invisible in-flight payment. It never retries an ambiguous
      // operation - that is reconciliation's job.
      // ------------------------------------------------------------------
      const outcome = await executeAction(
        prisma,
        { businessId: business.id, strategyId, action },
        {}
      );

      const status: ActionStatus = outcome.status;
      const resultDetail = outcome.result;
      executionIntentIds.push(...outcome.intentIds);

      // Record prediction vs actual metadata
      const predictionActual = {
        prediction: {
          projectedBalance: strategy.projectedBalance,
          riskLevel: strategy.riskLevel,
        },
        actual: null,
        error: null,
      };

      const auditEntry = {
        who: session.userId,
        what: `Transition EXECUTING -> ${status}`,
        when: new Date().toISOString(),
        why: `Action execution response details: ${resultDetail}`,
        result: status === ActionStatus.FAILED ? "FAILED" : status === ActionStatus.EXECUTION_UNKNOWN ? "UNKNOWN" : "SUCCESS",
      };

      const existingAudit = Array.isArray(action.auditLog) ? action.auditLog : [];

      // Mark action completion and save result log
      await prisma.agentAction.update({
        where: { id: action.id },
        data: {
          status,
          result: resultDetail,
          predictionActual: predictionActual as Prisma.InputJsonValue,
          auditLog: [...existingAudit, auditEntry] as Prisma.InputJsonValue,
        },
      });

      // Generate AI narration for this step
      const actionDetails = {
        actionType: action.actionType,
        amount: action.amount,
        label:
          action.actionType === "RECOVER_FAILED_PAYMENTS"
            ? "Recover failed payment"
            : action.actionType === "PRIORITIZE_COLLECTIONS"
            ? "Prioritize overdue collections"
            : action.actionType === "RESCHEDULE_PAYOUT"
            ? "Reschedule Packaging Co payout"
            : "Pause SaaS subscription",
      };

      // Every figure is derived from this action's own amount. The previous
      // hardcoded rupee values were correct only for the seed dataset and would
      // have shown a real business somebody else's numbers (PART 29).
      const actionAmountText = formatINR(action.amount);
      const fallbackNarrative =
        action.actionType === "RECOVER_FAILED_PAYMENTS"
          ? `Initiating automated payment recovery links for ${actionAmountText} via Razorpay.`
          : action.actionType === "PRIORITIZE_COLLECTIONS"
          ? `Broadcasting collection alerts and escalating priorities for ${actionAmountText} in overdue customer invoices.`
          : action.actionType === "RESCHEDULE_PAYOUT"
          ? `Negotiating rescheduling of the ${actionAmountText} vendor payout beyond the ${FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS}-day cycle.`
          : `Pausing non-essential operational subscriptions of ${actionAmountText}.`;

      const narration = await runAgent(
        actionNarratorPrompt(actionDetails),
        fallbackNarrative
      );

      executedSteps.push({
        id: action.id,
        action: action.actionType,
        status,
        result: resultDetail,
        narration,
        // Structured identifiers, so the client never has to parse them back
        // out of `result` prose. The execution page was doing
        // `result.split("generated: ")[1]`, which silently yielded null or
        // garbage on every non-happy path - and `result` is also where the
        // "Already in flight" / "Not in a claimable state" explanations go.
        externalRefs: outcome.externalRefs,
        intentIds: outcome.intentIds,
      });
    }

    // ------------------------------------------------------------------
    // Post-execution balances.
    //
    // PRINCIPLE 4/5: requesting a payment link is not receiving money. The
    // committed figure below therefore reflects ONLY the ledger as it actually
    // stands. The optimistic figure - what the balance becomes IF every
    // in-flight collection settles - is returned alongside it, explicitly
    // labelled, so the UI can never present a hope as a fact.
    // ------------------------------------------------------------------
    const updatedTransactions = await prisma.transaction.findMany({
      where: { businessId: business.id },
    });

    const today = new Date();
    const committedMovements = await buildMovementsForBusiness(prisma, business.id, updatedTransactions, { now: today });
    const committedForecast = buildForecast(
      business.currentCash,
      committedMovements,
      FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
      today
    );
    const committedAfterBalance =
      committedForecast[committedForecast.length - 1]?.closingBalance ?? business.currentCash;

    // Only actions that are genuinely in flight contribute to the optimistic
    // view. A FAILED or blocked action contributes nothing.
    const inFlightStatuses: string[] = [
      ActionStatus.EXECUTING,
      ActionStatus.EXECUTED,
      ActionStatus.RECONCILING,
      ActionStatus.COMPLETED,
    ];
    const inFlightSteps = executedSteps.filter((step) =>
      inFlightStatuses.includes(step.status as string)
    );

    const optimisticMovements = [...committedMovements];
    let pendingSettlementAmount = 0;
    for (const step of inFlightSteps) {
      const act = strategy.agentActions.find((a) => a.id === step.id);
      if (!act || !isUsableAmount(act.amount)) continue;
      if (act.actionType === "RECOVER_FAILED_PAYMENTS") {
        pendingSettlementAmount += act.amount;
        optimisticMovements.push({
          date: addDays(today, 2),
          inflows: act.amount,
          outflows: 0,
          description: "Recovery link issued - awaiting settlement",
        });
      } else if (act.actionType === "PRIORITIZE_COLLECTIONS") {
        pendingSettlementAmount += act.amount;
        optimisticMovements.push({
          date: addDays(today, 1),
          inflows: act.amount,
          outflows: 0,
          description: "Collection accelerated - awaiting settlement",
        });
      }
    }

    const optimisticForecast = buildForecast(
      business.currentCash,
      optimisticMovements,
      FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
      today
    );
    const afterIfAllSettles =
      optimisticForecast[optimisticForecast.length - 1]?.closingBalance ?? business.currentCash;

    // ------------------------------------------------------------------
    // Decision status.
    //
    // PRINCIPLE 10: unknown is not failed, and it is not executed either.
    // A single EXECUTION_UNKNOWN step means we genuinely do not know whether
    // money moved, so the decision stays at APPROVED and the operator is told
    // to verify rather than retry blindly.
    // ------------------------------------------------------------------
    const anyUnknown = executedSteps.some(
      (step) => step.status === ActionStatus.EXECUTION_UNKNOWN
    );
    const anyFailed = executedSteps.some((step) => step.status === ActionStatus.FAILED);

    const executionOutcome = anyUnknown
      ? "EXECUTION_UNKNOWN"
      : anyFailed
      ? "NOT_EXECUTED"
      : "EXECUTED";

    const executionSnapshot = {
      outcome: executionOutcome,
      steps: executedSteps,
      before,
      committedAfter: committedAfterBalance,
      afterIfAllSettles,
      pendingSettlementAmount,
      settlementConfirmed: false,
      requiresManualVerification: anyUnknown,
      // PART 30: enough to diagnose any external call this run made.
      executionIntentIds,
      reconciliationResults,
      timestamp: new Date().toISOString(),
    };

    if (executionOutcome === "EXECUTION_UNKNOWN") {
      // No status change. Record the attempt only.
      //
      // A concurrent request may already have driven the decision forward, in
      // which case refusing this write is the state machine working correctly -
      // not an error worth failing the request over.
      try {
        await transitionDecision(
        prisma,
        { strategyId },
        DecisionStatus.APPROVED,
        { executionSnapshot },
        {
          allowSnapshotOverwrite: true,
          audit: {
            eventType: DecisionEventType.EXECUTION_UNKNOWN,
            actorType: "SYSTEM",
            actorId: session.userId,
            metadata: { executionIntentIds, requiresManualVerification: true },
            },
          }
        );
      } catch (transitionError) {
        if (!(transitionError instanceof InvalidDecisionTransitionError)) throw transitionError;
        logger.warn("Execute: decision already advanced; unknown-execution attempt recorded on the action only.", { strategyId });
      }
    } else {
      // transitionDecision refuses EXECUTED -> NOT_EXECUTED, so a losing
      // concurrent request can no longer downgrade a decision that already
      // executed successfully.
      try {
        await transitionDecision(
          prisma,
          { strategyId },
          executionOutcome === "EXECUTED"
            ? DecisionStatus.EXECUTED
            : DecisionStatus.NOT_EXECUTED,
          { executionSnapshot },
          {
            allowSnapshotOverwrite: true,
            audit: {
              actorType: "SYSTEM",
              actorId: session.userId,
              metadata: { executionIntentIds, outcome: executionOutcome },
            },
          }
        );
      } catch (transitionError) {
        if (!(transitionError instanceof InvalidDecisionTransitionError)) throw transitionError;
        logger.warn("Execute: refused decision transition", { strategyId, error: transitionError.message });
      }
    }

    return NextResponse.json({
      steps: executedSteps,
      before,
      // `after` is the committed ledger position - money we actually hold.
      after: committedAfterBalance,
      afterIfAllSettles,
      pendingSettlementAmount,
      settlementConfirmed: false,
      executionOutcome,
      requiresManualVerification: anyUnknown,
      executionIntentIds,
    });
  } catch (error) {
    // An illegal decision transition is an expected CONFLICT, not a server
    // fault - e.g. trying to execute a strategy that is already reconciled. It
    // must be a clean 409 and must not leak the internal state-machine detail
    // (which named the exact from/to states to the client). No financial state
    // changed: the transition guard refused before any mutation.
    if (error instanceof InvalidDecisionTransitionError) {
      logger.warn("Execute refused by decision state machine", { reason: errorMessage(error) });
      return NextResponse.json(
        { error: "This strategy can no longer be executed in its current state." },
        { status: 409 }
      );
    }
    logger.error("API error in execute", { error: errorMessage(error) });
    return NextResponse.json({ error: "Execution failed. Please try again." }, { status: 500 });
  }
});
