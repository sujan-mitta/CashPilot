import {
  isPausableExpense,
  isReschedulablePayout,
  COLLECTIBLE_INVOICE_STATUSES,
} from "./actionEligibility";
import { totalOutstanding } from "./invoiceOutstanding";

/**
 * What each action would act on, and what it is worth.
 *
 * WHY THIS IS ONE FUNCTION
 *
 * There were two copies. `/api/strategies` selected candidates carefully —
 * skipping debts already recovered, payouts already rescheduled, expenses that
 * are not pausable, and valuing invoices at what is still owed. The settlement
 * email's health assessment built its own library beside it, and every one of
 * those rules was missing:
 *
 *   · `transactions.filter(t => t.status === "FAILED")` with no check on
 *     whether the debt had already been recovered — so an operator could be
 *     emailed a recommendation to go and collect money that had just landed,
 *     which is the very event that sent the email.
 *   · `payouts.find(p => p.vendor === "Packaging Co") || payouts[0]` — ANY
 *     payout, in ANY status, including one already RESCHEDULED. Rescheduling
 *     that again double counts: the benefit was banked the first time.
 *   · `description.includes("SaaS")` with no status check, so a FAILED outflow
 *     that never left the account was offered as a saving.
 *   · Invoices summed at face value rather than outstanding, overstating the
 *     inflow by whatever customers had already paid.
 *
 * So the email could recommend a plan the app would not offer, built on
 * candidates the app had deliberately rejected — reintroducing the exact three
 * bugs actionEligibility exists to prevent, in a place nobody was looking.
 *
 * One definition, both callers.
 */

export interface LibraryInputs {
  transactions: Array<{
    id: string;
    type: string;
    status: string;
    amount: number;
    description: string | null;
  }>;
  invoices: Array<{ status: string; amount: number; paidAmount?: number }>;
  payouts: Array<{ id: string; vendor: string | null; amount: number; status: string }>;
  /**
   * Transaction ids whose debt is settled or already being chased.
   *
   * Passed in rather than queried here so this stays a pure function: the
   * callers already hold a database client and differ in how much they are
   * willing to fail when that read does not work.
   */
  handledTransactionIds?: ReadonlySet<string>;
}

export interface ActionLibrary {
  recoverFailedPayments: number;
  prioritizeCollections: number;
  reschedulePayout: number;
  pauseExpense: number;
  recoverFailedPaymentsId: string;
  reschedulePayoutId: string;
  rescheduleTransactionId: string;
  pauseExpenseId: string;
}

export interface LibrarySelection {
  library: ActionLibrary;
  /**
   * Recoverable debts beyond the one the plan addresses.
   *
   * The executor recovers ONE debt per action, so any others are real money
   * this recommendation does not cover and the operator is entitled to know.
   */
  unaddressedFailures: Array<{ id: string; amount: number; description: string | null }>;
}

/**
 * The vendor whose payout the reschedule action targets.
 *
 * Hardcoded, and named here rather than buried in a route so it is visible for
 * what it is: a demo-shaped assumption. A ledger can hold several reschedulable
 * payouts — this one picks by name and cannot see the others.
 */
const RESCHEDULE_VENDOR = "Packaging Co";

export function buildActionLibrary(inputs: LibraryInputs): LibrarySelection {
  const { transactions, invoices, payouts, handledTransactionIds } = inputs;
  const handled = handledTransactionIds ?? new Set<string>();

  // Largest first, deterministic on ties, so the same ledger always yields the
  // same plan.
  const recoverableFailures = transactions
    .filter((t) => t.status === "FAILED" && t.type === "INFLOW" && !handled.has(t.id))
    .sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id));

  const failedTx = recoverableFailures[0];

  // What is STILL OUTSTANDING, not face value: a customer who has paid Rs 6L of
  // a Rs 10L invoice will only ever deliver the remaining Rs 4L.
  const prioritizeCollections = totalOutstanding(
    invoices.filter((i) =>
      (COLLECTIBLE_INVOICE_STATUSES as readonly string[]).includes(i.status)
    )
  );

  // Only a payout the executor could actually move.
  const payout = payouts.find(
    (p) => p.vendor === RESCHEDULE_VENDOR && isReschedulablePayout(p)
  );

  // The forecast is built from transactions, so moving the payout without
  // moving its transaction would change nothing the projection can see.
  const payoutTx = payout
    ? transactions.find(
        (t) =>
          t.type === "OUTFLOW" &&
          t.amount === payout.amount &&
          (t.description?.includes("Packaging") ?? false)
      )
    : undefined;

  const pauseTx = transactions.find(isPausableExpense);

  return {
    library: {
      recoverFailedPayments: failedTx?.amount ?? 0,
      prioritizeCollections,
      reschedulePayout: payout?.amount ?? 0,
      pauseExpense: pauseTx?.amount ?? 0,
      recoverFailedPaymentsId: failedTx?.id ?? "",
      reschedulePayoutId: payout?.id ?? "",
      rescheduleTransactionId: payoutTx?.id ?? "",
      pauseExpenseId: pauseTx?.id ?? "",
    },
    unaddressedFailures: recoverableFailures.slice(1).map((t) => ({
      id: t.id,
      amount: t.amount,
      description: t.description,
    })),
  };
}
