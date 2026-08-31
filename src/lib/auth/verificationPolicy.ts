import { resolveMailerProvider } from "@/lib/notifications/mailer";

/**
 * Whether email verification can be REQUIRED at all.
 *
 * Requiring a code is only defensible when a code can actually arrive. With no
 * mail provider configured the mailer runs in its local sandbox: it reports
 * success and sends nothing. Gating sign-in on a code in that state locks every
 * account out permanently, because the only route back in is an email that will
 * never be delivered — and unlike most bad states, nobody can fix it from
 * inside the product.
 *
 * Standing down here costs nothing that matters. The point of verification is
 * to stop mail going to addresses that do not exist; a deployment that sends no
 * mail cannot produce a bounce, so there is nothing to protect against.
 *
 * Note this is deliberately NOT the same question as whether to SEND an alert.
 * `evaluateRecipient` refuses an unverified recipient unconditionally, sandbox
 * or not. This only governs whether an unverified user is barred from signing
 * in.
 */
export function verificationCanBeRequired(): boolean {
  return resolveMailerProvider() !== "LOCAL_SANDBOX";
}
