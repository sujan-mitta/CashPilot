import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import Razorpay from "razorpay";
import { getSession } from "@/lib/auth";
import { ActionStatus, RecoveryStatus } from "../../../../generated/prisma/client";
import { settlePayment, reconcileDecisionForStrategy } from "@/lib/razorpay/settlement";
import { errorMessage } from "@/lib/errors";

export async function GET(req: Request) {
  let paymentLinkId: string | null = null;
  let action: any = null;
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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

    // 1. Fetch live status from Razorpay API or check simulation parameters
    if (!isPlaceholder) {
      try {
        const razorpay = new Razorpay({
          key_id: keyId!,
          key_secret: keySecret!,
        });
        const link = await razorpay.paymentLink.fetch(paymentLinkId);
        status = link.status; // e.g. "paid", "created", "cancelled"
      } catch (err) {
        console.error("Razorpay fetch error, returning current database status:", err);
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
            const matchingLink = parsed.links?.find((l: any) => l.paymentLinkId === paymentLinkId);
            if (matchingLink) {
              const invoice = await prisma.invoice.findUnique({
                where: { id: matchingLink.invoiceId },
              });
              if (invoice && invoice.status === "PAID") {
                isInvoicePaid = true;
              }
            }
          } catch (e) {}
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
      await settlePayment(paymentLinkId, business.id, undefined, undefined, "POLL");
    } else if (status === "cancelled" || status === "expired") {
      if (action && action.status !== ActionStatus.FAILED) {
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
            auditLog: [...existingAudit, auditEntry] as any,
          },
        });
      }
    }

    // Verify rescheduling mismatch if requested for RESCHEDULE_PAYOUT
    if (action && action.actionType === "RESCHEDULE_PAYOUT") {
      const payout = await prisma.payout.findFirst({
        where: { id: action.targetPayoutId || "", businessId: business.id },
      });
      if (payout && payout.status !== "RESCHEDULED") {
        await prisma.agentAction.update({
          where: { id: action.id },
          data: {
            status: ActionStatus.RECONCILIATION_MISMATCH,
            result: `Discrepancy: Vendor payout status is ${payout.status} (expected RESCHEDULED)`,
          },
        });
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
    // Check if the resource was actually completed concurrently by another request
    try {
      const recovery = await prisma.paymentRecovery.findFirst({
        where: { paymentLinkId },
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
      console.error("Refetch check error in payment-status catch block:", refetchError);
    }

    if (errorMessage(error).includes("Invalid recovery transition") || 
        errorMessage(error).includes("Invalid action transition") ||
        errorMessage(error).includes("concurrency check failure") ||
        errorMessage(error).includes("Action concurrently modified")) {
      return NextResponse.json(
        { error: "INVALID_TRANSITION", message: errorMessage(error) },
        { status: 400 }
      );
    }

    console.error("API error in payment-status:", error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
