import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability";
import { WebhookDeliveryStatus } from "../../../generated/prisma/client";

/**
 * ===========================================================================
 * DURABLE WEBHOOK DELIVERY OBSERVABILITY  (M1)
 * ===========================================================================
 *
 * ProcessedEvent is the IDEMPOTENCY mechanism: one row per event id, claimed
 * before processing and released again if processing throws. That release is
 * correct - without it a transient failure would permanently mark a real
 * payment as handled and the money would never be credited - but it means a
 * webhook that arrived and then failed left no trace at all. During the Phase
 * 20 audit that was decisive: three payments occurred after the webhook was
 * correctly configured, no event rows existed, and there was no way to tell
 * "never delivered" from "delivered and failed".
 *
 * This module records the DELIVERY, which is a different fact from the EVENT.
 * It is append-mostly and never deleted, so the two answer different questions:
 *
 *   ProcessedEvent          - has this event already taken effect?
 *   WebhookDeliveryAttempt  - what did the provider actually send us, and what
 *                             happened to it?
 *
 * THREE RULES, all load-bearing:
 *
 *   1. It never mutates financial state. Nothing here touches a ledger, an
 *      intent, an invoice or a recovery.
 *   2. It never throws. Observability that can break the path it observes is
 *      worse than no observability, so every function swallows its own errors
 *      and degrades to a log line.
 *   3. It never persists a secret, a signature, an authorization header or a
 *      raw payload - only identifiers needed to correlate a delivery.
 */

/** Stable, non-sensitive classifications for a rejected or failed delivery. */
export type WebhookErrorClass =
  | "MISSING_SIGNATURE"
  | "MALFORMED_SIGNATURE"
  | "INVALID_SIGNATURE"
  | "SECRET_NOT_CONFIGURED"
  | "MALFORMED_BODY"
  | "MISSING_EVENT_ID"
  | "MISSING_PAYMENT_LINK_ID"
  | "UNKNOWN_EVENT_TYPE"
  | "IGNORED_EVENT_TYPE"
  | "UNMATCHED_PAYMENT_LINK"
  | "PROCESSING_ERROR";

/** Error text is ours, not the provider's, but truncate it regardless. */
const MAX_ERROR_LENGTH = 500;

/**
 * How many times this event id has been delivered, including this delivery.
 *
 * providerEventId is deliberately NOT unique on the table: a retry and a
 * duplicate are exactly what we are trying to see.
 */
async function nextAttemptNumber(providerEventId: string | null): Promise<number> {
  if (!providerEventId) return 1;
  try {
    return (await prisma.webhookDeliveryAttempt.count({ where: { providerEventId } })) + 1;
  } catch {
    return 1;
  }
}

export interface DeliveryContext {
  providerEventId?: string | null;
  eventType?: string | null;
  correlationId?: string | null;
}

/**
 * Opens a delivery record. Returns its id, or null if recording failed.
 *
 * A null id makes every later call a no-op, so the webhook path continues
 * unaffected when observability is unavailable.
 */
export async function beginDelivery(ctx: DeliveryContext): Promise<string | null> {
  try {
    const row = await prisma.webhookDeliveryAttempt.create({
      data: {
        provider: "razorpay",
        providerEventId: ctx.providerEventId ?? null,
        eventType: ctx.eventType ?? null,
        status: WebhookDeliveryStatus.RECEIVED,
        attemptNumber: await nextAttemptNumber(ctx.providerEventId ?? null),
        correlationId: ctx.correlationId ?? null,
        receivedAt: new Date(),
      },
    });
    return row.id;
  } catch (err) {
    logger.error("Failed to record webhook delivery receipt", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Records that processing actually started, for latency and hang diagnosis. */
export async function markProcessing(id: string | null): Promise<void> {
  if (!id) return;
  try {
    await prisma.webhookDeliveryAttempt.update({
      where: { id },
      data: { status: WebhookDeliveryStatus.PROCESSING, processingStartedAt: new Date() },
    });
  } catch (err) {
    logger.error("Failed to mark webhook delivery PROCESSING", { id, error: String(err) });
  }
}

export interface DeliveryOutcome {
  businessId?: string | null;
  executionIntentId?: string | null;
  externalRef?: string | null;
}

/** Terminal: the delivery was processed and money (if any) was settled. */
export async function markSucceeded(id: string | null, out: DeliveryOutcome = {}): Promise<void> {
  if (!id) return;
  try {
    await prisma.webhookDeliveryAttempt.update({
      where: { id },
      data: {
        status: WebhookDeliveryStatus.SUCCEEDED,
        processingCompletedAt: new Date(),
        businessId: out.businessId ?? null,
        executionIntentId: out.executionIntentId ?? null,
        externalRef: out.externalRef ?? null,
      },
    });
  } catch (err) {
    logger.error("Failed to mark webhook delivery SUCCEEDED", { id, error: String(err) });
  }
}

/**
 * Terminal: this delivery did not take effect.
 *
 * The row SURVIVES - that is the entire point of M1. ProcessedEvent may be
 * released so the event can be retried; this record of the attempt is not.
 */
export async function markFailed(
  id: string | null,
  errorClass: WebhookErrorClass,
  errorMessage?: string,
  out: DeliveryOutcome = {}
): Promise<void> {
  if (!id) return;
  try {
    await prisma.webhookDeliveryAttempt.update({
      where: { id },
      data: {
        status: WebhookDeliveryStatus.FAILED,
        processingCompletedAt: new Date(),
        errorClass,
        errorMessage: errorMessage ? errorMessage.slice(0, MAX_ERROR_LENGTH) : null,
        businessId: out.businessId ?? null,
        executionIntentId: out.executionIntentId ?? null,
        externalRef: out.externalRef ?? null,
      },
    });
  } catch (err) {
    logger.error("Failed to mark webhook delivery FAILED", { id, error: String(err) });
  }
}

/**
 * Terminal: a well-formed delivery for an event type CashPilot does not act on.
 *
 * This is NOT a failure. Marking `subscription.charged` or `payment.captured`
 * FAILED - which is what happened before - meant the failure metric that this
 * whole table exists to provide counted every routine unhandled event, so a
 * genuine settlement failure was indistinguishable from ordinary traffic.
 *
 * The status is SUCCEEDED because the delivery WAS handled correctly; the
 * `errorClass` is what separates "settled money" from "correctly ignored", so
 * both remain queryable. A dedicated `IGNORED` value on WebhookDeliveryStatus
 * would say this more directly, but that needs a schema migration - see the
 * manual follow-up list.
 */
export async function markIgnored(id: string | null, eventType?: string | null): Promise<void> {
  if (!id) return;
  try {
    await prisma.webhookDeliveryAttempt.update({
      where: { id },
      data: {
        status: WebhookDeliveryStatus.SUCCEEDED,
        processingCompletedAt: new Date(),
        errorClass: "IGNORED_EVENT_TYPE",
        errorMessage: `CashPilot does not act on "${String(eventType ?? "unknown")}". No financial effect.`.slice(
          0,
          MAX_ERROR_LENGTH
        ),
      },
    });
  } catch (err) {
    logger.error("Failed to mark webhook delivery IGNORED", { id, error: String(err) });
  }
}

/**
 * Terminal: a well-formed `payment_link.paid` for a link CashPilot does not
 * manage.
 *
 * SUCCEEDED, not FAILED, for the same reason `markIgnored` exists. The provider
 * did nothing wrong and neither did we — the link simply is not ours. Returning
 * an error made Razorpay retry with backoff forever, because a 4xx/5xx is a
 * request to try again, and nothing about trying again would ever produce a
 * business that does not exist.
 *
 * That is not hypothetical. A link created in the Razorpay dashboard, by
 * another integration, or from a CashPilot record since deleted, all land here;
 * and an endpoint that keeps failing is an endpoint the provider eventually
 * disables — taking the real settlements down with it.
 */
export async function markUnmatched(
  id: string | null,
  paymentLinkId: string
): Promise<void> {
  if (!id) return;
  try {
    await prisma.webhookDeliveryAttempt.update({
      where: { id },
      data: {
        status: WebhookDeliveryStatus.SUCCEEDED,
        processingCompletedAt: new Date(),
        errorClass: "UNMATCHED_PAYMENT_LINK",
        errorMessage:
          `No CashPilot record is linked to payment link ${paymentLinkId}. Acknowledged so the provider stops retrying; no financial effect.`.slice(
            0,
            MAX_ERROR_LENGTH
          ),
        externalRef: paymentLinkId,
      },
    });
  } catch (err) {
    logger.error("Failed to mark webhook delivery UNMATCHED", { id, error: String(err) });
  }
}

/**
 * How many times an unmatched link is allowed to be retried before it is
 * accepted as genuinely unknown.
 *
 * Not zero, because the race is real: Razorpay can deliver before our own row
 * is committed, and giving up on the first attempt would drop a settlement we
 * were milliseconds away from being able to match. Not unbounded either, which
 * is what caused the problem.
 */
export const UNMATCHED_RETRY_ATTEMPTS = 3;

/** How many deliveries we have already seen for this provider event. */
export async function countDeliveriesForEvent(providerEventId: string | null): Promise<number> {
  if (!providerEventId) return 0;
  try {
    return await prisma.webhookDeliveryAttempt.count({ where: { providerEventId } });
  } catch (err) {
    logger.error("Failed to count webhook deliveries", { error: String(err) });
    // Unknown count must not be read as "plenty of attempts already", which
    // would give up on the first delivery of a genuine settlement.
    return 0;
  }
}

/** Terminal: a real delivery whose event had already taken effect. */
export async function markDuplicate(id: string | null): Promise<void> {
  if (!id) return;
  try {
    await prisma.webhookDeliveryAttempt.update({
      where: { id },
      data: { status: WebhookDeliveryStatus.DUPLICATE, processingCompletedAt: new Date() },
    });
  } catch (err) {
    logger.error("Failed to mark webhook delivery DUPLICATE", { id, error: String(err) });
  }
}

/**
 * Records a delivery rejected before its body could be trusted.
 *
 * Opens and closes the record in one step because there is nothing to process.
 * The signature itself is NEVER stored - only the classification of why it was
 * refused, which carries no secret material.
 */
export async function recordRejectedDelivery(
  errorClass: WebhookErrorClass,
  correlationId?: string | null
): Promise<void> {
  const id = await beginDelivery({ correlationId });
  await markFailed(id, errorClass);
}
