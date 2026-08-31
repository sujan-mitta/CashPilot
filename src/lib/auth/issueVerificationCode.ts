import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability";
import { sendNotificationEmail } from "@/lib/notifications/mailer";
import { renderVerificationEmail } from "@/lib/notifications/verificationEmail";
import {
  generateCode,
  hashCode,
  expiryFrom,
  resendBlockedFor,
  RESEND_COOLDOWN_SECONDS,
} from "./emailVerification";

export type IssueResult =
  | { ok: true; expiresAt: Date }
  | { ok: false; reason: "COOLDOWN"; retryAfterSec: number }
  | { ok: false; reason: "SEND_FAILED" };

/**
 * Mint a code, invalidate any earlier ones, and mail it.
 *
 * Earlier codes are consumed rather than left alive. Several outstanding codes
 * would multiply the guessing surface for free — "resend" five times and five
 * different six-digit codes are each acceptable.
 *
 * The row is written BEFORE the send. If the write succeeded and the send fails,
 * the user simply requests another code; if the order were reversed, a delivered
 * code might have no row to check it against, which is unrecoverable for them.
 *
 * Transport is the same mailer the alert pipeline uses, so this delivery lands
 * in the same audit trail. That matters here more than anywhere else: when an
 * operator says verification never arrived, the audit record is what
 * distinguishes "we never sent it" from "the provider took it and the address
 * does not exist" — which is precisely the failure this whole feature exists to
 * stop.
 */
export async function issueVerificationCode(
  user: { id: string; name: string; email: string },
  now: Date = new Date()
): Promise<IssueResult> {
  const latest = await prisma.emailVerificationCode.findFirst({
    where: { userId: user.id, email: user.email },
    orderBy: { createdAt: "desc" },
  });

  const wait = resendBlockedFor(latest?.createdAt ?? null, now);
  if (wait > 0) return { ok: false, reason: "COOLDOWN", retryAfterSec: wait };

  const code = generateCode();
  const expiresAt = expiryFrom(now);

  const record = await prisma.$transaction(async (tx) => {
    // Superseded codes are DELETED, not flagged.
    //
    // Marking them used would be enough to make them unusable — `evaluateCode`
    // refuses a used code outright — but it leaves the hash of a dead secret in
    // the table forever, and they accumulate one per resend. Nothing reads them
    // afterwards. The smallest store of live secrets is the right one, and a
    // row that exists only to be rejected is not worth keeping.
    //
    // Expired codes for this address go too: they are already inert, and this
    // is the natural moment to sweep them.
    await tx.emailVerificationCode.deleteMany({
      where: {
        userId: user.id,
        email: user.email,
        OR: [{ usedAt: null }, { expiresAt: { lt: now } }],
      },
    });
    return tx.emailVerificationCode.create({
      data: { userId: user.id, email: user.email, codeHash: hashCode(code), expiresAt },
    });
  });

  const rendered = renderVerificationEmail(user.name, code);
  const result = await sendNotificationEmail({
    alertId: `verify_${record.id}`,
    businessId: "account-verification",
    to: user.email,
    recipientName: user.name,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  // SIMULATED is NOT delivery. The sandbox provider returns it when no mail
  // provider is configured, and counting it as sent would tell the user a code
  // is on its way when nothing left the process — locking every account out of
  // sign-in with no way to recover, since the only route back in is a code that
  // will never arrive.
  const delivered = result.status === "SENT" || result.status === "ACCEPTED";

  if (!delivered) {
    // The code is never logged, at any level. A verification code in an
    // application log is a verification code an operator can read.
    logger.error("Verification email failed to send", {
      userId: user.id,
      provider: result.provider,
      status: result.status,
    });
    return { ok: false, reason: "SEND_FAILED" };
  }

  logger.info("Verification code issued", { userId: user.id, provider: result.provider });
  return { ok: true, expiresAt };
}

export { RESEND_COOLDOWN_SECONDS };
