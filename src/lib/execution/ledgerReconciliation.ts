import { ReconciliationResult } from "./providerReconciliation";

/**
 * ===========================================================================
 * LEDGER RECONCILIATION  (Phase 16 PART 3-4)
 * ===========================================================================
 *
 * `RESCHEDULE_PAYOUT` and `PAUSE_EXPENSE` touch no external provider - they are
 * local ledger writes. Phase 15 therefore returned NOT_APPLICABLE for them, which
 * left an UNKNOWN reschedule stuck forever with no way out.
 *
 * They are reconcilable, just against a different source of truth: the row
 * itself. The rule is the same as for the provider though - evidence must come
 * from PERSISTED STATE, never from the fact that a function returned without
 * throwing. A dispatch can return successfully and still have been rolled back;
 * a dispatch can time out after the write committed.
 *
 * Every intent records the post-condition it intends to leave behind BEFORE the
 * write happens (`ExecutionIntent.expectedState`). Reconciliation reads the row
 * back and compares.
 */

export type LedgerVerdict =
  /** The row carries exactly the post-condition we intended. */
  | "RESCHEDULE_CONFIRMED"
  /** The row is untouched: the write never landed. Retry is safe. */
  | "RESCHEDULE_NOT_APPLIED"
  /** The row moved, but not to where we intended. Someone else changed it. */
  | "TARGET_ALREADY_CHANGED"
  /** The obligation was settled; rescheduling it is moot and unsafe to retry. */
  | "TARGET_ALREADY_SETTLED"
  /** The row is gone. We cannot tell whether we did that. */
  | "TARGET_MISSING"
  | "PAUSE_CONFIRMED"
  | "PAUSE_NOT_APPLIED"
  | "UNKNOWN";

export interface PayoutExpectation {
  targetId: string;
  originalDueDate: string; // YYYY-MM-DD
  expectedDueDate: string; // YYYY-MM-DD
  expectedStatus: string; // "RESCHEDULED"
}

export interface TransactionExpectation {
  targetId: string;
  originalStatus: string;
  expectedStatus: string; // "FAILED" - our representation of a paused outflow
}

export interface PayoutRecord {
  id: string;
  scheduledDate: Date | string;
  status: string;
}

export interface TransactionRecord {
  id: string;
  status: string;
}

function dateOnly(v: Date | string): string {
  const d = typeof v === "string" ? new Date(v) : v;
  if (!Number.isFinite(d.getTime())) return "unknown";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function result(
  status: ReconciliationResult["status"],
  verdict: LedgerVerdict,
  parts: {
    reason: string;
    expected: string;
    observed: string;
    retrySafe: boolean;
    providerReference?: string;
  },
  now: Date
): ReconciliationResult & { verdict: LedgerVerdict } {
  return {
    status,
    verdict,
    reason: parts.reason,
    expectedEvidence: parts.expected,
    observedEvidence: parts.observed,
    retrySafe: parts.retrySafe,
    searchExhaustive: true, // a local row read is always exhaustive
    checkedAt: now.toISOString(),
    ...(parts.providerReference ? { providerReference: parts.providerReference } : {}),
  };
}

/**
 * Reconciles a RESCHEDULE_PAYOUT against the payout row.
 *
 * Cases, and why each maps as it does:
 *
 *  - date and status match the expectation  -> CONFIRMED_SUCCESS. The write landed.
 *  - row is exactly as it was before        -> CONFIRMED_FAILURE, retry safe. The
 *                                              write demonstrably did not land.
 *  - row already PAID                       -> CONFIRMED_FAILURE, NOT retry safe.
 *                                              The money is gone; rescheduling it
 *                                              now would be meaningless and a
 *                                              retry could disturb a settled record.
 *  - row moved somewhere else               -> UNKNOWN. Someone or something else
 *                                              changed it and we cannot attribute
 *                                              the change to us.
 *  - row missing                            -> UNKNOWN. Absence is not evidence
 *                                              that our write failed.
 */
export function reconcileReschedulePayout(
  expectation: PayoutExpectation,
  record: PayoutRecord | null,
  now: Date = new Date()
): ReconciliationResult & { verdict: LedgerVerdict } {
  const expected = `Payout ${expectation.targetId} at status "${expectation.expectedStatus}" with due date ${expectation.expectedDueDate}.`;

  if (!record) {
    return result(
      "UNKNOWN",
      "TARGET_MISSING",
      {
        reason:
          "The target payout no longer exists. Its disappearance cannot be attributed to this operation, so the outcome is undetermined.",
        expected,
        observed: "No payout row found for this id.",
        retrySafe: false,
      },
      now
    );
  }

  const observedDue = dateOnly(record.scheduledDate);
  const observed = `Payout ${record.id} at status "${record.status}" with due date ${observedDue}.`;

  if (record.status === "PAID") {
    return result(
      "CONFIRMED_FAILURE",
      "TARGET_ALREADY_SETTLED",
      {
        reason:
          "The payout has already been paid. The reschedule is moot, and retrying it would act on a settled obligation.",
        expected,
        observed,
        retrySafe: false,
      },
      now
    );
  }

  if (record.status === expectation.expectedStatus && observedDue === expectation.expectedDueDate) {
    return result(
      "CONFIRMED_SUCCESS",
      "RESCHEDULE_CONFIRMED",
      {
        reason: "The payout carries exactly the status and due date this operation intended.",
        expected,
        observed,
        retrySafe: false,
        providerReference: `payout:${record.id}`,
      },
      now
    );
  }

  // Untouched: still the original date AND not yet rescheduled.
  if (observedDue === expectation.originalDueDate && record.status !== expectation.expectedStatus) {
    return result(
      "CONFIRMED_FAILURE",
      "RESCHEDULE_NOT_APPLIED",
      {
        reason:
          "The payout is exactly as it was before the operation, so the write demonstrably did not land. A retry is safe.",
        expected,
        observed,
        retrySafe: true,
      },
      now
    );
  }

  return result(
    "UNKNOWN",
    "TARGET_ALREADY_CHANGED",
    {
      reason:
        "The payout has changed, but not into the state this operation intended. The change cannot be attributed to us.",
      expected,
      observed,
      retrySafe: false,
    },
    now
  );
}

/**
 * Reconciles a PAUSE_EXPENSE against the transaction row.
 *
 * A paused outflow is represented as `status = FAILED` (it will not be paid).
 * The expectation records the status the row held beforehand, so "unchanged"
 * is distinguishable from "changed by someone else".
 */
export function reconcilePauseExpense(
  expectation: TransactionExpectation,
  record: TransactionRecord | null,
  now: Date = new Date()
): ReconciliationResult & { verdict: LedgerVerdict } {
  const expected = `Transaction ${expectation.targetId} at status "${expectation.expectedStatus}".`;

  if (!record) {
    return result(
      "UNKNOWN",
      "TARGET_MISSING",
      {
        reason:
          "The target transaction no longer exists. Its disappearance cannot be attributed to this operation.",
        expected,
        observed: "No transaction row found for this id.",
        retrySafe: false,
      },
      now
    );
  }

  const observed = `Transaction ${record.id} at status "${record.status}".`;

  if (record.status === expectation.expectedStatus) {
    return result(
      "CONFIRMED_SUCCESS",
      "PAUSE_CONFIRMED",
      {
        reason: "The transaction carries exactly the status this operation intended.",
        expected,
        observed,
        retrySafe: false,
        providerReference: `transaction:${record.id}`,
      },
      now
    );
  }

  if (record.status === expectation.originalStatus) {
    return result(
      "CONFIRMED_FAILURE",
      "PAUSE_NOT_APPLIED",
      {
        reason:
          "The transaction still holds its pre-operation status, so the pause demonstrably did not land. A retry is safe.",
        expected,
        observed,
        retrySafe: true,
      },
      now
    );
  }

  if (record.status === "SUCCESS") {
    return result(
      "CONFIRMED_FAILURE",
      "TARGET_ALREADY_SETTLED",
      {
        reason:
          "The expense has already been paid. Pausing it is no longer possible and a retry would act on a settled record.",
        expected,
        observed,
        retrySafe: false,
      },
      now
    );
  }

  return result(
    "UNKNOWN",
    "TARGET_ALREADY_CHANGED",
    {
      reason:
        "The transaction has changed, but not into the state this operation intended. The change cannot be attributed to us.",
      expected,
      observed,
      retrySafe: false,
    },
    now
  );
}
