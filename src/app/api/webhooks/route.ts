import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { settlePayment } from "@/lib/razorpay/settlement";
import { inspectConfiguration } from "@/lib/config/productionConfig";
import { logger, withCorrelationId } from "@/lib/observability";
import { errorMessage } from "@/lib/errors";
import {
  beginDelivery,
  markProcessing,
  markSucceeded,
  markFailed,
  markDuplicate,
  recordRejectedDelivery,
} from "@/lib/razorpay/webhookDelivery";

export interface RazorpayWebhookPaymentLinkEntity {
  id?: string;
  amount?: number;
  amount_paid?: number;
  status?: string;
  reference_id?: string;
}

export interface RazorpayWebhookPayload {
  payment_link?: {
    entity?: RazorpayWebhookPaymentLinkEntity;
  };
}

export interface RazorpayWebhookEvent {
  id?: string;
  event?: string;
  payload?: RazorpayWebhookPayload;
}

export const POST = withCorrelationId(async (req: Request) => {
  // M1: durable evidence that a delivery ARRIVED, independent of whether it is
  // accepted, rejected, or fails during processing. Never deleted.
  let deliveryId: string | null = null;
  try {
    const body = await req.text();
    const signature = req.headers.get("x-razorpay-signature");
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    // Cryptographically verify Razorpay Webhook Signature if secret is configured
    if (secret) {
      if (!signature) {
        logger.warn("Webhook signature validation failed", { failureClassification: "MISSING_SIGNATURE", status: 400 });
        await recordRejectedDelivery("MISSING_SIGNATURE");
        return NextResponse.json({ error: "Missing x-razorpay-signature header" }, { status: 400 });
      }

      // Check if signature contains only hex characters and is exactly 64 characters long (SHA-256 digest length)
      const hexRegex = /^[0-9a-fA-F]{64}$/;
      if (!hexRegex.test(signature)) {
        logger.warn("Webhook signature validation failed", { failureClassification: "MALFORMED_SIGNATURE", status: 400 });
        await recordRejectedDelivery("MALFORMED_SIGNATURE");
        return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
      }

      const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");

      const expectedBuffer = Buffer.from(expectedSignature, "hex");
      const signatureBuffer = Buffer.from(signature, "hex");

      if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
        logger.warn("Webhook signature validation failed", { failureClassification: "INVALID_SIGNATURE", status: 400 });
        await recordRejectedDelivery("INVALID_SIGNATURE");
        return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
      }
    } else if (inspectConfiguration().isProduction) {
      // An unsigned webhook is an unauthenticated instruction to move money.
      // Silently accepting it because a variable happens to be unset is not a
      // dev convenience, it is a remote ledger-write primitive.
      logger.error("RAZORPAY_WEBHOOK_SECRET is not configured; refusing unsigned webhook.", { status: 500 });
      await recordRejectedDelivery("SECRET_NOT_CONFIGURED");
      return NextResponse.json(
        { error: "WEBHOOK_SECRET_NOT_CONFIGURED" },
        { status: 500 }
      );
    } else {
      logger.warn("RAZORPAY_WEBHOOK_SECRET is not defined, skipping signature check in dev/sandbox mode.");
    }

    const event = JSON.parse(body) as RazorpayWebhookEvent;
    const eventId = event.id;

    if (!eventId) {
      await recordRejectedDelivery("MISSING_EVENT_ID");
      return NextResponse.json({ error: "Missing event ID" }, { status: 400 });
    }

    // Signature is valid and the event identifies itself: from here this is
    // genuine provider traffic and is recorded as a real delivery.
    deliveryId = await beginDelivery({ providerEventId: eventId, eventType: event.event });

    // Idempotency claim.
    //
    // The row is written BEFORE processing so that two concurrent deliveries of
    // the same event cannot both settle it - the unique constraint decides the
    // winner. It is released again if processing throws, because otherwise a
    // transient failure would permanently mark a real payment as "handled" and
    // the money would never be credited. Claim-then-release keeps duplicate
    // delivery safe without making failure absorb the event.
    try {
      const exists = await prisma.processedEvent.findUnique({
        where: { id: eventId },
      });
      if (exists) {
        logger.info("Webhook event already processed", { eventId, eventType: event.event, alreadyProcessed: true });
        await markDuplicate(deliveryId);
        return NextResponse.json({ status: "ALREADY_PROCESSED" });
      }

      await prisma.processedEvent.create({
        data: { id: eventId },
      });
    } catch {
      // Unique constraint violation: another delivery won the race.
      logger.info("Webhook event already processed (raced)", { eventId, eventType: event.event, alreadyProcessed: true });
      await markDuplicate(deliveryId);
      return NextResponse.json({ status: "ALREADY_PROCESSED" });
    }

    const releaseEventClaim = async () => {
      try {
        await prisma.processedEvent.delete({ where: { id: eventId } });
      } catch (releaseError) {
        logger.error("Failed to release webhook idempotency claim", { error: String(releaseError) });
      }
    };

    // Settle ledger on payment_link.paid event
    if (event.event === "payment_link.paid") {
     const paymentLinkId = event.payload?.payment_link?.entity?.id;
     if (!paymentLinkId) {
       await releaseEventClaim();
       await markFailed(deliveryId, "MISSING_PAYMENT_LINK_ID");
       return NextResponse.json({ error: "Missing paymentLinkId" }, { status: 400 });
     }
      try {
        await markProcessing(deliveryId);
        const referenceId = event.payload?.payment_link?.entity?.reference_id;

      let intent = null;
      if (referenceId) {
        intent = await prisma.executionIntent.findUnique({
          where: { idempotencyKey: referenceId },
        });
      }
      if (!intent) {
        intent = await prisma.executionIntent.findFirst({
          where: { externalRef: paymentLinkId },
        });
      }

      let businessId: string | null = intent?.businessId || null;

      // Fallbacks for legacy/backward compatibility
      if (!businessId) {
        // 1. Check if linked via PaymentRecovery
        const recovery = await prisma.paymentRecovery.findFirst({
          where: { paymentLinkId },
          include: {
            transaction: {
              select: { businessId: true },
            },
          },
        });
        if (recovery && recovery.transaction) {
          businessId = recovery.transaction.businessId;
        }
      }

      if (!businessId) {
        // 2. Check if linked via AgentAction
        const action = await prisma.agentAction.findFirst({
          where: {
            result: { contains: paymentLinkId },
          },
          include: {
            strategy: {
              select: { businessId: true },
            },
          },
        });
        if (action && action.strategy) {
          businessId = action.strategy.businessId;
        }
      }

      if (!businessId) {
        await releaseEventClaim();
        await markFailed(deliveryId, "PROCESSING_ERROR", "Linked business not found for this payment link", { externalRef: paymentLinkId });
        return NextResponse.json({ error: "Linked business not found for this payment link" }, { status: 404 });
      }

      const businessExists = await (prisma.business.findUnique || prisma.business.findFirst)({
        where: { id: businessId },
      });
      if (!businessExists) {
        await releaseEventClaim();
        await markFailed(deliveryId, "PROCESSING_ERROR", "Business not found", { businessId, externalRef: paymentLinkId });
        return NextResponse.json({ error: "Business not found" }, { status: 404 });
      }

      // Extract actual paid amount from Razorpay event payload
      const actualAmount = event.payload?.payment_link?.entity?.amount_paid || event.payload?.payment_link?.entity?.amount;

      // Execute shared transactional settlement
      const finalStatus = await settlePayment(paymentLinkId, businessId, actualAmount, referenceId, "WEBHOOK");
      logger.info("Webhook event processed successfully", {
        eventId,
        eventType: event.event,
        paymentLinkId,
        processingResult: finalStatus,
        alreadyProcessed: false
      });
      await markSucceeded(deliveryId, {
        businessId,
        executionIntentId: intent?.id ?? null,
        externalRef: paymentLinkId,
      });
      return NextResponse.json({ status: finalStatus });
     } catch (settleError) {
      // ProcessedEvent is released so a provider retry can still settle this
      // payment. The DELIVERY record is deliberately NOT released - that is the
      // whole of M1: the attempt stays visible even as the event becomes
      // claimable again.
      await releaseEventClaim();
      await markFailed(deliveryId, "PROCESSING_ERROR", String(settleError), { externalRef: paymentLinkId });
      logger.error("Failed to settle webhook payment", { eventId, paymentLinkId, error: String(settleError) });
      throw settleError;
     }
    }

    await markFailed(deliveryId, "UNKNOWN_EVENT_TYPE", "Unhandled event type: " + String(event.event));
    return NextResponse.json({ status: "EVENT_IGNORED" });
  } catch (error) {
    // Catch-all, including an unparseable body. Any delivery record already
    // opened survives with a classification rather than vanishing.
    await markFailed(deliveryId, "PROCESSING_ERROR", errorMessage(error));
    logger.error("Webhook processing error", { error: errorMessage(error) });
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
});
