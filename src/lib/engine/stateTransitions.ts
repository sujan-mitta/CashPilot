import { ActionStatus, RecoveryStatus } from "../../../generated/prisma/client";

const ALLOWED_TRANSITIONS: Record<ActionStatus, ActionStatus[]> = {
  [ActionStatus.PENDING]: [ActionStatus.APPROVED, ActionStatus.REJECTED, ActionStatus.STALE],
  [ActionStatus.APPROVED]: [ActionStatus.EXECUTION_REQUESTED, ActionStatus.EXECUTING, ActionStatus.STALE],
  [ActionStatus.EXECUTION_REQUESTED]: [ActionStatus.EXECUTING, ActionStatus.EXECUTION_UNKNOWN, ActionStatus.FAILED],
  [ActionStatus.EXECUTING]: [ActionStatus.EXECUTED, ActionStatus.COMPLETED, ActionStatus.EXECUTION_UNKNOWN, ActionStatus.FAILED, ActionStatus.RECONCILING],
  [ActionStatus.EXECUTED]: [ActionStatus.RECONCILING],
  [ActionStatus.RECONCILING]: [ActionStatus.COMPLETED, ActionStatus.RECONCILIATION_FAILED, ActionStatus.RECONCILIATION_MISMATCH],
  [ActionStatus.FAILED]: [ActionStatus.EXECUTING],
  // PART 4: EXECUTION_UNKNOWN must NEVER walk back to EXECUTING. The external
  // operation may already have landed, so re-dispatching it risks a duplicate
  // payment. Reconciliation resolves it to COMPLETED (it did happen) or FAILED
  // (it definitively did not); only from FAILED may a retry re-enter EXECUTING.
  [ActionStatus.EXECUTION_UNKNOWN]: [ActionStatus.FAILED, ActionStatus.COMPLETED, ActionStatus.RECONCILING],
  [ActionStatus.RECONCILIATION_MISMATCH]: [ActionStatus.RECONCILING],
  [ActionStatus.COMPLETED]: [],
  [ActionStatus.STALE]: [],
  [ActionStatus.REJECTED]: [],
  [ActionStatus.RECONCILIATION_FAILED]: [ActionStatus.RECONCILING],
};

// We define status order to prevent backward transitions:
const STATUS_ORDER: Record<ActionStatus, number> = {
  [ActionStatus.PENDING]: 1,
  [ActionStatus.APPROVED]: 2,
  [ActionStatus.EXECUTION_REQUESTED]: 3,
  [ActionStatus.EXECUTING]: 4,
  [ActionStatus.EXECUTION_UNKNOWN]: 5,
  [ActionStatus.EXECUTED]: 6,
  [ActionStatus.RECONCILING]: 7,
  [ActionStatus.COMPLETED]: 8,
  [ActionStatus.FAILED]: 8,
  [ActionStatus.RECONCILIATION_MISMATCH]: 8,
  [ActionStatus.RECONCILIATION_FAILED]: 8,
  [ActionStatus.REJECTED]: 8,
  [ActionStatus.STALE]: 8,
};

/**
 * Validates state transitions for AgentAction status.
 */
export function validateActionTransition(
  current: ActionStatus,
  next: ActionStatus
): boolean {
  if (current === next) return true;

  // Enforce status order to prevent backward transitions:
  // A terminal state (COMPLETED, FAILED, STALE, REJECTED) or advanced state must never move backward.
  // Exception is for retry: FAILED -> EXECUTING, or mismatch retries.
  if (STATUS_ORDER[next] < STATUS_ORDER[current]) {
    // Check if it's a valid retry transition
    const allowed = ALLOWED_TRANSITIONS[current] || [];
    return allowed.includes(next);
  }

  const allowed = ALLOWED_TRANSITIONS[current] || [];
  return allowed.includes(next);
}

/**
 * Validates state transitions for PaymentRecovery status.
 */
export function validateRecoveryTransition(
  current: RecoveryStatus,
  next: RecoveryStatus
): boolean {
  if (current === next) return true;

  if (next === RecoveryStatus.FAILED && current !== RecoveryStatus.RECOVERED) {
    return true;
  }

  switch (current) {
    case RecoveryStatus.RECOVERY_CANDIDATE:
      return next === RecoveryStatus.RECOVERY_INITIATED || next === RecoveryStatus.RECOVERED;
    case RecoveryStatus.RECOVERY_INITIATED:
      return (
        next === RecoveryStatus.PAYMENT_LINK_CREATED ||
        next === RecoveryStatus.PAYMENT_PENDING ||
        next === RecoveryStatus.RECOVERED
      );
    case RecoveryStatus.PAYMENT_LINK_CREATED:
      return next === RecoveryStatus.PAYMENT_PENDING || next === RecoveryStatus.RECOVERED;
    case RecoveryStatus.PAYMENT_PENDING:
      return (
        next === RecoveryStatus.RECOVERED ||
        next === RecoveryStatus.EXPIRED ||
        next === RecoveryStatus.FAILED
      );
    case RecoveryStatus.RECOVERED:
      return false;
    case RecoveryStatus.EXPIRED:
    case RecoveryStatus.FAILED:
      return next === RecoveryStatus.RECOVERY_INITIATED;
    default:
      return false;
  }
}
