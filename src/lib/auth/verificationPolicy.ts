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

/**
 * The moment verification became a requirement.
 *
 * Accounts created before it cannot be held to it. They were made when signup
 * asked for no code, many sit on addresses that were never deliverable, and
 * barring them from signing in would lock real people out of real ledgers over
 * a rule that did not exist when they registered — with no way back in, because
 * the only route is a code to the address that does not work.
 *
 * Deliberately a cutoff rather than a backfill. Stamping `emailVerified` on
 * those accounts would have been simpler and is exactly wrong: it would assert
 * a round trip that never happened, and the alert dispatcher would start mailing
 * them again — which is the bounce this whole feature exists to stop.
 *
 * So the two questions are separated. An older account may SIGN IN unverified;
 * it still receives no mail until someone proves the address. New accounts get
 * neither, which is what keeps the signup step from being bypassable by
 * registering and then logging in instead.
 */
export const VERIFICATION_REQUIRED_FROM = new Date("2026-08-30T12:00:00.000Z");

export interface AccountForLogin {
  createdAt: Date;
  emailVerified: Date | null;
}

/** Whether this account must verify before it is given a session. */
export function loginRequiresVerification(user: AccountForLogin): boolean {
  if (user.emailVerified) return false;
  // No mailer means no code can arrive; see above.
  if (!verificationCanBeRequired()) return false;
  return user.createdAt.getTime() >= VERIFICATION_REQUIRED_FROM.getTime();
}
