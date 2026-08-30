import { createHash, randomInt } from "node:crypto";
import { secretsMatch } from "./constantTime";

/**
 * Proving that an email address can actually receive mail.
 *
 * WHY THIS EXISTS
 *
 * Signup accepted any string that looked like an address. `validateEmail` checks
 * shape, and shape is not existence — "sujan@gmial.com" is a perfectly well
 * formed address at a domain that will never deliver. The account was created,
 * the alert pipeline treated the address as a real recipient, and every crisis
 * alert bounced. Bounces go back to the SENDER, so the operator's own inbox
 * filled with "recipient does not exist" from their own product.
 *
 * Nothing in the shape check could have caught that. The only way to know an
 * address exists is to send something to it and have a human read it back.
 *
 * DESIGN
 *
 * A six-digit code, mailed once, exchanged for a verified flag.
 *
 *  - The code is NEVER stored. Only its SHA-256 lands in the database, so a
 *    dump does not hand over live codes.
 *  - Six digits is a million possibilities, which is only safe because guesses
 *    are BOUNDED. Attempts are capped and the code expires; without both, a
 *    six-digit secret is trivially brute-forced.
 *  - Codes are generated with `randomInt`, not `Math.random()` and not
 *    `bytes % 1000000`. The first is not cryptographic; the second is
 *    modulo-biased, making low codes measurably likelier.
 *  - Comparison is constant-time, matching every other secret check here.
 *  - Issuing a new code invalidates the old ones, so "resend" cannot widen the
 *    guessing surface by leaving several live codes outstanding.
 */

/** How long a code stays usable. Long enough for slow mail, short enough to bound guessing. */
export const CODE_TTL_MINUTES = 10;

/**
 * Wrong guesses allowed per code.
 *
 * With 10^6 codes and 5 attempts, a blind attacker has a 1-in-200,000 chance per
 * issued code. Enough headroom for a genuine typo, nowhere near enough to search.
 */
export const MAX_ATTEMPTS = 5;

/** Minimum gap between sends, so the endpoint cannot be used to spam an inbox. */
export const RESEND_COOLDOWN_SECONDS = 60;

export const CODE_LENGTH = 6;

const SIX_DIGITS = /^\d{6}$/;
if (CODE_LENGTH !== 6) throw new Error("SIX_DIGITS must be updated alongside CODE_LENGTH");

/**
 * A fresh code as digits.
 *
 * `randomInt` is uniform over the range and cryptographically sourced. Padding
 * keeps leading zeros, so "004821" stays six characters and does not silently
 * become a four-digit code.
 */
export function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

/** What goes in the database. The code itself never does. */
export function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function expiryFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000);
}

/** Digits only, exactly CODE_LENGTH. Whitespace is forgiven; anything else is not. */
export function normalizeSubmittedCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\s-]/g, "");
  // A literal, not a template-built RegExp. `\d` inside a template literal is
  // not an escape JS recognises, so it collapses to a bare "d" and the pattern
  // silently becomes /^d{6}$/ — which matches "dddddd" and rejects every real
  // code. Pinned to CODE_LENGTH by the assertion below instead.
  if (!SIX_DIGITS.test(cleaned)) return null;
  return cleaned;
}

export type VerificationOutcome =
  | "VERIFIED"
  | "NO_CODE"
  | "EXPIRED"
  | "ALREADY_USED"
  | "TOO_MANY_ATTEMPTS"
  | "INCORRECT";

/** The stored code, reduced to what the decision actually depends on. */
export interface StoredCode {
  codeHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  attempts: number;
}

/**
 * Decide whether a submitted code is acceptable.
 *
 * Pure, so the rules are testable without a database, and so the ORDER of the
 * checks is pinned by tests. Order matters: an expired code must be rejected as
 * EXPIRED before it is ever compared, or a caller could keep guessing against a
 * dead code forever and the attempt cap would never bite.
 */
export function evaluateCode(
  stored: StoredCode | null,
  submitted: string,
  now: Date = new Date()
): VerificationOutcome {
  if (!stored) return "NO_CODE";
  if (stored.usedAt) return "ALREADY_USED";
  if (stored.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  if (stored.attempts >= MAX_ATTEMPTS) return "TOO_MANY_ATTEMPTS";
  return secretsMatch(stored.codeHash, hashCode(submitted)) ? "VERIFIED" : "INCORRECT";
}

/**
 * What to tell the user.
 *
 * Deliberately does NOT distinguish "no code was ever issued" from "wrong code":
 * both say the same thing. Telling an unauthenticated caller which addresses
 * have codes outstanding is an account-enumeration oracle.
 */
export function outcomeMessage(outcome: VerificationOutcome): string {
  switch (outcome) {
    case "VERIFIED":
      return "Email verified.";
    case "EXPIRED":
      return `That code has expired. Codes are valid for ${CODE_TTL_MINUTES} minutes — request a new one.`;
    case "ALREADY_USED":
      return "That code has already been used. Request a new one if you need to verify again.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many incorrect attempts for this code. Request a new one.";
    case "NO_CODE":
    case "INCORRECT":
      return "That code is not correct. Check the most recent email, or request a new code.";
  }
}

/** HTTP status for each outcome, so routes cannot disagree about them. */
export function outcomeStatus(outcome: VerificationOutcome): number {
  if (outcome === "VERIFIED") return 200;
  if (outcome === "TOO_MANY_ATTEMPTS") return 429;
  return 400;
}

/** Whether a cooldown blocks issuing another code. */
export function resendBlockedFor(
  lastSentAt: Date | null | undefined,
  now: Date = new Date()
): number {
  if (!lastSentAt) return 0;
  const elapsed = (now.getTime() - lastSentAt.getTime()) / 1000;
  return Math.max(0, Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed));
}
