import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { settlePayment } from "@/lib/razorpay/settlement";
import { inspectConfiguration } from "@/lib/config/productionConfig";
import { logger, withCorrelationId } from "@/lib/observability";
import { errorMessage } from "@/lib/errors";
import { rateLimit, clientKey } from "@/lib/auth/rateLimit";
import { readProviderPaidAmount, describeRejection } from "@/lib/razorpay/amounts";
import {
  beginDelivery,
  markProcessing,
  markSucceeded,
  markFailed,
  markDuplicate,
  markIgnored,
  recordRejectedDelivery,
} from "@/lib/razorpay/webhookDelivery";

/**
 * True only for a unique-constraint violation.
 *
 * The idempotency claim below used to catch EVERYTHING and answer
 * ALREADY_PROCESSED, so a pool exhaustion or a dropped connection during
 * `processedEvent.create` returned HTTP 200 and Razorpay never retried - a real
 * payment silently dropped. Only P2002 means "another delivery won the race";
 * anything else must surface as a 500 so the provider redelivers.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "P2002") return true;
  // The pg driver surfaces the same condition as SQLSTATE 23505 when an error
  // escapes Prisma's own wrapping.
  return code === "23505";
}

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
    // Every rejected delivery writes a WebhookDeliveryAttempt row, so an
    // unauthenticated flood of bad signatures was unbounded storage growth on
    // a public endpoint. The ceiling is deliberately generous - far above any
    // real provider retry rate - so genuine traffic is never touched.
    const limited = rateLimit(`webhook:${clientKey(req)}`, 120, 60_000);
    if (!limited.ok) {
      logger.warn("Webhook rate limit exceeded", { retryAfterSec: limited.retryAfterSec });
      return NextResponse.json(
        { error: "Too many requests." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
      );
    }

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
    // Razorpay carries the unique event id in the X-Razorpay-Event-Id HEADER,
    // not the body - the webhook payload has no top-level `id`. Reading only
    // `event.id` rejected every real delivery as MISSING_EVENT_ID (caught by
    // WebhookDeliveryAttempt). The header is the idempotency key; the body id
    // is kept as a fallback so synthetic/test events that embed one still work.
    const eventId = req.headers.get("x-razorpay-event-id") || event.id;

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
    } catch (claimError) {
      if (isUniqueConstraintViolation(claimError)) {
        // Another delivery won the race. This one is genuinely a duplicate.
        logger.info("Webhook event already processed (raced)", { eventId, eventType: event.event, alreadyProcessed: true });
        await markDuplicate(deliveryId);
        return NextResponse.json({ status: "ALREADY_PROCESSED" });
      }
      // Anything else - a dead connection, an exhausted pool - means we do NOT
      // know whether the claim landed and we have certainly not settled
      // anything. Answering 200 here told Razorpay the payment was handled and
      // stopped every retry, losing the money for good. Fail loudly instead.
      logger.error("Webhook idempotency claim failed", {
        eventId,
        error: errorMessage(claimError),
      });
      await markFailed(deliveryId, "PROCESSING_ERROR", errorMessage(claimError));
      return NextResponse.json({ error: "IDEMPOTENCY_CLAIM_FAILED" }, { status: 500 });
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

      // What the provider says was ACTUALLY paid.
      //
      // `amount_paid ?? amount`, never `||`: a partial or unpaid link reports
      // `amount_paid: 0`, which is falsy, so the old fallback credited the full
      // face value of the link for money that had not arrived. Zero is a real
      // answer and must be carried through as one.
      // A payload carrying NO amount field at all is a different case from one
      // carrying a bad amount. With nothing reported, settlement falls back to
      // the amount we already know is owed - which is bounded by our own record
      // and cannot over-credit. Only an amount that IS present and unusable
      // (negative, fractional, NaN, absurd) is refused.
      const paid = readProviderPaidAmount(event.payload?.payment_link?.entity);
      if (!paid.ok && paid.reason === "MISSING") {
        logger.warn("Webhook reported no settlement amount; falling back to the expected amount", {
          eventId,
          paymentLinkId,
        });
      } else if (!paid.ok) {
        await releaseEventClaim();
        await markFailed(deliveryId, "PROCESSING_ERROR", describeRejection(paid.reason), {
          businessId,
          externalRef: paymentLinkId,
        });
        logger.error("Webhook reported an unusable settlement amount", {
          eventId,
          paymentLinkId,
          rejection: paid.reason,
        });
        return NextResponse.json(
          { error: "INVALID_SETTLEMENT_AMOUNT", message: describeRejection(paid.reason) },
          { status: 400 }
        );
      }
      const actualAmount = paid.ok ? paid.amount : undefined;

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

    // An event type we do not act on is handled CORRECTLY, not failed. Marking
    // it FAILED made the failure metric this table exists to provide count
    // every routine unhandled delivery, burying real settlement failures.
    await markIgnored(deliveryId, event.event);
    return NextResponse.json({ status: "EVENT_IGNORED" });
  } catch (error) {
    // Catch-all, including an unparseable body. Any delivery record already
    // opened survives with a classification rather than vanishing.
    await markFailed(deliveryId, "PROCESSING_ERROR", errorMessage(error));
    logger.error("Webhook processing error", { error: errorMessage(error) });
    // The internal message is logged, never returned. A Prisma error carries
    // table and column names, and the client here is an external party.
    return NextResponse.json({ error: "WEBHOOK_PROCESSING_FAILED" }, { status: 500 });
  }
});
