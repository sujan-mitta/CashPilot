/**
 * Whether an address may be sent an alert at all.
 *
 * THE BUG THIS CLOSES
 *
 * The dispatcher sent to `user.email` unconditionally. When the address does not
 * exist, the provider bounces, and a bounce is delivered to the SENDER — so the
 * operator receives "recipient does not exist" from their own product, over and
 * over, once per alert cycle. The alert itself is never read by anyone.
 *
 * Retrying makes it worse: each retry is another bounce. The fix is not better
 * retry handling, it is not sending in the first place.
 *
 * WHAT COUNTS AS SENDABLE
 *
 * An address a human has proven they can read, by entering a code mailed to it.
 * Shape validation cannot establish this — "sujan@gmial.com" is well formed and
 * undeliverable — so the only evidence that counts is a completed round trip.
 *
 * WHY SUPPRESSION, NOT FAILURE
 *
 * A suppressed alert is recorded with its reason and stays visible in-app. The
 * crisis is not hidden: the dashboard still shows it. What stops is the futile
 * outbound attempt, and the bounce it generates.
 */

export type RecipientDecision = "SENDABLE" | "UNVERIFIED" | "MISSING" | "MALFORMED";

export interface EligibilityResult {
  decision: RecipientDecision;
  sendable: boolean;
  /** Recorded as the suppression reason. Null when sendable. */
  reason: string | null;
}

/**
 * The same shape rule the rest of auth uses.
 *
 * Kept as a last-resort guard rather than the primary check: it exists to stop
 * an obviously broken string reaching the provider, not to judge deliverability.
 */
const SHAPE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export interface RecipientLike {
  email?: string | null;
  emailVerified?: Date | string | null;
}

export function evaluateRecipient(user: RecipientLike): EligibilityResult {
  const email = typeof user.email === "string" ? user.email.trim() : "";

  if (!email) {
    return {
      decision: "MISSING",
      sendable: false,
      reason: "No email address on file for this user; alert recorded in-app only.",
    };
  }

  if (!SHAPE.test(email)) {
    return {
      decision: "MALFORMED",
      sendable: false,
      reason: "Recipient address is not a valid email address; alert recorded in-app only.",
    };
  }

  if (!user.emailVerified) {
    return {
      decision: "UNVERIFIED",
      sendable: false,
      reason:
        "Recipient email is not verified. Sending to an unconfirmed address risks a bounce, " +
        "so the alert was recorded in-app only. Verify the address to enable email alerts.",
    };
  }

  return { decision: "SENDABLE", sendable: true, reason: null };
}
