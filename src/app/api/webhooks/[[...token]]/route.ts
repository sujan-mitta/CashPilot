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
  markUnmatched,
  countDeliveriesForEvent,
  UNMATCHED_RETRY_ATTEMPTS,
} from "@/lib/razorpay/webhookDelivery";
import { webhookSecretForToken } from "@/lib/razorpay/connection";
import { syncAfterSettlement } from "@/lib/brain/afterSettlement";
import { notifySettlement } from "@/lib/notifications/settlementNotice";

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

    // WHICH ACCOUNT SIGNED THIS?
    //
    // Razorpay signs with a per-account secret, so a deployment serving several
    // merchants cannot verify with one shared value. The account is identified
    // by the URL — /api/webhooks/<token> — and not by anything in the body.
    //
    // The URL rather than the payload, because a webhook can arrive BEFORE our
    // own record of the payment link is written. That race has already been
    // observed here; resolving the tenant from the payload would leave those
    // webhooks unverifiable through no fault of the sender.
    //
    // Read from the path rather than route params because withCorrelationId
    // forwards only the request, and changing a wrapper used by every route to
    // thread one parameter would be a worse trade.
    const token = new URL(req.url).pathname.split("/api/webhooks/")[1]?.split("/")[0] || null;

    let secret: string | undefined;
    if (token) {
      const connection = await webhookSecretForToken(token);
      if (!connection) {
        // An unknown token is REFUSED, never quietly verified against the
        // deployment's secret. Falling back would let anyone invent a token and
        // still be checked against a key that might match — which would make
        // the token look like security while providing none.
        logger.warn("Webhook rejected for unknown token", { failureClassification: "UNKNOWN_WEBHOOK_TOKEN" });
        await recordRejectedDelivery("UNKNOWN_WEBHOOK_TOKEN");
        return NextResponse.json({ error: "Unknown webhook endpoint" }, { status: 404 });
      }
      secret = connection.secret;
    } else {
      secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    }

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
        // A webhook for a link CashPilot does not manage.
        //
        // This used to answer 404 and release the claim, which is a request to
        // retry — and no amount of retrying produces a business that does not
        // exist. Razorpay therefore retried with backoff indefinitely. That is
        // not hypothetical: it was observed in production against a real
        // payment, four deliveries in 45 seconds, and it is the most likely
        // explanation for the Phase 18 webhook going silent after 13 failures.
        // Providers disable endpoints that keep failing.
        //
        // The race is real too, so we do not give up immediately: the provider
        // can deliver before our own row is committed. A bounded number of
        // retries covers that; beyond it, the link is genuinely not ours.
        const attempts = await countDeliveriesForEvent(eventId);

        if (attempts <= UNMATCHED_RETRY_ATTEMPTS) {
          await releaseEventClaim();
          await markFailed(
            deliveryId,
            "PROCESSING_ERROR",
            `No linked business yet for ${paymentLinkId} (attempt ${attempts}); allowing retry.`,
            { externalRef: paymentLinkId }
          );
          return NextResponse.json(
            { error: "Linked business not found yet; retry expected" },
            { status: 503 }
          );
        }

        // Terminal, and ACKNOWLEDGED. The claim is deliberately NOT released:
        // this event has been definitively handled, and the honest answer is
        // "nothing to do", not "try again".
        await markUnmatched(deliveryId, paymentLinkId);
        logger.warn("Acknowledged a webhook for an unmatched payment link", {
          paymentLinkId,
          attempts,
        });
        return NextResponse.json(
          { ok: true, outcome: "UNMATCHED_PAYMENT_LINK", paymentLinkId },
          { status: 200 }
        );
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

      // Tell the operator the money arrived, and what it changed.
      //
      // AFTER the settlement and outside its transaction, so the figures in the
      // email describe where the business stands now. Awaited rather than left
      // dangling — a serverless function can be frozen the moment it responds,
      // which would kill an unawaited send partway through.
      //
      // It cannot fail this request: the money is already settled and recorded,
      // and throwing here would fail the webhook, so Razorpay would retry a
      // payment that has already been applied.
      await notifySettlement(businessId, { amount: actualAmount ?? 0, paymentLinkId });

      // Fold the payment into the brain, so the NEXT forecast knows about it.
      //
      // Deliberately last, and via a helper shared with every other settlement
      // entrance — see afterSettlement.ts for why it can never throw here.
      await syncAfterSettlement(businessId, { trigger: "WEBHOOK", paymentLinkId });

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
