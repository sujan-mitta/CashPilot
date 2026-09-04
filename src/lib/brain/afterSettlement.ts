import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability";
import { errorMessage } from "@/lib/errors";
import { syncFinancialBrain } from "./sync";

/**
 * Fold a completed settlement into the financial brain.
 *
 * WHY A HELPER AND NOT A CALL AT EACH SITE
 *
 * Settlement has more than one entrance, and wiring them one at a time is how
 * this was got wrong the first time. The sync was added to the Razorpay webhook
 * alone — which is the entrance that does NOT run during local development,
 * because Razorpay will not deliver a webhook to localhost. The sandbox
 * checkout settles through /api/payment-status with trigger POLL instead, so
 * every locally settled payment skipped entity resolution entirely and the
 * behavioural forecast stayed exactly as inert as before the fix.
 *
 * One helper, called from every entrance, so adding a new one is a visible
 * decision rather than a silent omission.
 *
 * WHY IT NEVER THROWS
 *
 * By the time this runs the money is settled and recorded. Its callers are
 * finishing a request that has already changed the ledger:
 *
 *   · the webhook — throwing fails the delivery, and Razorpay retries a payment
 *     that has ALREADY been applied
 *   · payment-status — throwing shows the operator an error for a payment that
 *     genuinely succeeded
 *
 * A stale brain is a worse forecast. A retried settlement is a corrupted
 * ledger. The trade is not close, so failure is logged and swallowed.
 */
export async function syncAfterSettlement(
  businessId: string,
  context: { trigger: string; paymentLinkId?: string }
): Promise<void> {
  try {
    const result = await syncFinancialBrain(prisma, businessId);
    logger.info("Settlement folded into the financial brain", {
      businessId,
      trigger: context.trigger,
      paymentLinkId: context.paymentLinkId,
      customersLinked: result.entities?.customersLinked ?? 0,
      stateVersion: result.state?.stateVersion ?? null,
    });
  } catch (error) {
    logger.error("Settled the payment, but the brain sync failed", {
      businessId,
      trigger: context.trigger,
      paymentLinkId: context.paymentLinkId,
      error: errorMessage(error),
    });
  }
}
