import { CODE_TTL_MINUTES } from "@/lib/auth/emailVerification";

/**
 * The one email that is allowed to go to an unverified address.
 *
 * It has to be: it is the thing that establishes verification. Every OTHER
 * outbound message is gated on the result of this one.
 */
export function renderVerificationEmail(recipientName: string, code: string) {
  const who = recipientName?.trim() || "there";
  const subject = `${code} is your CashPilot verification code`;

  const text = [
    `Hi ${who},`,
    ``,
    `Your CashPilot verification code is ${code}.`,
    ``,
    `It expires in ${CODE_TTL_MINUTES} minutes and can be used once.`,
    ``,
    `If you did not create a CashPilot account, you can ignore this email —`,
    `nothing was set up and no alerts will be sent to this address.`,
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#0b0f19;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8ecf5">
  <div style="max-width:480px;margin:0 auto;background:#131a2a;border:1px solid #253049;border-radius:14px;padding:32px">
    <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8ea0c4">CashPilot</p>
    <h1 style="margin:0 0 20px;font-size:20px;font-weight:600;color:#fff">Confirm your email</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#c3cee6">Hi ${escapeHtml(who)}, enter this code to finish setting up your account.</p>
    <div style="margin:0 0 20px;padding:18px;text-align:center;background:#0b0f19;border:1px solid #253049;border-radius:10px">
      <span style="font-size:32px;font-weight:700;letter-spacing:.28em;color:#fff;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(code)}</span>
    </div>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#8ea0c4">It expires in ${CODE_TTL_MINUTES} minutes and can be used once.</p>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#6f80a4">If you did not create a CashPilot account, you can ignore this email &mdash; nothing was set up, and no alerts will be sent to this address.</p>
  </div>
</body></html>`;

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
