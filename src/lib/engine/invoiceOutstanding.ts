import type { InvoiceStatus } from "../../../generated/prisma/client";

/**
 * What an invoice is still expected to deliver.
 *
 * A part payment used to collapse into PENDING, so the forecast treated the
 * FULL amount as still outstanding. That is wrong in a way that is easy to
 * mistake for caution: it overstates expected inflow for an invoice that will
 * only ever deliver the remainder, and it hides from the operator that the
 * customer has already paid something.
 *
 * Outstanding is `amount - paidAmount`, clamped at zero. Everything here is a
 * pure function of a row so the rule is stated once and can be exercised
 * exhaustively.
 */

/** The invoice fields this module reads. */
export interface InvoiceAmounts {
  amount: number;
  /** Confirmed received, in paise. Absent on rows written before the column. */
  paidAmount?: number | null;
  status?: InvoiceStatus | string | null;
}

/**
 * Confirmed received, normalised.
 *
 * Negative is treated as zero. A negative confirmed receipt is not a refund
 * modelled here — it is corrupt data, and letting it through would INFLATE
 * outstanding above the invoice value and overstate expected inflow.
 */
export function confirmedPaid(invoice: InvoiceAmounts): number {
  const paid = invoice.paidAmount ?? 0;
  if (!Number.isFinite(paid) || paid <= 0) return 0;
  return paid;
}

/**
 * What is still expected from this invoice.
 *
 * Clamped at zero so an overpayment never becomes negative expected inflow —
 * which would silently subtract from the forecast elsewhere in the horizon. The
 * overpayment itself is real and is credited to the ledger at settlement; it is
 * simply not something this invoice will deliver again.
 */
export function outstandingAmount(invoice: InvoiceAmounts): number {
  if (!Number.isFinite(invoice.amount) || invoice.amount <= 0) return 0;
  return Math.max(0, invoice.amount - confirmedPaid(invoice));
}

/** True once nothing further is expected. */
export function isFullySettled(invoice: InvoiceAmounts): boolean {
  return outstandingAmount(invoice) === 0;
}

/**
 * The status an invoice should hold after a settlement is applied.
 *
 * Derived from the money, not from the caller's intent: a settlement that does
 * not close the balance leaves the invoice PARTIALLY_PAID, and only a
 * settlement that reaches or exceeds the full amount marks it PAID. An
 * overpayment is still PAID — the invoice is satisfied.
 */
export function statusAfterPayment(
  invoice: InvoiceAmounts,
  additionalPayment: number
): "PAID" | "PARTIALLY_PAID" {
  const settled = confirmedPaid(invoice) + Math.max(0, additionalPayment);
  return settled >= invoice.amount ? "PAID" : "PARTIALLY_PAID";
}

/**
 * Total still expected across a set of invoices.
 *
 * `PAID` rows contribute nothing regardless of their arithmetic, so a legacy row
 * marked PAID without a recorded `paidAmount` is not resurrected as outstanding
 * by this function. That case is real: `paidAmount` was added later and is not
 * backfilled.
 */
export function totalOutstanding(invoices: InvoiceAmounts[]): number {
  return invoices.reduce(
    (sum, inv) => (inv.status === "PAID" ? sum : sum + outstandingAmount(inv)),
    0
  );
}
