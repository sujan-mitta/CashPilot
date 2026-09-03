/**
 * What each action can actually be performed on.
 *
 * WHY THIS EXISTS IN ONE PLACE
 *
 * The planner chose targets with in-memory filters and the executor re-derived
 * them with database queries, and the two drifted. Three separate bugs of the
 * same shape, all found in live data:
 *
 *   · The planner proposed recovering a debt already RECOVERED, and execution
 *     refused with "No candidate failed payment found to recover" — on money
 *     the operator had just successfully collected.
 *
 *   · It proposed rescheduling a payout already RESCHEDULED. Beyond failing,
 *     that double-counts: the benefit of moving that money was banked when it
 *     was moved the first time, so the simulated improvement is money the
 *     business does not gain twice.
 *
 *   · It proposed pausing a FAILED expense while the executor requires a
 *     PENDING one. A failed outflow is not a subscription that can be paused;
 *     it is a payment that already did not happen.
 *
 * Every one produced the same experience: a plan presented as approved whose
 * action could never run, with the operator told only after pressing the button.
 *
 * The rules live here so both sides state the same thing. Where the executor
 * queries a database it uses these same constants, so a change here cannot
 * silently leave one side behind.
 */

/**
 * A payout can be moved only while it is still scheduled to happen.
 *
 * Rescheduling one already rescheduled would move it again, claiming a benefit
 * that was realised the first time.
 */
export const RESCHEDULABLE_PAYOUT_STATUSES = ["SCHEDULED"] as const;

/**
 * An expense can be paused only while it is still going to be paid.
 *
 * A FAILED outflow never left the account, and a COMPLETED one already has.
 * Neither is a saving available to make.
 */
export const PAUSABLE_TRANSACTION_STATUSES = ["PENDING"] as const;

/**
 * Recovery states meaning the debt is settled or already being chased.
 *
 * RECOVERY_FAILED is deliberately absent: a failed attempt is exactly the case
 * worth retrying, and excluding it would be as wrong as offering a settled one.
 */
export const HANDLED_RECOVERY_STATUSES = [
  "RECOVERED",
  "PAYMENT_PENDING",
  "RECOVERY_INITIATED",
] as const;

export interface PayoutLike {
  vendor: string | null;
  status: string;
}

export interface TransactionLike {
  type: string;
  status: string;
  description: string | null;
}

/** Whether this payout is one the executor would actually be able to move. */
export function isReschedulablePayout(payout: PayoutLike): boolean {
  return (RESCHEDULABLE_PAYOUT_STATUSES as readonly string[]).includes(payout.status);
}

/**
 * Whether this transaction is an expense the executor could actually pause.
 *
 * The type check matters as much as the status one. The planner previously
 * matched on description alone, so an INFLOW described as a "recurring payment"
 * would have been offered as a saving — money coming IN, proposed as an expense
 * to stop.
 */
export function isPausableExpense(tx: TransactionLike): boolean {
  if (tx.type !== "OUTFLOW") return false;
  if (!(PAUSABLE_TRANSACTION_STATUSES as readonly string[]).includes(tx.status)) return false;
  const d = tx.description?.toLowerCase() ?? "";
  return d.includes("saas") || d.includes("recurring");
}
