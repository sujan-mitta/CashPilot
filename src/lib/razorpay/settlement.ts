import { logger } from "@/lib/observability";
import { recordFinancialEvent } from "@/lib/events/financialEvent";
import { prisma } from "@/lib/prisma";

const PAISE_PER_LAKH = 10_000_000;

function formatPaise(paise: number): string {
  if (Math.abs(paise) >= PAISE_PER_LAKH) return `₹${(paise / PAISE_PER_LAKH).toFixed(2)}L`;
  return `₹${(paise / 100).toFixed(2)}`;
}

import {
  validateSettlementAmount,
  describeRejection,
  type SettledAmountRejection,
} from "./amounts";
import { validateActionTransition, validateRecoveryTransition } from "../engine/stateTransitions";
import { statusAfterPayment } from "@/lib/engine/invoiceOutstanding";
import {
  transitionDecision,
  InvalidDecisionTransitionError,
} from "../engine/decisionStateMachine";
import {
  ActionStatus,
  RecoveryStatus,
  DecisionStatus,
  DecisionEventType,
  AgentAction,
  ExecutionIntentStatus,
  Prisma,
} from "../../../generated/prisma/client";

/**
 * Derives a decision's reconciliation status from the authoritative per-action
 * states and writes it through the guarded Decision state machine.
 *
 * This was previously copy-pasted at three call sites with a raw
 * `decision.update`, which meant any poll or webhook could drive a decision to
 * an arbitrary status - including backwards out of a terminal state. Routing
 * every reconciliation write through here makes the transition rules
 * unavoidable, and makes a late or duplicate webhook a safe no-op.
 */
/**
 * Records that a settlement was attempted for something already settled.
 *
 * F1 (Phase 16-20): the compare-and-set below correctly prevents a second
 * credit - verified live with three repeated settlement calls producing exactly
 * one ledger movement. But it returned SILENTLY, so a duplicate settlement
 * attempt left no trace at all. Prevention without a record means nobody can
 * tell the difference between "this never happened" and "we caught it".
 *
 * This records the observation. It deliberately does NOT mutate money, does not
 * change any status, and swallows its own errors - surfacing a discrepancy must
 * never be able to break the settlement path it is observing.
 */
export async function recordSettlementDiscrepancy(
  client: Prisma.TransactionClient,
  details: {
    kind: "INVOICE_ALREADY_PAID" | "RECOVERY_ALREADY_RECOVERED";
    paymentLinkId: string;
    businessId: string;
    targetId: string;
    strategyId?: string | null;
  }
): Promise<void> {
  logger.warn("Settlement discrepancy: target was already settled", {
    kind: details.kind,
    paymentLinkId: details.paymentLinkId,
    businessId: details.businessId,
    targetId: details.targetId,
    duplicateSettlementPrevented: true,
  });

  try {
    if (!details.strategyId || !client?.decision?.findFirst || !client?.decisionEvent?.create) return;

    const decision = await client.decision.findFirst({
      where: { strategyId: details.strategyId, businessId: details.businessId },
    });
    if (!decision) return;

    await client.decisionEvent.create({
      data: {
        decisionId: decision.id,
        businessId: details.businessId,
        eventType: DecisionEventType.RECONCILIATION_MISMATCH,
        fromStatus: decision.status,
        toStatus: decision.status, // an observation, not a transition
        actorType: "SYSTEM",
        actorId: "settlement",
        metadata: {
          discrepancy: details.kind,
          paymentLinkId: details.paymentLinkId,
          targetId: details.targetId,
          note: "A settlement was attempted for a target that was already settled. The duplicate credit was prevented by the compare-and-set guard; this event records that it happened.",
        },
      },
    });
  } catch (err) {
    // Never let observability break settlement.
    logger.error("Failed to record settlement discrepancy", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function reconcileDecisionForStrategy(
  client: Prisma.TransactionClient,
  strategyId: string
): Promise<void> {
  if (!client?.decision || !client?.agentAction?.findMany) return;

  const freshActions = await client.agentAction.findMany({ where: { strategyId } });
  if (!freshActions || freshActions.length === 0) return;

  const allCompleted = freshActions.every((a: AgentAction) => a.status === ActionStatus.COMPLETED);
  const hasMismatch = freshActions.some(
    (a: AgentAction) =>
      a.status === ActionStatus.RECONCILIATION_MISMATCH ||
      a.status === ActionStatus.RECONCILIATION_FAILED ||
      a.status === ActionStatus.FAILED
  );
  // Still in flight: nothing has settled yet, so there is nothing to reconcile.
  // Claiming NOT_RECONCILED here would be a verdict we have not earned.
  const stillInFlight = freshActions.some(
    (a: AgentAction) =>
      a.status === ActionStatus.EXECUTING ||
      a.status === ActionStatus.EXECUTION_REQUESTED ||
      a.status === ActionStatus.EXECUTION_UNKNOWN ||
      a.status === ActionStatus.RECONCILING ||
      a.status === ActionStatus.PENDING ||
      a.status === ActionStatus.APPROVED
  );

  if (stillInFlight && !allCompleted && !hasMismatch) return;

  const newStatus: DecisionStatus = allCompleted
    ? DecisionStatus.RECONCILED
    : hasMismatch
    ? DecisionStatus.RECONCILIATION_MISMATCH
    : DecisionStatus.NOT_RECONCILED;

  try {
    await transitionDecision(client, { strategyId }, newStatus, {
      reconciliationSnapshot: {
        actions: freshActions.map((a: AgentAction) => ({
          id: a.id,
          status: a.status,
          result: a.result,
        })),
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    // A terminal decision (OUTCOME_MEASURED) rejecting a late webhook is the
    // system working as designed, not an error worth failing the request over.
    if (!(err instanceof InvalidDecisionTransitionError)) throw err;

    // ...but it must not vanish. Observed live in Phase 20: a strategy where one
    // action FAILED drove the decision to NOT_EXECUTED, and a sibling action
    // then settled for real. The ledger was correct, yet the decision-level
    // record still read NOT_EXECUTED with no trace of the settlement, because
    // NOT_EXECUTED -> RECONCILIATION_MISMATCH is a forbidden transition.
    //
    // The state machine is right to refuse. The fix is to record what happened
    // rather than to weaken it, so the divergence is visible to an operator.
    logger.warn("Reconciliation transition refused by the decision state machine", {
      strategyId,
      attemptedStatus: newStatus,
      reason: (err as Error).message,
      settlementRecordedButDecisionNotAdvanced: true,
    });

    try {
      const decision = await client.decision.findFirst({ where: { strategyId } });
      if (decision && client.decisionEvent?.create) {
        await client.decisionEvent.create({
          data: {
            decisionId: decision.id,
            businessId: decision.businessId,
            eventType: DecisionEventType.RECONCILIATION_MISMATCH,
            fromStatus: decision.status,
            toStatus: decision.status, // observation, not a transition
            actorType: "SYSTEM",
            actorId: "settlement",
            metadata: {
              discrepancy: "RECONCILIATION_TRANSITION_REFUSED",
              attemptedStatus: newStatus,
              reason: (err as Error).message,
              note: "Settlement completed against the ledger, but the decision could not legally advance from its current status. The ledger is authoritative; this event records the divergence.",
            },
          },
        });
      }
    } catch (recordErr) {
      logger.error("Failed to record refused reconciliation transition", {
        strategyId,
        error: recordErr instanceof Error ? recordErr.message : String(recordErr),
      });
    }
  }
}

interface InvoiceLink {
  invoiceId: string;
  paymentLinkId: string;
}

/**
 * Decides what figure may actually be added to a balance.
 *
 * `actualAmount` is what an EXTERNAL party asserted was paid. It used to be
 * applied to `currentCash: { increment }` with no validation at all, so a
 * negative, fractional, NaN or absurd value from a payload would have moved a
 * real balance by exactly that much.
 *
 * The rules, in order:
 *   - No provider figure at all -> settle the expected amount. This is the
 *     poll/manual path, where we only know what was owed.
 *   - A provider figure we cannot trust -> throw. Refusing to settle is the
 *     only safe answer; the caller's transaction rolls back and the delivery is
 *     recorded as failed so the provider retries.
 *   - A trustworthy figure -> use it, even when it differs from the expectation.
 *     The DIFFERENCE is what marks the action RECONCILIATION_MISMATCH; the
 *     ledger still records what genuinely arrived.
 */
export class UnsafeSettlementAmountError extends Error {
  readonly code = "UNSAFE_SETTLEMENT_AMOUNT";
  constructor(readonly reason: SettledAmountRejection) {
    super(describeRejection(reason));
    this.name = "UnsafeSettlementAmountError";
  }
}

export function resolveSettlementAmount(
  actualAmount: number | undefined,
  expectedAmount: number,
  context: { paymentLinkId: string; businessId: string; targetKind: string; targetId: string }
): number {
  if (actualAmount === undefined) return expectedAmount;

  const validated = validateSettlementAmount(actualAmount);
  if (!validated.ok) {
    logger.error("Refusing to settle an unusable provider amount", {
      ...context,
      rejection: validated.reason,
      expectedAmount,
    });
    throw new UnsafeSettlementAmountError(validated.reason);
  }

  if (validated.amount !== expectedAmount) {
    // Not an error - a partial or over-payment is a real thing that happens.
    // It is recorded here and drives RECONCILIATION_MISMATCH downstream.
    logger.warn("Settled amount differs from the expected amount", {
      ...context,
      expectedAmount,
      settledAmount: validated.amount,
    });
  }
  return validated.amount;
}

/**
 * What actually caused a settlement to run.
 *
 * H2: every settlement audit entry used to be stamped `SYSTEM_WEBHOOK`, whether
 * it came from a Razorpay delivery, a status poll, reconciliation, or somebody
 * calling settlePayment() from a script. An audit trail that cannot tell those
 * apart cannot answer the one question a provider certification asks - "did the
 * provider trigger this?" - and it answered it wrongly, in the reassuring
 * direction.
 *
 * The trigger is therefore a required-by-default parameter that flows from the
 * caller. It is NOT re-derived inside settlement, because settlement genuinely
 * cannot know: every caller reaches the same function by the same path.
 */
export type SettlementTrigger =
  /** A signed delivery from the payment provider. */
  | "WEBHOOK"
  /** A client or server polling the provider for current link status. */
  | "POLL"
  /** The reconciler resolving a previously undetermined intent. */
  | "RECONCILIATION"
  /** A direct call - scripts, operators, tests. Never provider-attested. */
  | "MANUAL";

/**
 * Audit actor for a settlement trigger.
 *
 * WEBHOOK keeps the historic `SYSTEM_WEBHOOK` string so existing records stay
 * comparable and nothing already written has to be rewritten - but it is now
 * only ever emitted when a webhook really was the trigger. Every other trigger
 * gets its own actor, and the default is MANUAL, so a bare settlePayment() call
 * can no longer produce SYSTEM_WEBHOOK by omission.
 */
export function settlementActor(trigger: SettlementTrigger): string {
  switch (trigger) {
    case "WEBHOOK":
      return "SYSTEM_WEBHOOK";
    case "POLL":
      return "SYSTEM_POLL";
    case "RECONCILIATION":
      return "SYSTEM_RECONCILIATION";
    case "MANUAL":
      return "MANUAL_SETTLEMENT";
  }
}

async function applySettlementUpdates(
  tx: Prisma.TransactionClient,
  params: {
    actionId: string;
    paymentLinkId: string;
    businessId: string;
    expectedAmount: number;
    actualAmount?: number;
    successMessage: string;
    trigger: SettlementTrigger;
    formatResult?: (resultDetail: string) => string;
  }
) {
  const freshAction = await tx.agentAction.findUnique({
    where: { id: params.actionId },
  });
  if (freshAction && freshAction.status !== ActionStatus.COMPLETED) {
    const canReconcile = validateActionTransition(freshAction.status, ActionStatus.RECONCILING);
    if (canReconcile) {
      await tx.agentAction.updateMany({
        where: { id: freshAction.id },
        data: { status: ActionStatus.RECONCILING },
      });
    }

    if (!canReconcile) {
      logger.warn("Settled money against an action that cannot advance", {
        paymentLinkId: params.paymentLinkId,
        actionId: freshAction.id,
        actionStatus: freshAction.status,
        settlementRecordedButActionNotAdvanced: true,
      });
      return;
    }

    let targetStatus: ActionStatus = ActionStatus.COMPLETED;
    let resultDetail = params.successMessage;

    if (params.actualAmount !== undefined && params.actualAmount !== params.expectedAmount) {
      targetStatus = ActionStatus.RECONCILIATION_MISMATCH;
      resultDetail = `Discrepancy: Expected ${formatPaise(params.expectedAmount)}, but received ${formatPaise(params.actualAmount)}`;
    }

    if (!validateActionTransition(ActionStatus.RECONCILING, targetStatus)) {
      throw new Error(`Invalid action transition from RECONCILING to ${targetStatus}`);
    }

    const existingPrediction = freshAction.predictionActual as Record<string, unknown> | null | undefined;
    const updatedPrediction = {
      prediction: existingPrediction?.prediction || null,
      actual: {
        balance: (await tx.business.findUnique({ where: { id: params.businessId } }))?.currentCash || null,
        status: targetStatus,
      },
      error: targetStatus === ActionStatus.RECONCILIATION_MISMATCH ? "Amount mismatch" : null,
    };

    const auditEntry = {
      who: settlementActor(params.trigger),
      trigger: params.trigger,
      what: `Transition RECONCILING -> ${targetStatus}`,
      when: new Date().toISOString(),
      why: `Reconciliation check: ${resultDetail}`,
      result: targetStatus === ActionStatus.RECONCILIATION_MISMATCH ? "MISMATCH" : "SUCCESS",
    };

    const existingAudit = Array.isArray(freshAction.auditLog) ? freshAction.auditLog : [];
    const finalResult = params.formatResult ? params.formatResult(resultDetail) : resultDetail;

    const actionUpdate = await tx.agentAction.updateMany({
      where: {
        id: freshAction.id,
        status: ActionStatus.RECONCILING,
      },
      data: {
        status: targetStatus,
        result: finalResult,
        predictionActual: updatedPrediction as Prisma.InputJsonValue,
        auditLog: [...existingAudit, auditEntry] as Prisma.InputJsonValue,
      },
    });
    if (actionUpdate && actionUpdate.count === 0) {
      const refetchedAct = await tx.agentAction.findUnique({
        where: { id: freshAction.id },
      });
      if (refetchedAct && refetchedAct.status === targetStatus) {
        return;
      }
      throw new Error("Action concurrently modified");
    }
  }
}

/**
 * Settles a payment recovery or overdue collections link by executing the ledger balance updates.
 * Returns the final resolved status of the link ("paid" or "created").
 */
/**
 * Append the canonical financial event for a settled obligation.
 *
 * Written on the SAME transaction client as the ledger movement it describes,
 * following the rule the decision log already follows: if the event insert
 * fails, the settlement rolls back with it, and the append-only spine can never
 * disagree with the balance. An audit log that is allowed to miss entries when
 * things go wrong is an audit log for the cases nobody needed it for.
 *
 * Identity is `paymentLinkId:targetKind:targetId`, not the link alone. One link
 * can settle several invoices, so the link by itself is not unique per
 * financial fact; including the target makes the key exactly as granular as the
 * money movement. Re-settling the same obligation therefore reproduces the same
 * key and is absorbed idempotently rather than appended twice.
 *
 * `normalizedData` carries no signature, header or credential — only ids and
 * amounts already present in our own tables.
 */
async function emitSettlementEvent(
  tx: Parameters<typeof recordFinancialEvent>[0],
  params: {
    eventType: "PAYMENT_RECEIVED" | "INVOICE_PAID";
    businessId: string;
    paymentLinkId: string;
    targetKind: "INVOICE" | "PAYMENT_RECOVERY";
    targetId: string;
    expectedAmount: number;
    settledAmount: number;
    occurredAt: Date;
    trigger: SettlementTrigger;
  }
): Promise<void> {
  await recordFinancialEvent(tx, params.businessId, {
    eventType: params.eventType,
    sourceType: "RAZORPAY",
    sourceRecordId: `${params.paymentLinkId}:${params.targetKind}:${params.targetId}`,
    occurredAt: params.occurredAt,
    amount: params.settledAmount,
    status: "SETTLED",
    rawReference: params.targetId,
    normalizedData: {
      paymentLinkId: params.paymentLinkId,
      targetKind: params.targetKind,
      targetId: params.targetId,
      expectedAmount: params.expectedAmount,
      settledAmount: params.settledAmount,
      // How the settlement reached us, and therefore how far the timestamp can
      // be trusted. WEBHOOK is provider-driven; MANUAL is an operator
      // observation that may be days after the money actually moved (C-13).
      settlementTrigger: params.trigger,
      timestampMeaning: params.trigger === "MANUAL" ? "OBSERVED" : "PROVIDER_REPORTED",
    },
  });
}

export async function settlePayment(
  paymentLinkId: string,
  businessId: string,
  actualAmount?: number,
  referenceId?: string,
  /**
   * Defaults to MANUAL on purpose. An omitted trigger must never be able to
   * masquerade as provider-attested settlement.
   */
  trigger: SettlementTrigger = "MANUAL",
  /**
   * When the money actually arrived, if a trustworthy timestamp is known.
   *
   * Phase 9 needs this: until now an invoice flipped to PAID and the DATE was
   * simply discarded, which made "how late does this customer usually pay?"
   * unanswerable from stored data.
   *
   * Defaults to observation time. That is deliberate rather than lazy. A
   * provider-attested `paid_at` would be strictly better, but this system has
   * never received a real Razorpay webhook (Phase 18 blocker B2), so the field
   * name and units cannot be verified against reality - and §37 is explicit
   * that provider payload structure must not be assumed. Observation time has a
   * known, bounded meaning, and the behaviour model buckets by DAY, so webhook
   * delivery lag of seconds or minutes does not move a single metric. Pass a
   * verified provider timestamp here as soon as one exists.
   */
  paidAt: Date = new Date()
): Promise<string> {
  // Resolve intent first if possible
  let intent = null;
  if (referenceId) {
    intent = await prisma.executionIntent.findUnique({
      where: { idempotencyKey: referenceId },
      include: { action: { include: { strategy: true } } },
    });
  }
  if (!intent) {
    intent = await prisma.executionIntent.findFirst({
      where: { externalRef: paymentLinkId },
      include: { action: { include: { strategy: true } } },
    });
  }

  // 1. Resolve action
  let action = intent?.action || null;
  if (!action) {
    action = await prisma.agentAction.findFirst({
      where: {
        result: {
          contains: paymentLinkId,
        },
        strategy: {
          businessId,
        },
      },
      include: {
        strategy: true,
      },
    });
  }

  // Query recovery candidates ensuring they belong strictly to the authorized business context
  let recovery = null;
  if (intent && intent.targetType === "PAYMENT_RECOVERY" && intent.targetId) {
    recovery = await prisma.paymentRecovery.findUnique({
      where: { id: intent.targetId },
      include: { transaction: true },
    });
  }
  if (!recovery) {
    recovery = await prisma.paymentRecovery.findFirst({
      where: {
        paymentLinkId,
        transaction: {
          businessId,
        },
      },
      include: {
        transaction: true,
      },
    });
  }

  if (!recovery && !action) {
    return "created";
  }

  // Settle payment
  if (recovery) {
    if (recovery.status === RecoveryStatus.RECOVERED) {
      await recordSettlementDiscrepancy(prisma, {
        kind: "RECOVERY_ALREADY_RECOVERED",
        paymentLinkId,
        businessId,
        targetId: recovery.id,
        strategyId: action?.strategyId ?? null,
      });
    }

    if (recovery.status !== RecoveryStatus.RECOVERED) {
      await prisma.$transaction(async (tx) => {
        // Use findUnique to match existing unit test mocks
        const freshRecovery = await tx.paymentRecovery.findUnique({
          where: { id: recovery.id },
          include: { transaction: true },
        });
        if (!freshRecovery) {
          return;
        }

        // Hard tenant boundary validation
        const recoveryBusinessId = freshRecovery.transaction?.businessId;
        if (recoveryBusinessId && recoveryBusinessId !== businessId) {
          throw new Error("Access Denied: recovery record belongs to a different tenant");
        }

        if (freshRecovery.status === RecoveryStatus.RECOVERED) {
          await recordSettlementDiscrepancy(prisma, {
            kind: "RECOVERY_ALREADY_RECOVERED",
            paymentLinkId,
            businessId,
            targetId: freshRecovery.id,
            strategyId: action?.strategyId ?? null,
          });
          return;
        }

        // derive target business directly from the recovery model
        const targetBusinessId = recoveryBusinessId || businessId;

        if (!validateRecoveryTransition(freshRecovery.status, RecoveryStatus.RECOVERED)) {
          throw new Error(`Invalid recovery transition from ${freshRecovery.status} to RECOVERED`);
        }

        const updateCount = await tx.paymentRecovery.updateMany({
          where: {
            id: freshRecovery.id,
            status: freshRecovery.status,
          },
          data: { status: RecoveryStatus.RECOVERED },
        });

        if (updateCount && updateCount.count === 0) {
          const refetched = await tx.paymentRecovery.findUnique({
            where: { id: freshRecovery.id },
            include: { transaction: true },
          });
          if (refetched && refetched.status === RecoveryStatus.RECOVERED) {
            await recordSettlementDiscrepancy(prisma, {
              kind: "RECOVERY_ALREADY_RECOVERED",
              paymentLinkId,
              businessId,
              targetId: refetched.id,
              strategyId: action?.strategyId ?? null,
            });
            return;
          }
          throw new Error("Invalid recovery state transition concurrency check failure");
        }

        // Update corresponding ExecutionIntent to SUCCEEDED and set externalRef
        if (intent) {
          await tx.executionIntent.updateMany({
            where: {
              id: intent.id,
              status: { in: [ExecutionIntentStatus.DISPATCHING, ExecutionIntentStatus.UNKNOWN, ExecutionIntentStatus.RECORDED] },
            },
            data: {
              status: ExecutionIntentStatus.SUCCEEDED,
              externalRef: paymentLinkId,
              resolvedAt: new Date(),
              unknownReason: null,
            },
          });
        }

        const finalSettleAmount = resolveSettlementAmount(
          actualAmount,
          freshRecovery.amount,
          { paymentLinkId, businessId, targetKind: "PAYMENT_RECOVERY", targetId: freshRecovery.id }
        );

        // Increment cash of the exact same business derived from the database model
        await tx.business.update({
          where: { id: targetBusinessId },
          data: {
            currentCash: { increment: finalSettleAmount },
          },
        });

        await emitSettlementEvent(tx, {
          eventType: "PAYMENT_RECEIVED",
          businessId: targetBusinessId,
          paymentLinkId,
          targetKind: "PAYMENT_RECOVERY",
          targetId: freshRecovery.id,
          expectedAmount: freshRecovery.amount,
          settledAmount: finalSettleAmount,
          occurredAt: paidAt,
          trigger,
        });

        if (action) {
          await applySettlementUpdates(tx, {
            actionId: action.id,
            paymentLinkId,
            businessId: targetBusinessId,
            expectedAmount: freshRecovery.amount,
            actualAmount,
            successMessage: `Successfully recovered via Razorpay Link ${paymentLinkId}`,
            trigger,
          });
        }
      });
    }
    if (action) {
      await reconcileDecisionForStrategy(prisma, action.strategyId);
    }
    return "paid";
  }

  if (action && action.actionType === "PRIORITIZE_COLLECTIONS" && action.result) {
    // Parsing is the ONLY thing allowed to fail silently here.
    //
    // This try used to wrap the entire settlement below, including the write
    // transaction, and its catch fell through to `return "created"`. So a
    // database error, a lost concurrency race, or any throw inside the
    // transaction was reported to the caller as a successful no-op: the webhook
    // route then answered HTTP 200, Razorpay never retried, and a real payment
    // was credited to nobody with nothing flagged anywhere.
    //
    // An unparseable `result` genuinely is "this action does not describe the
    // link we were asked about", which is what "created" means. Everything
    // after it must be allowed to throw.
    let parsed: { links?: InvoiceLink[] } | null = null;
    try {
      parsed = JSON.parse(action.result);
    } catch (parseError) {
      logger.warn("Collections action result is not parseable link JSON", {
        paymentLinkId,
        actionId: action.id,
        error: parseError instanceof Error ? parseError.message : String(parseError),
      });
      return "created";
    }

    const matchingLink = parsed?.links?.find((l: InvoiceLink) => l.paymentLinkId === paymentLinkId);

    if (matchingLink && parsed) {
      {
        // Hoisted so the closures below do not depend on TypeScript narrowing
        // surviving into an async callback.
        const parsedResult = parsed;
        const links: InvoiceLink[] = Array.isArray(parsed.links) ? parsed.links : [];
        const invoice = await prisma.invoice.findFirst({
          where: { id: matchingLink.invoiceId, businessId },
        });

        if (invoice && invoice.status === "PAID") {
          // The common duplicate path: a repeat settlement arrives after the
          // invoice is already PAID, so the transaction below is never entered.
          // Verified live in Phase 20 - this branch was silent.
          await recordSettlementDiscrepancy(prisma, {
            kind: "INVOICE_ALREADY_PAID",
            paymentLinkId,
            businessId,
            targetId: invoice.id,
            strategyId: action?.strategyId ?? null,
          });
        }

        if (invoice && invoice.status !== "PAID") {
          await prisma.$transaction(async (tx) => {
            const freshInvoice = await tx.invoice.findFirst({
              where: { id: invoice.id, businessId },
            });
            if (!freshInvoice || freshInvoice.status === "PAID") {
              if (freshInvoice) {
                await recordSettlementDiscrepancy(prisma, {
                  kind: "INVOICE_ALREADY_PAID",
                  paymentLinkId,
                  businessId,
                  targetId: freshInvoice.id,
                  strategyId: action?.strategyId ?? null,
                });
              }
              return;
            }

            if (freshInvoice.businessId !== businessId) {
              throw new Error("Access Denied: invoice belongs to a different tenant");
            }

            // Compare-and-swap on status. The guard is what makes `paidAt`
            // write-once: only the settler that actually moves the invoice out
            // of its previous status writes a date, so a concurrent or repeat
            // settlement can never overwrite the original arrival time with a
            // later one.
            // The status is DERIVED from the money, not asserted. A settlement
            // that does not close the balance leaves the invoice
            // PARTIALLY_PAID; only one that reaches the full amount marks it
            // PAID. Previously any settlement flipped it to PAID regardless of
            // amount, so a ₹6L receipt against a ₹10L invoice removed the
            // remaining ₹4L from the forecast entirely.
            //
            // `paidAmount` is incremented rather than assigned, so successive
            // part payments accumulate instead of overwriting each other. It
            // moves inside the same compare-and-swap that gates `paidAt`, so it
            // cannot drift from the credit applied to the ledger.
            // Resolved BEFORE the status write: the status is a consequence of
            // the amount, so it cannot be decided before the amount is known.
            const finalSettleAmount = resolveSettlementAmount(
              actualAmount,
              freshInvoice.amount,
              { paymentLinkId, businessId, targetKind: "INVOICE", targetId: freshInvoice.id }
            );

            const nextStatus = statusAfterPayment(freshInvoice, finalSettleAmount);

            const invoiceUpdate = await tx.invoice.updateMany({
              where: {
                id: freshInvoice.id,
                status: freshInvoice.status,
              },
              data: {
                status: nextStatus,
                paidAmount: { increment: finalSettleAmount },
                // Write-once: only the settler that closes the invoice records
                // when it was closed. A part payment has not closed anything.
                ...(nextStatus === "PAID" ? { paidAt } : {}),
              },
            });

            if (invoiceUpdate && invoiceUpdate.count === 0) {
              const refetched = await tx.invoice.findFirst({
                where: { id: freshInvoice.id, businessId },
              });
              if (refetched && refetched.status === "PAID") {
                // Lost a concurrency race against another settler.
                await recordSettlementDiscrepancy(prisma, {
                  kind: "INVOICE_ALREADY_PAID",
                  paymentLinkId,
                  businessId,
                  targetId: refetched.id,
                  strategyId: action?.strategyId ?? null,
                });
                return;
              }
              throw new Error("Invalid invoice state transition concurrency check failure");
            }

            // Update corresponding ExecutionIntent to SUCCEEDED and set externalRef
            if (intent) {
              await tx.executionIntent.updateMany({
                where: {
                  id: intent.id,
                  status: { in: [ExecutionIntentStatus.DISPATCHING, ExecutionIntentStatus.UNKNOWN, ExecutionIntentStatus.RECORDED] },
                },
                data: {
                  status: ExecutionIntentStatus.SUCCEEDED,
                  externalRef: paymentLinkId,
                  resolvedAt: new Date(),
                  unknownReason: null,
                },
              });
            }

            // Increment cash of the exact same business derived from the database model
            await tx.business.update({
              where: { id: freshInvoice.businessId },
              data: {
                currentCash: { increment: finalSettleAmount },
              },
            });

            await emitSettlementEvent(tx, {
              eventType: "INVOICE_PAID",
              businessId: freshInvoice.businessId,
              paymentLinkId,
              targetKind: "INVOICE",
              targetId: freshInvoice.id,
              expectedAmount: freshInvoice.amount,
              settledAmount: finalSettleAmount,
              occurredAt: paidAt,
              trigger,
            });

            let allPaid = true;
            for (const l of links) {
              const inv = await tx.invoice.findFirst({
                where: { id: l.invoiceId, businessId },
              });
              if (inv && inv.status !== "PAID") {
                allPaid = false;
              }
            }

            if (allPaid) {
              await applySettlementUpdates(tx, {
                actionId: action.id,
                paymentLinkId,
                businessId,
                expectedAmount: freshInvoice.amount,
                actualAmount,
                successMessage: `Successfully prioritized collections via Razorpay Link ${paymentLinkId}`,
                trigger,
                formatResult: (resultDetail) => JSON.stringify({ ...parsedResult, settlement: resultDetail }),
              });
            }
          });
        }
        await reconcileDecisionForStrategy(prisma, action.strategyId);
        await convergeSiblingCollectionActions(paymentLinkId, businessId, action.id, trigger);
        return "paid";
      }
    }
  }

  return "created";
}

/**
 * Advances OTHER actions that reference the same payment link once its invoices
 * are paid.
 *
 * A payment link belongs to an OBLIGATION (an invoice), not to an action. One
 * obligation can be referenced by several actions: a regenerated strategy mints
 * a new action which re-attaches to the existing link rather than issuing a
 * second one. Settlement, though, resolves exactly one action - the one its
 * intent points at - so every other action referencing that link stayed
 * EXECUTING forever, and `reconcileDecisionForStrategy` treats EXECUTING as
 * still-in-flight, so those decisions never reconciled either.
 *
 * This is deliberately OUTSIDE the settlement transaction and touches no money.
 * The cash increment is guarded by the invoice compare-and-set and has already
 * happened exactly once by the time this runs; all that is left is to stop
 * actions from claiming to be executing work that is demonstrably finished.
 *
 * It advances an action only when EVERY invoice that action targeted is PAID,
 * and only through the guarded transition, so a partially-settled fan-out and a
 * terminal action are both left alone.
 */
async function convergeSiblingCollectionActions(
  paymentLinkId: string,
  businessId: string,
  settledActionId: string,
  trigger: SettlementTrigger
): Promise<void> {
  try {
    const siblings = await prisma.agentAction.findMany({
      where: {
        id: { not: settledActionId },
        actionType: "PRIORITIZE_COLLECTIONS",
        result: { contains: paymentLinkId },
        status: { in: [ActionStatus.EXECUTING, ActionStatus.EXECUTION_UNKNOWN] },
        strategy: { businessId },
      },
    });

    for (const sibling of siblings) {
      if (!sibling.result) continue;

      let links: InvoiceLink[] | undefined;
      try {
        links = JSON.parse(sibling.result).links;
      } catch {
        continue; // Not a links payload; nothing to converge against.
      }
      if (!Array.isArray(links) || links.length === 0) continue;

      const invoices = await prisma.invoice.findMany({
        where: { id: { in: links.map((l) => l.invoiceId) }, businessId },
      });
      const allPaid =
        invoices.length === links.length && invoices.every((i) => i.status === "PAID");
      if (!allPaid) continue;

      if (!validateActionTransition(sibling.status, ActionStatus.COMPLETED)) continue;

      const auditEntry = {
        who: "SYSTEM_SETTLEMENT",
        trigger,
        what: `Transition ${sibling.status} -> COMPLETED`,
        when: new Date().toISOString(),
        why: `Every invoice this action targeted was settled via payment link ${paymentLinkId}, which was issued under a different action for the same obligation.`,
        result: "SUCCESS",
      };
      const existingAudit = Array.isArray(sibling.auditLog) ? sibling.auditLog : [];

      const updated = await prisma.agentAction.updateMany({
        where: { id: sibling.id, status: sibling.status },
        data: {
          status: ActionStatus.COMPLETED,
          auditLog: [...existingAudit, auditEntry] as Prisma.InputJsonValue,
        },
      });

      if (updated.count > 0) {
        logger.info("Converged a sibling action onto a settled obligation", {
          siblingActionId: sibling.id,
          settledActionId,
          paymentLinkId,
        });
        await reconcileDecisionForStrategy(prisma, sibling.strategyId);
      }
    }
  } catch (err) {
    // Convergence is bookkeeping. It must never break the settlement it follows.
    logger.error("Failed to converge sibling collection actions", {
      paymentLinkId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
