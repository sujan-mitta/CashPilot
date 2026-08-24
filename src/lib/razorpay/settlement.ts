import { logger } from "@/lib/observability";
import { prisma } from "@/lib/prisma";
import { validateActionTransition, validateRecoveryTransition } from "../engine/stateTransitions";
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
  client: any,
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
 * Settles a payment recovery or overdue collections link by executing the ledger balance updates.
 * Returns the final resolved status of the link ("paid" or "created").
 */
export async function settlePayment(
  paymentLinkId: string,
  businessId: string,
  actualAmount?: number,
  referenceId?: string
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
              status: { in: [ExecutionIntentStatus.DISPATCHING, ExecutionIntentStatus.UNKNOWN, ExecutionIntentStatus.RECORDED] as any },
            },
            data: {
              status: ExecutionIntentStatus.SUCCEEDED,
              externalRef: paymentLinkId,
              resolvedAt: new Date(),
              unknownReason: null,
            },
          });
        }

        const finalSettleAmount = actualAmount !== undefined ? actualAmount : freshRecovery.amount;

        // Increment cash of the exact same business derived from the database model
        await tx.business.update({
          where: { id: targetBusinessId },
          data: {
            currentCash: { increment: finalSettleAmount },
          },
        });

        if (action) {
          const freshAction = await tx.agentAction.findUnique({
            where: { id: action.id },
          });
          if (freshAction && freshAction.status !== ActionStatus.COMPLETED) {
            // First transition PENDING/APPROVED/EXECUTING -> RECONCILING
            if (validateActionTransition(freshAction.status, ActionStatus.RECONCILING)) {
              await tx.agentAction.updateMany({
                where: { id: freshAction.id },
                data: { status: ActionStatus.RECONCILING },
              });
            }

            let targetStatus: ActionStatus = ActionStatus.COMPLETED;
            let resultDetail = `Successfully recovered via Razorpay Link ${paymentLinkId}`;

            if (actualAmount !== undefined && actualAmount !== freshRecovery.amount) {
              targetStatus = ActionStatus.RECONCILIATION_MISMATCH;
              resultDetail = `Discrepancy: Expected ₹${(freshRecovery.amount / 10000000).toFixed(2)}L, but received ₹${(actualAmount / 10000000).toFixed(2)}L`;
            }

            if (!validateActionTransition(ActionStatus.RECONCILING, targetStatus)) {
              throw new Error(`Invalid action transition from RECONCILING to ${targetStatus}`);
            }

            // Record prediction vs actual
            const existingPrediction = freshAction.predictionActual as Record<string, unknown> | null | undefined;
            const updatedPrediction = {
              prediction: existingPrediction?.prediction || null,
              actual: {
                balance: (await (tx.business.findUnique || tx.business.findFirst)({ where: { id: targetBusinessId } }))?.currentCash || null,
                status: targetStatus,
              },
              error: targetStatus === ActionStatus.RECONCILIATION_MISMATCH ? "Amount mismatch" : null,
            };

            const auditEntry = {
              who: "SYSTEM_WEBHOOK",
              what: `Transition RECONCILING -> ${targetStatus}`,
              when: new Date().toISOString(),
              why: `Reconciliation check: ${resultDetail}`,
              result: targetStatus === ActionStatus.RECONCILIATION_MISMATCH ? "MISMATCH" : "SUCCESS",
            };

            const existingAudit = Array.isArray(freshAction.auditLog) ? freshAction.auditLog : [];

            const actionUpdate = await tx.agentAction.updateMany({
              where: {
                id: freshAction.id,
                status: ActionStatus.RECONCILING,
              },
              data: {
                status: targetStatus,
                result: resultDetail,
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
      });
    }
    if (action) {
      await reconcileDecisionForStrategy(prisma, action.strategyId);
    }
    return "paid";
  }

  if (action && action.actionType === "PRIORITIZE_COLLECTIONS" && action.result) {
    try {
      const parsed = JSON.parse(action.result);
      const matchingLink = parsed.links?.find((l: InvoiceLink) => l.paymentLinkId === paymentLinkId);

      if (matchingLink) {
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

            const invoiceUpdate = await tx.invoice.updateMany({
              where: {
                id: freshInvoice.id,
                status: freshInvoice.status,
              },
              data: { status: "PAID" },
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
                  status: { in: [ExecutionIntentStatus.DISPATCHING, ExecutionIntentStatus.UNKNOWN, ExecutionIntentStatus.RECORDED] as any },
                },
                data: {
                  status: ExecutionIntentStatus.SUCCEEDED,
                  externalRef: paymentLinkId,
                  resolvedAt: new Date(),
                  unknownReason: null,
                },
              });
            }

            const finalSettleAmount = actualAmount !== undefined ? actualAmount : freshInvoice.amount;

            // Increment cash of the exact same business derived from the database model
            await tx.business.update({
              where: { id: freshInvoice.businessId },
              data: {
                currentCash: { increment: finalSettleAmount },
              },
            });

            let allPaid = true;
            for (const l of parsed.links) {
              const inv = await tx.invoice.findFirst({
                where: { id: l.invoiceId, businessId },
              });
              if (inv && inv.status !== "PAID") {
                allPaid = false;
              }
            }

            if (allPaid) {
              const freshAction = await tx.agentAction.findUnique({
                where: { id: action.id },
              });
              if (freshAction && freshAction.status !== ActionStatus.COMPLETED) {
                // First transition EXECUTING -> RECONCILING
                  await tx.agentAction.updateMany({
                    where: { id: freshAction.id },
                    data: { status: ActionStatus.RECONCILING },
                  });

                let targetStatus: ActionStatus = ActionStatus.COMPLETED;
                let resultDetail = `Successfully prioritized collections via Razorpay Link ${paymentLinkId}`;

                if (actualAmount !== undefined && actualAmount !== freshInvoice.amount) {
                  targetStatus = ActionStatus.RECONCILIATION_MISMATCH;
                  resultDetail = `Discrepancy: Expected ₹${(freshInvoice.amount / 10000000).toFixed(2)}L, but received ₹${(actualAmount / 10000000).toFixed(2)}L`;
                }

                if (!validateActionTransition(ActionStatus.RECONCILING, targetStatus)) {
                  throw new Error(`Invalid action transition from RECONCILING to ${targetStatus}`);
                }

                // Record prediction vs actual
                const existingPrediction = freshAction.predictionActual as Record<string, unknown> | null | undefined;
                const updatedPrediction = {
                  prediction: existingPrediction?.prediction || null,
                  actual: {
                    balance: (await (tx.business.findUnique || tx.business.findFirst)({ where: { id: businessId } }))?.currentCash || null,
                    status: targetStatus,
                  },
                  error: targetStatus === ActionStatus.RECONCILIATION_MISMATCH ? "Amount mismatch" : null,
                };

                const auditEntry = {
                  who: "SYSTEM_WEBHOOK",
                  what: `Transition RECONCILING -> ${targetStatus}`,
                  when: new Date().toISOString(),
                  why: `Reconciliation check: ${resultDetail}`,
                  result: targetStatus === ActionStatus.RECONCILIATION_MISMATCH ? "MISMATCH" : "SUCCESS",
                };

                const existingAudit = Array.isArray(freshAction.auditLog) ? freshAction.auditLog : [];

                const actionUpdate = await tx.agentAction.updateMany({
                  where: {
                    id: freshAction.id,
                    status: ActionStatus.RECONCILING,
                  },
                  data: {
                    status: targetStatus,
                    // Preserve the links JSON and append the outcome alongside it.
                    //
                    // This field is the ONLY record of which payment link maps to
                    // which invoice, and the collections branch re-parses it on
                    // every settlement. Replacing it with a prose string made a
                    // second settlement attempt unparseable and therefore
                    // undetectable - verified live in Phase 20, where a duplicate
                    // settlement was correctly prevented but could not be recorded.
                    result: JSON.stringify({ ...parsed, settlement: resultDetail }),
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
          });
        }
        await reconcileDecisionForStrategy(prisma, action.strategyId);
        return "paid";
      }
    } catch (e) {
      console.error("Error parsing invoice links in settle:", e);
    }
  }

  return "created";
}
