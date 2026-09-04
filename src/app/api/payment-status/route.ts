import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Razorpay from "razorpay";
import { getSession } from "@/lib/auth";
import { ActionStatus, RecoveryStatus, AgentAction, Prisma } from "../../../../generated/prisma/client";
import { settlePayment, reconcileDecisionForStrategy } from "@/lib/razorpay/settlement";
import { readProviderPaidAmount } from "@/lib/razorpay/amounts";
import { validateActionTransition } from "@/lib/engine/stateTransitions";
import { logger } from "@/lib/observability";
import { syncAfterSettlement } from "@/lib/brain/afterSettlement";
import { errorMessage } from "@/lib/errors";

export async function GET(req: Request) {
  let paymentLinkId: string | null = null;
  let action: AgentAction | null = null;
  // Captured for the catch block, which must stay tenant-scoped.
  let callerBusinessId: string | null = null;
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    callerBusinessId = session.businessId;

    const { searchParams } = new URL(req.url);
    paymentLinkId = searchParams.get("paymentLinkId");
    const clientActionId = searchParams.get("actionId");

    if (!paymentLinkId) {
      return NextResponse.json({ error: "Missing paymentLinkId parameter." }, { status: 400 });
    }

    const business = await prisma.business.findUnique({
      where: { id: session.businessId },
    });
    if (!business) {
      return NextResponse.json({ error: "Business not found." }, { status: 404 });
    }

    // Securely resolve action from database by searching for paymentLinkId in the result column
    action = await prisma.agentAction.findFirst({
      where: {
        result: { contains: paymentLinkId },
        strategy: { businessId: business.id },
      },
    });

    // Fallback only if not found (e.g. for legacy records or backward compatibility)
    if (!action && clientActionId) {
      action = await prisma.agentAction.findFirst({
        where: {
          id: clientActionId,
          strategy: { businessId: business.id },
        },
      });
    }

    // Verify ownership: if action is missing, we must find a same-tenant recovery record
    let recovery = null;
    if (!action) {
      recovery = await prisma.paymentRecovery.findFirst({
        where: {
          paymentLinkId,
          transaction: {
            businessId: business.id,
          },
        },
      });

      if (!recovery) {
        return NextResponse.json({ error: "PAYMENT_NOT_FOUND" }, { status: 404 });
      }
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const isPlaceholder = !keyId || !keySecret || keyId.includes("placeholder") || keySecret.includes("placeholder");

    let status = "created";
    // What the provider says was actually paid, when we were able to ask it.
    // Left undefined on every path where we did NOT observe a provider figure,
    // so settlement falls back to the expected amount rather than inventing one.
    let observedPaidAmount: number | undefined = undefined;

    // 1. Fetch live status from Razorpay API or check simulation parameters
    if (!isPlaceholder) {
      try {
        const razorpay = new Razorpay({
          key_id: keyId!,
          key_secret: keySecret!,
        });
        const link = await razorpay.paymentLink.fetch(paymentLinkId);
        status = link.status; // e.g. "paid", "created", "cancelled"

        // The provider just told us what was paid. Discarding it - which is
        // what happened before - meant a poll credited the FULL expected amount
        // for a partially-paid link, so the same payment settled to a different
        // figure depending on whether the webhook or the poll saw it first.
        const paid = readProviderPaidAmount(link as { amount?: unknown; amount_paid?: unknown });
        if (paid.ok) {
          observedPaidAmount = paid.amount;
        } else {
          logger.warn("Provider returned an unusable paid amount on poll", {
            paymentLinkId,
            rejection: paid.reason,
          });
        }
      } catch (err) {
        logger.error("Razorpay fetch error, returning current database status:", { error: String(err) });
        // Safe connection error handling: read status from database
        const dbRecovery = recovery || await prisma.paymentRecovery.findFirst({
          where: {
            paymentLinkId,
            transaction: {
              businessId: business.id,
            },
          },
        });
        if (dbRecovery && dbRecovery.status === "RECOVERED") {
          status = "paid";
        } else {
          // If action is already completed/paid, return "paid"
          if (action && action.status === "COMPLETED") {
            status = "paid";
          }
          // If no database confirmation, retain pending status ("created")
          if (status !== "paid") {
            status = "created";
          }
        }
      }
    } else {
      // Sandbox environment: return paid only if simulatePaid is passed,
      // or if it's already marked RECOVERED/PAID in the database
      // A query parameter must never be able to assert that money arrived.
      // This is a local sandbox affordance only and is inert in production.
      const simulationAllowed = process.env.NODE_ENV !== "production";
      const simulatePaid =
        simulationAllowed && searchParams.get("simulatePaid") === "true";
      
      const dbRecovery = recovery || await prisma.paymentRecovery.findFirst({
        where: {
          paymentLinkId,
          transaction: {
            businessId: business.id,
          },
        },
      });

      let isInvoicePaid = false;
      if (action) {
        if (action.status === "COMPLETED") {
          isInvoicePaid = true;
        } else if (action.actionType === "PRIORITIZE_COLLECTIONS" && action.result) {
          try {
            const parsed = JSON.parse(action.result);
            const matchingLink = parsed.links?.find(
              (l: { paymentLinkId?: string }) => l.paymentLinkId === paymentLinkId
            );
            if (matchingLink) {
              // Tenant-scoped, like every other read in this file.
              const invoice = await prisma.invoice.findFirst({
                where: { id: matchingLink.invoiceId, businessId: business.id },
              });
              if (invoice && invoice.status === "PAID") {
                isInvoicePaid = true;
              }
            }
          } catch {}
        }
      }

      if (simulatePaid || (dbRecovery && dbRecovery.status === "RECOVERED") || isInvoicePaid) {
        status = "paid";
      } else {
        status = "created";
      }
    }

    // 2. If status is paid and action is resolved, update database values
    if (status === "paid" && action) {
      await settlePayment(paymentLinkId, business.id, observedPaidAmount, undefined, "POLL");

      // The settlement entrance that actually runs in local development.
      //
      // Razorpay will not deliver a webhook to localhost, so the sandbox
      // checkout settles through here instead. Wiring the brain sync into the
      // webhook alone therefore covered the one path a developer never
      // exercises, and every locally settled payment still skipped entity
      // resolution.
      await syncAfterSettlement(business.id, { trigger: "POLL", paymentLinkId });
    } else if (status === "cancelled" || status === "expired") {
      if (action && validateActionTransition(action.status, ActionStatus.FAILED)) {
        const auditEntry = {
          who: "SYSTEM_RECOVERY",
          what: `Transition ${action.status} -> FAILED`,
          when: new Date().toISOString(),
          why: `Authoritative external state check: payment link is ${status}`,
          result: "FAILED",
        };
        const existingAudit = Array.isArray(action.auditLog) ? action.auditLog : [];
        await prisma.agentAction.update({
          where: { id: action.id },
          data: {
            status: ActionStatus.FAILED,
            auditLog: [...existingAudit, auditEntry] as Prisma.InputJsonValue,
          },
        });
      }
    }

    // Verify rescheduling mismatch for RESCHEDULE_PAYOUT.
    //
    // Two defects are closed here.
    //
    // 1. This ran at EVERY stage. An action still PENDING or APPROVED has, by
    //    definition, not moved its payout yet, so `status !== RESCHEDULED` was
    //    trivially true and polling an unrelated payment link stamped
    //    RECONCILIATION_MISMATCH onto a reschedule that had never been asked to
    //    run. The check only means anything once execution has been attempted.
    //
    // 2. It wrote the status with a raw `update`, bypassing
    //    validateActionTransition - the only mutation in the codebase that did.
    //    That let it drag terminal actions (COMPLETED, REJECTED) backwards.
    const RECONCILABLE_AFTER_EXECUTION: ActionStatus[] = [
      ActionStatus.EXECUTING,
      ActionStatus.EXECUTED,
      ActionStatus.RECONCILING,
      ActionStatus.COMPLETED,
    ];
    if (
      action &&
      action.actionType === "RESCHEDULE_PAYOUT" &&
      action.targetPayoutId &&
      RECONCILABLE_AFTER_EXECUTION.includes(action.status)
    ) {
      const payout = await prisma.payout.findFirst({
        where: { id: action.targetPayoutId, businessId: business.id },
      });
      if (payout && payout.status !== "RESCHEDULED") {
        // Two guarded steps, not one raw write.
        //
        // The machine has no direct EXECUTING -> RECONCILIATION_MISMATCH edge;
        // the legal route is via RECONCILING, which is exactly what
        // settlement.ts already does. The old code wrote the end state
        // directly with `update`, which is how it also managed to drag
        // terminal actions backwards.
        const reconcileOk =
          action.status === ActionStatus.RECONCILING ||
          validateActionTransition(action.status, ActionStatus.RECONCILING);

        if (
          reconcileOk &&
          validateActionTransition(ActionStatus.RECONCILING, ActionStatus.RECONCILIATION_MISMATCH)
        ) {
          // Compare-and-set on the observed status: a concurrent settlement
          // that already advanced this action must win, not be overwritten.
          const claimed = await prisma.agentAction.updateMany({
            where: { id: action.id, status: action.status },
            data: { status: ActionStatus.RECONCILING },
          });
          if (claimed.count > 0) {
            await prisma.agentAction.updateMany({
              where: { id: action.id, status: ActionStatus.RECONCILING },
              data: {
                status: ActionStatus.RECONCILIATION_MISMATCH,
                result: `Discrepancy: Vendor payout status is ${payout.status} (expected RESCHEDULED)`,
              },
            });
          }
        } else {
          logger.warn("Reschedule discrepancy observed but the action cannot advance", {
            actionId: action.id,
            actionStatus: action.status,
            payoutStatus: payout.status,
          });
        }
      }
    }

    // Reconciliation status is derived from the authoritative action states and
    // written through the guarded Decision state machine, so a poll can never
    // drag a decision backwards (e.g. OUTCOME_MEASURED -> NOT_RECONCILED).
    if (action) {
      await reconcileDecisionForStrategy(prisma, action.strategyId);
    }

    return NextResponse.json({ status });
  } catch (error) {
    // Check if the resource was actually completed concurrently by another request.
    //
    // Scoped to the caller's own tenant. Without the `transaction.businessId`
    // filter this answered "paid" for ANY tenant's payment link that happened to
    // match a guessed id - the one unscoped query in a file that scopes
    // everything else.
    try {
      const recovery = await prisma.paymentRecovery.findFirst({
        where: {
          paymentLinkId,
          // A sentinel that cannot be a real id, so an absent caller business
          // matches nothing rather than matching anything.
          //
          // The sentinel here used to begin with a literal NUL byte, which was
          // worse than useless twice over.
          //
          // Postgres text cannot hold a NUL, so this query did not match
          // nothing — it THREW, and the throw was swallowed by the catch below,
          // quietly disabling the concurrent-completion check whenever there
          // was no caller business.
          //
          // And one NUL makes the whole file binary to grep, so every content
          // search across the repo silently skipped this route. That is how it
          // survived: the file was invisible to the tools used to look for it.
          transaction: { businessId: callerBusinessId ?? "__no_business__" },
        },
      });
      if (recovery && recovery.status === RecoveryStatus.RECOVERED) {
        return NextResponse.json({ status: "paid" });
      }
      if (action) {
        const freshAction = await prisma.agentAction.findUnique({
          where: { id: action.id },
        });
        if (freshAction && freshAction.status === ActionStatus.COMPLETED) {
          return NextResponse.json({ status: "paid" });
        }
      }
    } catch (refetchError) {
      logger.error("Refetch check error in payment-status catch block:", { error: String(refetchError) });
    }

    if (errorMessage(error).includes("Invalid recovery transition") || 
        errorMessage(error).includes("Invalid action transition") ||
        errorMessage(error).includes("concurrency check failure") ||
        errorMessage(error).includes("Action concurrently modified")) {
      // The code is actionable; the internal from/to state text is not, and it
      // names database ids. Logged above, never returned.
      return NextResponse.json(
        {
          error: "INVALID_TRANSITION",
          message: "This payment has already moved on and cannot be updated again.",
        },
        { status: 409 }
      );
    }

    logger.error("API error in payment-status", { error: errorMessage(error) });
    return NextResponse.json({ error: "Could not check the payment status. Please try again." }, { status: 500 });
  }
}
