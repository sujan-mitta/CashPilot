import { ClaimType } from "../../../generated/prisma/client";

/**
 * Phase 5 - claim-specific source precedence (spec §16).
 *
 * The spec is emphatic that there is NO universal hierarchy. "BANK > ERP >
 * EMAIL > MODEL" is wrong, and wrong in a way that quietly damages the product:
 * the bank is the last word on whether money arrived and knows *nothing* about
 * whether an invoice exists or what a customer promised on the phone. A single
 * ranking forces one of those judgements to be wrong.
 *
 * So authority is indexed by the QUESTION being asked, not by the source alone.
 * The same source appears with very different weight under different questions,
 * and that is the point - see the tests, which assert the ordering actually
 * inverts between MONEY_ARRIVED and OBLIGATION_EXISTS.
 */

/**
 * The distinct financial questions evidence can answer. Each has its own
 * authority profile because each is knowable by different sources.
 */
export type FinancialQuestion =
  /** "Did the money actually move?" */
  | "MONEY_ARRIVED"
  /** "Does this invoice/bill exist, and on what contractual terms?" */
  | "OBLIGATION_EXISTS"
  /** "What did the counterparty actually tell us?" */
  | "COUNTERPARTY_STATED"
  /** "When is this realistically going to happen?" */
  | "LIKELY_TIMING";

/**
 * Authority in [0,1]: how much this source's word counts FOR THIS QUESTION.
 *
 * These are not probabilities and not tuned constants; they are an ordering
 * with deliberate gaps, and only the ordering is relied upon. Anything absent
 * falls to UNKNOWN_SOURCE_AUTHORITY rather than being assumed credible.
 */
const AUTHORITY: Record<FinancialQuestion, Record<string, number>> = {
  // Cash movement is observed, not asserted. The ledger and the provider see
  // it; the ERP only ever learns about it second-hand, and an email claiming
  // money was sent is not money.
  MONEY_ARRIVED: {
    BANK: 1.0,
    RAZORPAY: 0.9,
    ERP: 0.4,
    USER: 0.35,
    INVOICE: 0.2,
    EMAIL: 0.15,
    HISTORICAL: 0.05,
  },

  // Whether an obligation exists is a bookkeeping fact. Here the ordering
  // INVERTS: the ERP is authoritative and the bank is nearly mute - a bank
  // statement cannot tell you an invoice was raised.
  OBLIGATION_EXISTS: {
    ERP: 1.0,
    INVOICE: 0.85,
    USER: 0.6,
    RAZORPAY: 0.5,
    EMAIL: 0.35,
    BANK: 0.25,
    HISTORICAL: 0.05,
  },

  // What a counterparty said is knowable ONLY from the channel they said it on.
  // No amount of bank reliability makes the bank a witness to a conversation.
  COUNTERPARTY_STATED: {
    EMAIL: 1.0,
    USER: 0.9,
    ERP: 0.2,
    INVOICE: 0.1,
    RAZORPAY: 0.05,
    BANK: 0.05,
    HISTORICAL: 0.05,
  },

  // Future timing is nobody's fact. A stated intention and a measured pattern
  // are the two real signals; the bank's authority here is only that a settled
  // payment ends the question.
  LIKELY_TIMING: {
    USER: 0.8,
    EMAIL: 0.7,
    HISTORICAL: 0.7,
    ERP: 0.5,
    BANK: 0.45,
    RAZORPAY: 0.4,
    INVOICE: 0.3,
  },
};

/** An unrecognised source is treated as weak, never as credible by default. */
const UNKNOWN_SOURCE_AUTHORITY = 0.1;

/**
 * A source at or above this weight is treated as able to SETTLE the question
 * on its own. Only MONEY_ARRIVED/BANK, MONEY_ARRIVED/RAZORPAY,
 * OBLIGATION_EXISTS/ERP, OBLIGATION_EXISTS/INVOICE and COUNTERPARTY_STATED/
 * EMAIL,USER clear it - deliberately nothing under LIKELY_TIMING, because no
 * source is authoritative about the future.
 */
const AUTHORITATIVE_THRESHOLD = 0.85;

/** How much this source's word counts for this question, in [0,1]. */
export function sourceAuthority(question: FinancialQuestion, sourceType: string): number {
  const profile = AUTHORITY[question];
  if (!profile) return UNKNOWN_SOURCE_AUTHORITY;
  return profile[sourceType.toUpperCase()] ?? UNKNOWN_SOURCE_AUTHORITY;
}

/** True if this source can settle this question by itself. */
export function isAuthoritativeFor(question: FinancialQuestion, sourceType: string): boolean {
  return sourceAuthority(question, sourceType) >= AUTHORITATIVE_THRESHOLD;
}

/** Sources that can settle this question, strongest first. */
export function authoritativeSources(question: FinancialQuestion): string[] {
  const profile = AUTHORITY[question] ?? {};
  return Object.entries(profile)
    .filter(([, weight]) => weight >= AUTHORITATIVE_THRESHOLD)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([source]) => source);
}

/**
 * The question a claim is really asking.
 *
 * ACTUAL/RECONCILED are about observed movement; CONTRACTUAL is about the
 * existence and terms of an obligation; CONFIRMED is a counterparty's stated
 * position; everything predictive is about timing.
 */
export function questionForClaimType(claimType: ClaimType): FinancialQuestion {
  switch (claimType) {
    case "ACTUAL":
    case "RECONCILED":
      return "MONEY_ARRIVED";
    case "CONTRACTUAL":
    case "EXPIRED":
      return "OBLIGATION_EXISTS";
    case "CONFIRMED":
      return "COUNTERPARTY_STATED";
    case "EXPECTED":
    case "PREDICTED":
    case "UNCERTAIN":
    case "CONTRADICTED":
      return "LIKELY_TIMING";
  }
}
