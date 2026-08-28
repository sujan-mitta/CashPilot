import { Prisma, FinancialEvent, FinancialEventType } from "../../../generated/prisma/client";
import { logger } from "@/lib/observability";

/**
 * Phase 1 - the append-only writer for the canonical Financial Event spine.
 *
 * Every source (bank, ERP, invoices, Razorpay, email, user) will eventually
 * normalise its raw records and call this. In Phase 1 there are NO callers in
 * production code paths - the writer and its table exist, but nothing reads the
 * events yet - so this cannot change any existing behaviour.
 *
 * Idempotency is the whole point: (businessId, sourceType, sourceRecordId) is a
 * stable source identity, so re-delivering the same record (a webhook retry, a
 * re-sync, a crash mid-batch) resolves to the SAME event rather than a
 * duplicate. Money in this system is always paise; amount is Int paise or null.
 *
 * The writer never sees or stores secrets: `normalizedData` is a structured,
 * already-sanitised payload and must never carry credentials, signatures or raw
 * provider headers.
 */

export interface RecordFinancialEventInput {
  eventType: FinancialEventType;
  /** Originating source, e.g. "RAZORPAY", "BANK", "ERP", "INVOICE", "USER", "SEED". */
  sourceType: string;
  /** Stable identifier of the record at the source. Half of the idempotency key. */
  sourceRecordId: string;
  /** When the event occurred at the source. */
  occurredAt: Date;
  /** When it takes financial effect. Defaults to occurredAt. */
  effectiveAt?: Date;
  /** Canonical entity id once entity resolution lands (P4). Null in Phase 1. */
  entityId?: string | null;
  /** Monetary value in paise, or null for non-monetary events. */
  amount?: number | null;
  /** ISO currency; defaults to INR. */
  currency?: string;
  /** Source-specific lifecycle status. */
  status?: string | null;
  /** Structured, sanitised payload. NEVER secrets/credentials/signatures. */
  normalizedData?: Prisma.InputJsonValue;
  /** Non-sensitive pointer back to the raw record (e.g. an internal row id). */
  rawReference?: string | null;
}

export interface RecordFinancialEventResult {
  event: FinancialEvent;
  /** true if this call inserted the event; false if it already existed. */
  created: boolean;
}

/**
 * The minimal client surface this writer needs. Both the base Prisma client and
 * a `$transaction` transaction client satisfy it, and a test can supply a plain
 * in-memory double.
 */
export type FinancialEventClient = Pick<Prisma.TransactionClient, "financialEvent">;

/** Prisma's error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Idempotently record a financial event for a tenant.
 *
 * On the first call for a given (tenant, sourceType, sourceRecordId) it inserts
 * and returns `{ created: true }`. Any subsequent call with the same identity
 * returns the existing event with `{ created: false }` - including the race
 * where a concurrent writer won the insert (the losing insert hits the unique
 * constraint and is resolved by reading the winner's row).
 *
 * A non-duplicate failure (a transient database error) is re-thrown so the
 * caller can retry; it is never swallowed.
 */
export async function recordFinancialEvent(
  client: FinancialEventClient,
  tenantId: string,
  input: RecordFinancialEventInput
): Promise<RecordFinancialEventResult> {
  if (!tenantId) {
    throw new Error("recordFinancialEvent requires a tenantId.");
  }
  if (!input.sourceType || !input.sourceRecordId) {
    throw new Error("recordFinancialEvent requires sourceType and sourceRecordId (the idempotency identity).");
  }

  const effectiveAt = input.effectiveAt ?? input.occurredAt;

  try {
    const event = await client.financialEvent.create({
      data: {
        businessId: tenantId,
        eventType: input.eventType,
        sourceType: input.sourceType,
        sourceRecordId: input.sourceRecordId,
        entityId: input.entityId ?? null,
        amount: input.amount ?? null,
        currency: input.currency ?? "INR",
        occurredAt: input.occurredAt,
        effectiveAt,
        status: input.status ?? null,
        normalizedData: input.normalizedData,
        rawReference: input.rawReference ?? null,
      },
    });

    logger.info("EVENT_INGESTED", {
      businessId: tenantId,
      financialEventId: event.id,
      eventType: input.eventType,
      sourceType: input.sourceType,
      sourceRecordId: input.sourceRecordId,
    });

    return { event, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      // A genuine failure - surface it. The caller is responsible for retry.
      throw err;
    }

    // Already ingested (retry, re-sync, or a concurrent insert winning the
    // race): resolve to the existing row. This is the idempotent path.
    const existing = await client.financialEvent.findUnique({
      where: {
        businessId_sourceType_sourceRecordId: {
          businessId: tenantId,
          sourceType: input.sourceType,
          sourceRecordId: input.sourceRecordId,
        },
      },
    });

    if (!existing) {
      // Unique violation but nothing found - the constraint we tripped is not
      // the source identity we expected. Do not pretend this was idempotent.
      throw err;
    }

    logger.info("EVENT_DUPLICATE", {
      businessId: tenantId,
      financialEventId: existing.id,
      sourceType: input.sourceType,
      sourceRecordId: input.sourceRecordId,
    });

    return { event: existing, created: false };
  }
}
