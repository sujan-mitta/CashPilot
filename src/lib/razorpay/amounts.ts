import { isUsableAmount } from "../engine/financialConfig";

/**
 * ===========================================================================
 * PROVIDER-REPORTED AMOUNTS
 * ===========================================================================
 *
 * An amount that arrives in a webhook payload is an ASSERTION by an external
 * party, not a fact about our ledger. Two defects came from treating it as a
 * fact:
 *
 *   1. `amount_paid || amount` - a partial payment reporting `amount_paid: 0`
 *      is falsy, so it fell back to the FULL expected amount and the ledger was
 *      credited for money that never arrived.
 *
 *   2. The resulting figure went straight into `currentCash: { increment }`
 *      with no validation, so a negative, NaN, non-integer or absurdly large
 *      value would have been applied to a real balance.
 *
 * Everything here is pure and total: it never throws and never returns a value
 * that is unsafe to add to a balance.
 */

/** Upper bound on a single settlement, in paise. ₹100 crore. */
export const MAX_SINGLE_SETTLEMENT_PAISE = 1_000_000_000_000;

export type SettledAmountRejection =
  | "MISSING"
  | "NOT_A_NUMBER"
  | "NEGATIVE"
  | "NOT_AN_INTEGER"
  | "IMPLAUSIBLY_LARGE";

export type SettledAmount =
  | { ok: true; amount: number }
  | { ok: false; reason: SettledAmountRejection; observed: unknown };

/**
 * Reads the amount a provider says was actually paid.
 *
 * `amount_paid` is authoritative when present - INCLUDING when it is zero,
 * which means "this link exists and nothing has been paid against it". Only a
 * genuinely absent `amount_paid` falls back to the link's face `amount`.
 */
export function readProviderPaidAmount(entity: {
  amount?: unknown;
  amount_paid?: unknown;
} | null | undefined): SettledAmount {
  const raw = entity?.amount_paid ?? entity?.amount;
  return validateSettlementAmount(raw);
}

/**
 * Validates a figure before it may be added to a balance.
 *
 * Zero is VALID and meaningful: it is how a partially-settled or unsettled link
 * reports itself, and the caller must be able to see that rather than have it
 * silently replaced by an expectation.
 */
export function validateSettlementAmount(raw: unknown): SettledAmount {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: "MISSING", observed: raw };
  }
  if (typeof raw !== "number" || !isUsableAmount(raw)) {
    return { ok: false, reason: "NOT_A_NUMBER", observed: raw };
  }
  if (!Number.isInteger(raw)) {
    // Money is stored in paise as an integer. A fractional paise is corrupt
    // data, not a rounding opportunity.
    return { ok: false, reason: "NOT_AN_INTEGER", observed: raw };
  }
  if (raw < 0) {
    // A settlement never removes money. A refund is a different event with a
    // different handler; silently decrementing here would be indistinguishable
    // from a malicious payload.
    return { ok: false, reason: "NEGATIVE", observed: raw };
  }
  if (raw > MAX_SINGLE_SETTLEMENT_PAISE) {
    return { ok: false, reason: "IMPLAUSIBLY_LARGE", observed: raw };
  }
  return { ok: true, amount: raw };
}

/** Human-readable reason, safe to log. Never echoes the raw observed value. */
export function describeRejection(reason: SettledAmountRejection): string {
  switch (reason) {
    case "MISSING":
      return "The provider reported no amount for this settlement.";
    case "NOT_A_NUMBER":
      return "The provider reported an amount that is not a usable number.";
    case "NOT_AN_INTEGER":
      return "The provider reported a fractional paise amount.";
    case "NEGATIVE":
      return "The provider reported a negative amount; a settlement never removes money.";
    case "IMPLAUSIBLY_LARGE":
      return "The provider reported an amount beyond the maximum single settlement.";
  }
}
