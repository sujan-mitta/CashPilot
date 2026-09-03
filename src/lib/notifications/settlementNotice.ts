import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability";
import { sendNotificationEmail } from "./mailer";
import { evaluateRecipient } from "./recipientEligibility";
import { buildMovementsForBusiness } from "@/lib/forecast/movements";
import { buildForecast } from "@/lib/engine/forecast";
import { calculateLiquiditySafetyRequirement } from "@/lib/engine/liquiditySafety";
import { describeSafetyProgress, type SafetyProgress } from "@/lib/engine/safetyProgress";
import { renderSettlementEmail } from "./settlementEmail";

/**
 * Telling an operator that money arrived, and what it changed.
 *
 * WHY THE HEALTH REPORT BELONGS IN THE SAME MESSAGE
 *
 * "You received Rs 2,40,000" is pleasant and not actionable. The question it
 * immediately raises is whether that was enough, and answering it in a second
 * message — or not at all — leaves the operator to open the app and work it out.
 * The figures are recomputed AFTER the settlement, so the email reports where
 * the business actually stands rather than where it stood when the link was
 * issued.
 *
 * WHO IT GOES TO
 *
 * Only addresses somebody has proven they can read. This runs through the same
 * eligibility gate as every crisis alert, for the same reason: an address that
 * does not exist bounces, and the bounce comes back to us. A settlement notice
 * is a nice-to-have; generating bounces is not a nice-to-have cost.
 *
 * NEVER FATAL
 *
 * Settlement has already happened and been recorded by the time this runs. A
 * mail failure must not turn a successful settlement into a failed webhook,
 * because Razorpay would then retry a payment that was already applied.
 */

export interface SettlementNotice {
  amount: number;
  paymentLinkId: string;
}

export async function notifySettlement(
  businessId: string,
  payment: SettlementNotice
): Promise<{ sent: number; suppressed: number }> {
  try {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      include: { users: true },
    });
    if (!business) return { sent: 0, suppressed: 0 };

    // What the money was FOR, in the operator's own words. Resolved here rather
    // than passed in: the caller has a payment link id, and the description
    // lives two joins away from it.
    const recovery = await prisma.paymentRecovery.findFirst({
      where: { paymentLinkId: payment.paymentLinkId },
      select: { transaction: { select: { description: true } } },
    });
    const description = recovery?.transaction?.description ?? "Recovered payment";

    // Recomputed after the money landed. Reporting the figures the plan was
    // built from would describe a business that no longer exists.
    const progress = await currentStanding(businessId, business.currentCash);

    let sent = 0;
    let suppressed = 0;

    for (const user of business.users) {
      const eligibility = evaluateRecipient(user);
      if (!eligibility.sendable) {
        suppressed++;
        continue;
      }

      const rendered = renderSettlementEmail({
        recipientName: user.name || "there",
        businessName: business.name,
        payment: { ...payment, description },
        currentCash: business.currentCash,
        progress,
      });

      const result = await sendNotificationEmail({
        alertId: `settlement_${payment.paymentLinkId}`,
        businessId,
        to: user.email,
        recipientName: user.name || "there",
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      if (result.status === "SENT" || result.status === "ACCEPTED") sent++;
    }

    logger.info("Settlement notice dispatched", { businessId, sent, suppressed });
    return { sent, suppressed };
  } catch (error) {
    // Swallowed on purpose. The money is already settled and recorded; letting
    // this throw would fail the webhook, and Razorpay would retry a payment
    // that has already been applied.
    logger.error("Settlement notice failed", {
      businessId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sent: 0, suppressed: 0 };
  }
}

async function currentStanding(businessId: string, currentCash: number): Promise<SafetyProgress> {
  const transactions = await prisma.transaction.findMany({ where: { businessId } });
  const movements = await buildMovementsForBusiness(prisma, businessId, transactions);
  const days = buildForecast(currentCash, movements);
  const projectedLow = days.length
    ? Math.min(...days.map((d) => d.closingBalance))
    : currentCash;

  const safety = await calculateLiquiditySafetyRequirement(businessId, prisma);

  const [recovered, outstanding] = await Promise.all([
    prisma.paymentRecovery.aggregate({
      where: { status: "RECOVERED", transaction: { businessId } },
      _sum: { amount: true },
    }),
    prisma.paymentRecovery.aggregate({
      where: { status: "PAYMENT_PENDING", transaction: { businessId } },
      _sum: { amount: true },
    }),
  ]);

  return describeSafetyProgress({
    projectedLow,
    safeFloor: safety.requiredBuffer,
    recovered: recovered._sum.amount ?? 0,
    outstanding: outstanding._sum.amount ?? 0,
  });
}
