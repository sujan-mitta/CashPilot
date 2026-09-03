import { formatINR } from "@/lib/format";
import type { SafetyProgress } from "@/lib/engine/safetyProgress";

/**
 * The message an operator gets when money arrives.
 *
 * WHAT IT HAS TO ANSWER, IN ORDER
 *
 * How much arrived, what it was for, and — the question that immediately
 * follows and used to go unanswered — whether it was enough. A notification
 * saying only "you received Rs 2,40,000" is pleasant and leaves the reader to
 * open the app and work out what it changed.
 *
 * WRITTEN TO BE READ ON A PHONE, ONCE
 *
 * The subject line carries the amount, because a great many people will read
 * only that. The first line of the body carries the verdict. Everything below
 * is detail for whoever wants it, and nobody has to scroll to learn whether
 * they still have a problem.
 *
 * The plain-text part is not an afterthought: it is what a screen reader and a
 * text-only client render, and it says the same things in the same order.
 */

export interface SettlementEmailInput {
  recipientName: string;
  businessName: string;
  payment: { amount: number; description: string; paymentLinkId: string };
  currentCash: number;
  progress: SafetyProgress;
}

export function renderSettlementEmail(input: SettlementEmailInput) {
  const { recipientName, businessName, payment, currentCash, progress } = input;
  const safe = progress.status === "SAFE";
  const amount = formatINR(payment.amount);

  // The amount, in the subject, because it is the one fact worth carrying even
  // if the message is never opened.
  const subject = `${amount} received — ${businessName}`;

  const verdict = safe
    ? "That clears your safe floor. Nothing further is needed."
    : `You are still ${formatINR(progress.shortfall)} below your safe floor.`;

  const text = [
    `Hi ${recipientName},`,
    ``,
    `${amount} has arrived for ${businessName}.`,
    `It was for: ${payment.description}`,
    ``,
    verdict,
    ``,
    `WHERE YOU STAND NOW`,
    `  Cash in the bank        ${formatINR(currentCash)}`,
    `  Lowest projected balance ${formatINR(progress.projectedLow)}`,
    `  Safe minimum to hold    ${formatINR(progress.safeFloor)}`,
    safe
      ? `  Clear by                ${formatINR(progress.projectedLow - progress.safeFloor)}`
      : `  Still short by          ${formatINR(progress.shortfall)}`,
    ``,
    ...(safe
      ? []
      : [
          progress.outstanding > 0
            ? `${formatINR(progress.outstanding)} is still out for collection.` +
              (progress.outstandingCoversShortfall
                ? " If it is all paid, you are clear."
                : ` Even if all of it is paid you would still be ${formatINR(progress.stillNeededBeyondOutstanding)} short.`)
            : "Nothing else is currently out for collection.",
          ``,
        ]),
    `These figures were recalculated after this payment landed, so they reflect`,
    `where the business stands now rather than when the link was issued.`,
    ``,
    `— CashPilot`,
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#0b0f19;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8ecf5">
  <div style="max-width:560px;margin:0 auto;background:#131a2a;border:1px solid #253049;border-radius:14px;overflow:hidden">

    <div style="padding:28px 32px 0">
      <p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8ea0c4">CashPilot &middot; ${esc(businessName)}</p>
      <h1 style="margin:0;font-size:26px;font-weight:700;color:#34d399;letter-spacing:-0.02em">${esc(amount)} received</h1>
      <p style="margin:8px 0 0;font-size:14px;line-height:1.6;color:#c3cee6">${esc(payment.description)}</p>
    </div>

    <div style="margin:22px 32px;padding:14px 16px;border-radius:10px;background:${safe ? "#0e2a20" : "#2a1f0e"};border:1px solid ${safe ? "#1f6f52" : "#7a5a1f"}">
      <p style="margin:0;font-size:14px;font-weight:600;line-height:1.5;color:${safe ? "#34d399" : "#fbbf24"}">${esc(verdict)}</p>
    </div>

    <div style="padding:0 32px 8px">
      <p style="margin:0 0 10px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8ea0c4">Where you stand now</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${row("Cash in the bank", formatINR(currentCash), "#e8ecf5")}
        ${row("Lowest projected balance", formatINR(progress.projectedLow), progress.projectedLow < 0 ? "#f87171" : "#e8ecf5")}
        ${row("Safe minimum to hold", formatINR(progress.safeFloor), "#e8ecf5")}
        ${
          safe
            ? row("Clear by", formatINR(progress.projectedLow - progress.safeFloor), "#34d399", true)
            : row("Still short by", formatINR(progress.shortfall), "#fbbf24", true)
        }
      </table>
    </div>

    ${
      safe
        ? ""
        : `<div style="padding:4px 32px 0">
             <p style="margin:0;font-size:13px;line-height:1.6;color:#8ea0c4">${esc(
               progress.outstanding > 0
                 ? `${formatINR(progress.outstanding)} is still out for collection.` +
                     (progress.outstandingCoversShortfall
                       ? " If it is all paid, you are clear."
                       : ` Even if all of it is paid you would still be ${formatINR(progress.stillNeededBeyondOutstanding)} short.`)
                 : "Nothing else is currently out for collection."
             )}</p>
           </div>`
    }

    <div style="padding:20px 32px 28px">
      <p style="margin:0;font-size:11.5px;line-height:1.6;color:#6f80a4;border-top:1px solid #253049;padding-top:16px">
        These figures were recalculated after this payment landed, so they reflect where the
        business stands now rather than when the link was issued.
      </p>
    </div>

  </div>
</body></html>`;

  return { subject, text, html };
}

/** One line of the figures table. */
function row(label: string, value: string, colour: string, emphasise = false): string {
  return `<tr>
    <td style="padding:7px 0;color:#8ea0c4;border-bottom:1px solid #1c2438">${esc(label)}</td>
    <td style="padding:7px 0;text-align:right;font-weight:${emphasise ? 700 : 600};color:${colour};border-bottom:1px solid #1c2438">${esc(value)}</td>
  </tr>`;
}

/**
 * Escapes anything that came from the ledger.
 *
 * A transaction description is operator-entered text and reaches this email
 * unchanged. Without escaping, a description containing markup would be
 * rendered as markup by the recipient's client.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
