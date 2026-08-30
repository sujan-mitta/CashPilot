import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of two shared secrets.
 *
 * `===` on strings short-circuits at the first differing byte, so how long the
 * comparison takes leaks how much of a guess was correct. Over HTTP that signal
 * is buried under network jitter and is not a practical attack — but the
 * webhook HMAC path and the password path in this codebase already compare
 * constant-time, and a secret check that does not is the odd one out. Uniformity
 * here is worth more than the argument about whether this particular caller is
 * exploitable.
 *
 * Length is compared through the digest, not before it. `timingSafeEqual`
 * throws on unequal buffer lengths, and returning early on a length mismatch
 * would leak the secret's length; hashing both sides to a fixed width removes
 * the question entirely.
 */
export function secretsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  // An absent secret never matches. Notably `secretsMatch(undefined, undefined)`
  // is false: an unconfigured secret must not authorise a request that also
  // supplied nothing.
  if (!a || !b) return false;

  // SHA-256 both sides so the buffers are always 32 bytes and the comparison
  // itself never depends on input length.
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();

  return timingSafeEqual(ha, hb);
}
