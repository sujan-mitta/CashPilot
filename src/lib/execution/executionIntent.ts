import { createHash } from "node:crypto";
import {
  ExecutionIntentStatus,
  ExecutionOperation,
  Prisma,
  ExecutionIntent,
} from "../../../generated/prisma/client";
import { logger } from "../observability";

/**
 * ===========================================================================
 * DURABLE EXECUTION INTENT  (Phase 15 P0)
 * ===========================================================================
 *
 * A database transaction cannot make an external Razorpay call atomic. The only
 * thing it can do is record, durably, that we are ABOUT to make one. Everything
 * here follows from that.
 *
 *   1. RECORD      commit the intent            (no external effect yet)
 *   2. CLAIM       RECORDED -> DISPATCHING      (compare-and-set, one winner)
 *   3. DISPATCH    the external call            (stable idempotency key)
 *   4. RESOLVE     -> SUCCEEDED | FAILED | UNKNOWN
 *
 * Crash matrix - what an interrupted run leaves behind and what is safe next:
 *
 *   | crash point                        | intent state | safe next step        |
 *   |------------------------------------|--------------|-----------------------|
 *   | after RECORD, before CLAIM         | RECORDED     | dispatch (no effect yet)|
 *   | after CLAIM, before external call  | DISPATCHING  | sweep to UNKNOWN      |
 *   | after external call, before RESOLVE| DISPATCHING  | sweep to UNKNOWN      |
 *   | after RESOLVE                      | terminal     | nothing               |
 *
 * DISPATCHING is deliberately indistinguishable from "call may have landed".
 * We cannot tell those apart from our side, so both sweep to UNKNOWN and must be
 * RECONCILED against the provider. An UNKNOWN intent is never re-dispatched.
 */

/** Terminal intent states. */
const RESOLVED: ExecutionIntentStatus[] = [
  ExecutionIntentStatus.SUCCEEDED,
  ExecutionIntentStatus.FAILED,
];

/**
 * Stable idempotency identity for one external financial operation.
 *
 * Derived purely from the action (and target, where one action fans out over
 * several targets such as per-invoice collection links). It contains no
 * timestamp and no randomness, so a retry of the SAME logical operation
 * produces the SAME key - which is the entire point. Regenerating a random key
 * on retry is how systems double-charge people.
 */
/**
 * Razorpay rejects a `reference_id` longer than 40 characters:
 *   BAD_REQUEST_ERROR: reference_id: the length must be no more than 40.
 *
 * VERIFIED_LIVE. A single-target key is `cp_` + a 25-char cuid = 28 chars and
 * fits, which is why every earlier live test passed. A fan-out key is
 * `cp_` + cuid + `_` + cuid = 54 chars and is ALWAYS rejected - so every
 * per-invoice collection link failed to be created.
 */
export const MAX_PROVIDER_REFERENCE_LENGTH = 40;

export function buildIdempotencyKey(actionId: string, targetId?: string | null): string {
  const plain = targetId ? `cp_${actionId}_${targetId}` : `cp_${actionId}`;
  if (plain.length <= MAX_PROVIDER_REFERENCE_LENGTH) {
    // Short enough to stay human-readable. Unchanged for every key that has
    // ever been accepted by the provider, so no in-flight intent is orphaned.
    return plain;
  }

  // Deterministic digest of the SAME inputs. No timestamp, no randomness: the
  // same (action, target) always yields the same key, which is the entire
  // point of an idempotency identity. 3 + 32 = 35 chars.
  const digest = createHash("sha256")
    .update(`${actionId}:${targetId ?? ""}`)
    .digest("hex")
    .slice(0, 32);
  return `cp_${digest}`;
}

/**
 * Identity of the underlying financial obligation an attempt acts on.
 *
 * Derived from the TARGET RECORD, never from the action. A regenerated strategy
 * produces a brand-new actionId - and therefore a brand-new idempotency key -
 * so an action-scoped guard evaporates exactly when it is needed most. The
 * invoice, payout or recovery row does not change, so it is the correct anchor.
 *
 * Returns null when there is no identifiable target, in which case no
 * cross-action guard is possible and only per-action idempotency applies.
 */
export function buildObligationKey(
  targetType?: string | null,
  targetId?: string | null
): string | null {
  if (!targetType || !targetId) return null;
  return `${targetType}:${targetId}`;
}

/**
 * States in which a prior attempt still CLAIMS the obligation.
 *
 * UNKNOWN is deliberately included. That is the whole point of this phase: an
 * attempt whose provider outcome we cannot determine may already have created a
 * live payment link, so it must keep blocking new executions rather than being
 * treated as available capacity.
 *
 * FAILED is deliberately EXCLUDED - but only a reconciliation-proven FAILED can
 * be reached, because reconciliation is the only path that sets it.
 */
export const OBLIGATION_CLAIMING_STATES: ExecutionIntentStatus[] = [
  ExecutionIntentStatus.RECORDED,
  ExecutionIntentStatus.DISPATCHING,
  ExecutionIntentStatus.UNKNOWN,
  ExecutionIntentStatus.SUCCEEDED,
];

export interface RecordIntentInput {
  businessId: string;
  strategyId: string;
  actionId: string;
  operation: ExecutionOperation;
  amount: number;
  targetType?: string | null;
  targetId?: string | null;
  /** Post-condition captured before the side effect; see ledgerReconciliation. */
  expectedState?: Record<string, unknown>;
}

/** A new attempt was refused because an earlier one still claims the obligation. */
export interface ObligationBlocked {
  blocked: true;
  obligationKey: string;
  blockingIntentId: string;
  blockingStatus: ExecutionIntentStatus;
  reason: string;
}

/**
 * Commits the intent to perform an external operation.
 *
 * Idempotent by construction: the unique idempotencyKey means a duplicate
 * request re-attaches to the existing intent rather than creating a second one.
 * An already-resolved intent is returned as-is so the caller can short-circuit
 * without touching the provider again.
 *
 * `client` may be a transaction client so the intent commits atomically with
 * whatever local state change accompanies it.
 */
export async function recordExecutionIntent(
  client: Prisma.TransactionClient,
  input: RecordIntentInput
): Promise<{ intent: ExecutionIntent; created: boolean; blocked?: ObligationBlocked }> {
  const idempotencyKey = buildIdempotencyKey(input.actionId, input.targetId);

  const existing = await client.executionIntent.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    // Same logical operation: re-attach rather than create a second row.
    return { intent: existing, created: false };
  }

  // ---------------------------------------------------------------------
  // OBLIGATION ADMISSION GUARD
  //
  // A different idempotency key targeting the SAME obligation is a second
  // financial execution. It is refused while any earlier attempt still claims
  // the obligation - including an UNKNOWN one, which may already have created a
  // live provider link we simply cannot see.
  //
  // This is the invariant: a temporary loss of provider knowledge must never
  // license a second execution.
  // ---------------------------------------------------------------------
  const obligationKey = buildObligationKey(input.targetType, input.targetId);
  if (obligationKey) {
    const claiming = await client.executionIntent.findFirst({
      where: {
        businessId: input.businessId,
        obligationKey,
        status: { in: OBLIGATION_CLAIMING_STATES },
      },
      orderBy: { recordedAt: "asc" },
    });

    if (claiming && claiming.idempotencyKey !== idempotencyKey) {
      return {
        intent: claiming,
        created: false,
        blocked: {
          blocked: true,
          obligationKey,
          blockingIntentId: claiming.id,
          blockingStatus: claiming.status,
          reason:
            claiming.status === ExecutionIntentStatus.UNKNOWN
              ? `An earlier attempt on ${obligationKey} has an undetermined provider outcome and may already have created a live payment link. A second execution is refused until that attempt is resolved.`
              : `An earlier attempt on ${obligationKey} is ${claiming.status}. A second execution for the same obligation is refused.`,
        },
      };
    }
  }

  try {
    const intent = await client.executionIntent.create({
      data: {
        businessId: input.businessId,
        strategyId: input.strategyId,
        actionId: input.actionId,
        idempotencyKey,
        operation: input.operation,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        amount: input.amount,
        status: ExecutionIntentStatus.RECORDED,
        // Anchors duplicate protection to the obligation, not the action.
        obligationKey,
        expectedState: (input.expectedState ?? null) as Prisma.InputJsonValue,
      },
    });
    return { intent, created: true };
  } catch {
    // Unique violation: a concurrent request recorded the same intent first.
    const raced = await client.executionIntent.findUnique({ where: { idempotencyKey } });
    if (raced) return { intent: raced, created: false };
    throw new Error("Failed to record execution intent");
  }
}

/**
 * Claims a RECORDED intent for dispatch.
 *
 * Compare-and-set on status so exactly one caller may proceed to the external
 * call. Returns null when the intent is not claimable - already dispatching,
 * already resolved, or UNKNOWN. In particular an UNKNOWN intent is NEVER
 * claimable: reconciliation must resolve it first (PART 4/7).
 */
export async function claimExecutionIntent(
  client: Prisma.TransactionClient,
  intentId: string
): Promise<ExecutionIntent | null> {
  const claimed = await client.executionIntent.updateMany({
    where: { id: intentId, status: ExecutionIntentStatus.RECORDED },
    data: {
      status: ExecutionIntentStatus.DISPATCHING,
      dispatchedAt: new Date(),
      attempts: { increment: 1 },
    },
  });

  if (!claimed || claimed.count === 0) return null;
  logger.info("Execution intent claimed: RECORDED -> DISPATCHING", { intentId });
  return await client.executionIntent.findUnique({ where: { id: intentId } });
}

/** Marks a dispatched intent as having definitely succeeded. */
export async function resolveIntentSucceeded(
  client: Prisma.TransactionClient,
  intentId: string,
  externalRef: string,
  externalStatus?: string
): Promise<ExecutionIntent | null> {
  await client.executionIntent.updateMany({
    where: { id: intentId },
    data: {
      status: ExecutionIntentStatus.SUCCEEDED,
      externalRef,
      externalStatus: externalStatus ?? null,
      resolvedAt: new Date(),
      lastError: null,
      unknownReason: null,
    },
  });
  logger.info("Execution intent resolved: DISPATCHING -> SUCCEEDED", { intentId, externalRef, externalStatus });
  return await client.executionIntent.findUnique({ where: { id: intentId } });
}

/**
 * Marks an intent as having definitely NOT taken effect.
 *
 * Only use this when the provider gave a definite negative - a validation
 * rejection, a 4xx, a business-rule refusal. A timeout is not a failure; it is
 * an unknown, and calling it a failure invites a duplicate payment.
 */
export async function resolveIntentFailed(
  client: Prisma.TransactionClient,
  intentId: string,
  error: string
): Promise<ExecutionIntent | null> {
  await client.executionIntent.updateMany({
    where: { id: intentId },
    data: {
      status: ExecutionIntentStatus.FAILED,
      lastError: error.slice(0, 500),
      resolvedAt: new Date(),
    },
  });
  logger.info("Execution intent resolved: DISPATCHING -> FAILED", { intentId, error });
  return await client.executionIntent.findUnique({ where: { id: intentId } });
}

/**
 * Marks an intent as genuinely ambiguous.
 *
 * NOT terminal, NOT a failure. The operation may or may not have landed at the
 * provider. Only reconciliation (querying the provider by our stable key) may
 * move it onwards.
 */
export async function resolveIntentUnknown(
  client: Prisma.TransactionClient,
  intentId: string,
  reason: string
): Promise<ExecutionIntent | null> {
  await client.executionIntent.updateMany({
    where: { id: intentId },
    data: {
      status: ExecutionIntentStatus.UNKNOWN,
      unknownReason: reason.slice(0, 500),
    },
  });
  logger.info("Execution intent resolved: DISPATCHING -> UNKNOWN", { intentId, reason });
  return await client.executionIntent.findUnique({ where: { id: intentId } });
}

/**
 * Sweeps intents abandoned mid-dispatch by a crashed process.
 *
 * Anything still DISPATCHING after `staleAfterMs` had a process die somewhere
 * between the claim and the result. We cannot know whether the external call
 * landed, so every one of them becomes UNKNOWN - never RECORDED (which would
 * make it re-dispatchable) and never FAILED (which would be a lie).
 *
 * Returns the ids swept, so a caller can report them.
 */
export async function sweepAbandonedIntents(
  client: Prisma.TransactionClient,
  now: Date = new Date(),
  staleAfterMs: number = 2 * 60 * 1000,
  scope: { businessId?: string } = {}
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - staleAfterMs);

  const abandoned = await client.executionIntent.findMany({
    where: {
      ...(scope.businessId ? { businessId: scope.businessId } : {}),
      status: ExecutionIntentStatus.DISPATCHING,
      dispatchedAt: { lte: cutoff },
    },
    select: { id: true },
  });

  if (abandoned.length > 0) {
    logger.info("Sweeping abandoned dispatching intents to UNKNOWN", { sweptCount: abandoned.length, intentIds: abandoned.map(a => a.id) });
  }

  for (const a of abandoned) {
    await resolveIntentUnknown(
      client,
      a.id,
      "Process did not report a result before the dispatch deadline; external effect is indeterminate."
    );
  }

  return abandoned.map((a: { id: string }) => a.id);
}

/** True when the intent has reached a state that needs no further work. */
export function isIntentResolved(status: ExecutionIntentStatus): boolean {
  return RESOLVED.includes(status);
}

/**
 * Whether an intent may legally be dispatched right now.
 *
 * Exhaustive on purpose: a new status must be classified here explicitly rather
 * than falling through to "sure, call the payment provider again".
 */
export function isDispatchable(status: ExecutionIntentStatus): boolean {
  switch (status) {
    case ExecutionIntentStatus.RECORDED:
      return true;
    case ExecutionIntentStatus.DISPATCHING:
    case ExecutionIntentStatus.SUCCEEDED:
    case ExecutionIntentStatus.FAILED:
    case ExecutionIntentStatus.UNKNOWN:
      return false;
    default:
      return false;
  }
}
