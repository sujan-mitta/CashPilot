import {
  ExecutionIntentStatus,
  ExecutionOperation,
  Prisma,
} from "../../../generated/prisma/client";
import {
  recordExecutionIntent,
  claimExecutionIntent,
  resolveIntentSucceeded,
  resolveIntentFailed,
  resolveIntentUnknown,
  buildIdempotencyKey,
} from "./executionIntent";
import {
  ProviderIndeterminateError,
  ProviderRejectedError,
  ProviderDuplicateError,
  reconcilePaymentLink,
  classifyProviderError,
} from "../razorpay/client";
import { ReconciliationResult, providerUnavailable } from "./providerReconciliation";
import {
  reconcileReschedulePayout,
  reconcilePauseExpense,
  PayoutExpectation,
  TransactionExpectation,
} from "./ledgerReconciliation";

export type ExecutionOutcome =
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "ALREADY_SUCCEEDED"
  | "ALREADY_FAILED"
  | "BLOCKED_UNKNOWN"
  /** Refused: another attempt already claims this financial obligation. */
  | "BLOCKED_BY_PRIOR_ATTEMPT";

export interface DispatchResult {
  externalRef: string;
  externalStatus?: string;
}

export interface ExecuteInput {
  businessId: string;
  strategyId: string;
  actionId: string;
  operation: ExecutionOperation;
  amount: number;
  targetType?: string | null;
  targetId?: string | null;
  /**
   * Performs the external side effect. Receives the stable idempotency key that
   * MUST be passed through to the provider. Throws ProviderRejectedError for a
   * definite negative or ProviderIndeterminateError when the result is unknown.
   */
  dispatch: (idempotencyKey: string) => Promise<DispatchResult>;
  /**
   * The post-condition this operation intends to leave behind, captured BEFORE
   * the side effect so reconciliation has something to compare persisted state
   * against (PART 3/4).
   */
  expectedState?: Record<string, unknown>;
  /**
   * Optional hook fired after the intent is committed but before the external
   * call. Tests use it to simulate a process crash at that exact boundary.
   */
  onIntentRecorded?: (intentId: string) => Promise<void> | void;
}

export interface ExecuteResult {
  outcome: ExecutionOutcome;
  intentId: string;
  idempotencyKey: string;
  externalRef?: string | null;
  externalStatus?: string | null;
  error?: string;
  unknownReason?: string;
  /** Set when the outcome is BLOCKED_BY_PRIOR_ATTEMPT. */
  blockingIntentId?: string;
  obligationKey?: string;
}

/**
 * Runs one external financial operation with durable intent.
 *
 * The ordering here is the entire safety property:
 *
 *   commit intent  ->  claim  ->  external call  ->  record result
 *
 * Nothing external happens before the intent is committed, so a crash before
 * the call leaves a recoverable RECORDED row. Nothing is retried after the
 * claim, so a crash during the call leaves a DISPATCHING row that sweeps to
 * UNKNOWN rather than firing a second payment.
 */
export async function executeWithDurableIntent(
  client: Prisma.TransactionClient,
  input: ExecuteInput
): Promise<ExecuteResult> {
  const idempotencyKey = buildIdempotencyKey(input.actionId, input.targetId);

  // 1. INTENT - committed before any side effect.
  const { intent, blocked } = await recordExecutionIntent(client, {
    businessId: input.businessId,
    strategyId: input.strategyId,
    actionId: input.actionId,
    operation: input.operation,
    amount: input.amount,
    targetType: input.targetType,
    targetId: input.targetId,
    expectedState: input.expectedState,
  });

  // Refused by the obligation guard: an earlier attempt still claims this
  // obligation. Nothing is dispatched, and no new intent row was created.
  if (blocked) {
    // A SUCCEEDED claim is not ambiguity - it is positive evidence that this
    // obligation is already discharged, and the intent carries the provider
    // reference that discharged it. Reporting it as merely "blocked" hides a
    // live payment link from the caller, who then sees an empty result and no
    // reason for it. Surface the existing reference instead: the provider is
    // still not contacted, so the no-second-execution invariant is untouched.
    //
    // The reference comes from a DIFFERENT idempotency key (a regenerated
    // strategy mints a new actionId). That is exactly the case the obligation
    // key exists to recognise - the invoice is the same debt either way.
    if (blocked.blockingStatus === ExecutionIntentStatus.SUCCEEDED && intent.externalRef) {
      return {
        outcome: "ALREADY_SUCCEEDED",
        intentId: blocked.blockingIntentId,
        idempotencyKey,
        externalRef: intent.externalRef,
        externalStatus: intent.externalStatus,
        obligationKey: blocked.obligationKey,
        blockingIntentId: blocked.blockingIntentId,
      };
    }

    return {
      outcome: "BLOCKED_BY_PRIOR_ATTEMPT",
      intentId: blocked.blockingIntentId,
      idempotencyKey,
      obligationKey: blocked.obligationKey,
      blockingIntentId: blocked.blockingIntentId,
      unknownReason: blocked.reason,
    };
  }

  // A previously resolved intent short-circuits: the operation already ran.
  if (intent.status === ExecutionIntentStatus.SUCCEEDED) {
    return {
      outcome: "ALREADY_SUCCEEDED",
      intentId: intent.id,
      idempotencyKey,
      externalRef: intent.externalRef,
      externalStatus: intent.externalStatus,
    };
  }
  if (intent.status === ExecutionIntentStatus.FAILED) {
    return {
      outcome: "ALREADY_FAILED",
      intentId: intent.id,
      idempotencyKey,
      error: intent.lastError ?? "Previously failed",
    };
  }
  // PART 4/7: an unknown operation is never re-dispatched. It must be
  // reconciled against the provider first.
  if (intent.status === ExecutionIntentStatus.UNKNOWN) {
    return {
      outcome: "BLOCKED_UNKNOWN",
      intentId: intent.id,
      idempotencyKey,
      unknownReason: intent.unknownReason ?? "Outcome of a previous attempt is unresolved.",
    };
  }

  if (input.onIntentRecorded) {
    await input.onIntentRecorded(intent.id);
  }

  // 2. CLAIM - exactly one caller may proceed past this line.
  const claimed = await claimExecutionIntent(client, intent.id);
  if (!claimed) {
    const current = await client.executionIntent.findUnique({ where: { id: intent.id } });
    if (current?.status === ExecutionIntentStatus.SUCCEEDED) {
      return {
        outcome: "ALREADY_SUCCEEDED",
        intentId: intent.id,
        idempotencyKey,
        externalRef: current.externalRef,
      };
    }
    // Someone else is mid-dispatch, or it swept to UNKNOWN. Either way we must
    // not make a second call.
    return {
      outcome: "BLOCKED_UNKNOWN",
      intentId: intent.id,
      idempotencyKey,
      unknownReason: `Intent is ${current?.status ?? "unavailable"}; a concurrent dispatch owns this operation.`,
    };
  }

  // 3. EXTERNAL CALL.
  try {
    const result = await input.dispatch(idempotencyKey);
    await resolveIntentSucceeded(client, intent.id, result.externalRef, result.externalStatus);
    return {
      outcome: "SUCCEEDED",
      intentId: intent.id,
      idempotencyKey,
      externalRef: result.externalRef,
      externalStatus: result.externalStatus ?? null,
    };
  } catch (rawError: unknown) {
    const classified =
      rawError instanceof ProviderRejectedError ||
      rawError instanceof ProviderIndeterminateError ||
      rawError instanceof ProviderDuplicateError
        ? rawError
        : classifyProviderError(rawError);

    // VERIFIED_LIVE (Phase 17): the provider rejects a duplicate reference_id.
    // That rejection is positive evidence a PREVIOUS attempt with our key
    // already created the operation. Recording FAILED here would mark a live
    // payment link as failed and unlock a retry against money that already
    // moved. It becomes UNKNOWN so reconciliation resolves it from evidence.
    if (classified instanceof ProviderDuplicateError) {
      await resolveIntentUnknown(
        client,
        intent.id,
        `Provider reports this operation already exists (${classified.message}). Reconciliation must confirm its state.`
      );
      return {
        outcome: "UNKNOWN",
        intentId: intent.id,
        idempotencyKey,
        unknownReason: classified.message,
      };
    }

    if (classified instanceof ProviderRejectedError) {
      await resolveIntentFailed(client, intent.id, classified.message);
      return {
        outcome: "FAILED",
        intentId: intent.id,
        idempotencyKey,
        error: classified.message,
      };
    }

    await resolveIntentUnknown(client, intent.id, classified.message);
    return {
      outcome: "UNKNOWN",
      intentId: intent.id,
      idempotencyKey,
      unknownReason: classified.message,
    };
  }
}

export interface IntentReconciliation {
  intentId: string;
  result: ReconciliationResult;
  /** Whether the intent's own status changed as a result. */
  intentStatusAfter: string;
}

/**
 * Deterministically reconciles ONE unresolved intent (PART 5/7).
 *
 * Routes by operation type:
 *   CREATE_PAYMENT_LINK -> the payment provider
 *   RESCHEDULE_PAYOUT   -> the payout row
 *   PAUSE_EXPENSE       -> the transaction row
 *
 * It only ever ASKS QUESTIONS. No branch re-issues the financial mutation, which
 * is what makes it safe to run automatically on every execute request.
 *
 * The intent advances only on positive evidence:
 *   CONFIRMED_SUCCESS -> SUCCEEDED
 *   CONFIRMED_FAILURE / NOT_FOUND -> FAILED, with `retrySafe` set from the
 *     verdict rather than assumed
 *   PENDING / UNKNOWN -> stays UNKNOWN
 */
export async function reconcileUnknownIntent(
  client: Prisma.TransactionClient,
  intentId: string,
  overrides: {
    /** Injectable provider lookup, for tests. */
    lookup?: (
      referenceId: string,
      window: { from: Date; to: Date },
      now?: Date,
      operationRecordedAt?: Date
    ) => Promise<ReconciliationResult>;
    now?: Date;
  } = {}
): Promise<IntentReconciliation> {
  const now = overrides.now ?? new Date();
  const intent = await client.executionIntent.findUnique({ where: { id: intentId } });

  if (!intent) {
    return {
      intentId,
      intentStatusAfter: "MISSING",
      result: providerUnavailable(intentId, "Execution intent not found.", now),
    };
  }

  if (
    intent.status !== ExecutionIntentStatus.UNKNOWN &&
    intent.status !== ExecutionIntentStatus.DISPATCHING
  ) {
    return {
      intentId,
      intentStatusAfter: intent.status,
      result: {
        status: "UNKNOWN",
        reason: `Intent is ${intent.status}; there is nothing to reconcile.`,
        expectedEvidence: "An unresolved operation.",
        observedEvidence: `Intent already resolved as ${intent.status}.`,
        searchExhaustive: true,
        retrySafe: false,
        checkedAt: now.toISOString(),
      },
    };
  }

  const expected = (intent.expectedState ?? {}) as Record<string, unknown>;
  let result: ReconciliationResult;
  let observedState: unknown = null;

  if (intent.operation === ExecutionOperation.CREATE_PAYMENT_LINK) {
    // Bound the search to the intent's own lifetime. `from`/`to` are the only
    // filters the provider actually supports.
    const window = {
      from: new Date(intent.recordedAt),
      to: new Date(Math.max(now.getTime(), new Date(intent.recordedAt).getTime())),
    };
    const lookup = overrides.lookup ?? reconcilePaymentLink;
    try {
      result = await lookup(intent.idempotencyKey, window, now, new Date(intent.recordedAt));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result = providerUnavailable(
        intent.idempotencyKey,
        `Provider lookup threw: ${errMsg}`,
        now
      );
    }
    observedState = { providerReference: result.providerReference ?? null, providerStatus: result.providerStatus ?? null };
  } else if (intent.operation === ExecutionOperation.RESCHEDULE_PAYOUT) {
    const record = intent.targetId && client.payout?.findFirst
      ? await client.payout.findFirst({ where: { id: intent.targetId } })
      : null;
    observedState = record ? { scheduledDate: record.scheduledDate, status: record.status } : null;
    result = reconcileReschedulePayout(
      {
        targetId: intent.targetId ?? "unknown",
        originalDueDate: expected.originalDueDate ?? "unknown",
        expectedDueDate: expected.expectedDueDate ?? "unknown",
        expectedStatus: expected.expectedStatus ?? "RESCHEDULED",
      } as PayoutExpectation,
      record,
      now
    );
  } else if (intent.operation === ExecutionOperation.PAUSE_EXPENSE) {
    const record = intent.targetId && client.transaction?.findFirst
      ? await client.transaction.findFirst({ where: { id: intent.targetId } })
      : null;
    observedState = record ? { status: record.status } : null;
    result = reconcilePauseExpense(
      {
        targetId: intent.targetId ?? "unknown",
        originalStatus: expected.originalStatus ?? "unknown",
        expectedStatus: expected.expectedStatus ?? "FAILED",
      } as TransactionExpectation,
      record,
      now
    );
  } else {
    result = providerUnavailable(
      intent.idempotencyKey,
      `No reconciler is defined for operation ${intent.operation}.`,
      now
    );
  }

  // Persist the evidence regardless of verdict, so an operator can see what was
  // checked and when (PART 6/9).
  const evidence = {
    observedState: observedState as Prisma.InputJsonValue,
    reconciliationResult: result as unknown as Prisma.InputJsonValue,
    lastReconciledAt: now,
    retrySafe: result.retrySafe,
  };

  let statusAfter: string = intent.status;

  if (result.status === "CONFIRMED_SUCCESS") {
    await client.executionIntent.updateMany({
      where: { id: intent.id },
      data: {
        ...evidence,
        status: ExecutionIntentStatus.SUCCEEDED,
        externalRef: result.providerReference ?? intent.externalRef,
        externalStatus: result.providerStatus ?? null,
        resolvedAt: now,
        unknownReason: null,
      },
    });
    statusAfter = ExecutionIntentStatus.SUCCEEDED;

    if (intent.operation === ExecutionOperation.CREATE_PAYMENT_LINK && result.providerReference) {
      try {
        const { settlePayment } = await import("../razorpay/settlement");
        await settlePayment(result.providerReference, intent.businessId, intent.amount, intent.idempotencyKey, "RECONCILIATION");
      } catch (settleErr) {
        console.error("Failed to execute settlePayment during reconciliation:", settleErr);
      }
    }
  } else if (result.status === "CONFIRMED_FAILURE" || result.status === "NOT_FOUND") {
    await client.executionIntent.updateMany({
      where: { id: intent.id },
      data: {
        ...evidence,
        status: ExecutionIntentStatus.FAILED,
        lastError: result.reason.slice(0, 500),
        resolvedAt: now,
      },
    });
    statusAfter = ExecutionIntentStatus.FAILED;
  } else {
    // PENDING or UNKNOWN. Stays unresolved; retry remains blocked.
    await client.executionIntent.updateMany({
      where: { id: intent.id },
      data: {
        ...evidence,
        status: ExecutionIntentStatus.UNKNOWN,
        unknownReason: result.reason.slice(0, 500),
      },
    });
    statusAfter = ExecutionIntentStatus.UNKNOWN;
  }

  return { intentId: intent.id, result, intentStatusAfter: statusAfter };
}

/**
 * Whether an operator may re-run this operation.
 *
 * The ONLY path to true is a reconciliation that positively established the
 * original effect did not occur. Never inferred from a status alone, and never
 * decided by the client (INVARIANT 5).
 */
export interface IntentLikeForRetry {
  status: string;
  retrySafe?: boolean | null;
  reconciliationResult?: Prisma.JsonValue;
}

export function isRetryPermitted(intent: IntentLikeForRetry): boolean {
  if (intent.status !== ExecutionIntentStatus.FAILED) return false;
  if (intent.retrySafe !== true) return false;
  const result = intent.reconciliationResult as Record<string, unknown> | null | undefined;
  const verdict = result?.status;
  return verdict === "CONFIRMED_FAILURE" || verdict === "NOT_FOUND";
}
