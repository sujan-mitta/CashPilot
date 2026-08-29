/**
 * High-fidelity responsive HTML and plain-text email templates for CashPilot notifications.
 *
 * Implements strict HTML escaping for all user/database content to prevent injection,
 * and renders consistent dark-mode friendly styling matching the CashPilot design language.
 */

import type { HealthAssessment, RootCauseItem } from "./types";
import { formatPaise } from "@/lib/format";

/**
 * Escapes unsafe characters for HTML rendering.
 */
export function escapeHtml(str: string | null | undefined): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(isoString: string | null | undefined): string {
  if (!isoString) return "N/A";
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(isoString);
  }
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  ctaUrl: string;
}

/**
 * Renders the authoritative email for a financial health alert.
 */
export function renderAlertEmail(
  assessment: HealthAssessment,
  recipientName: string,
  appBaseUrl: string = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
): RenderedEmail {
  const isCritical = assessment.severity === "CRITICAL";
  const isWarning = assessment.severity === "WARNING";

  const safeBizName = escapeHtml(assessment.businessName);
  const safeRecipientName = escapeHtml(recipientName);

  // Subject line
  const subject = isCritical
    ? `🚨 CRITICAL: Cash Deficit Alert for ${assessment.businessName} (${assessment.runwayDays} Days Runway)`
    : isWarning
    ? `⚠️ Cash Health Warning: Buffer Dip for ${assessment.businessName}`
    : `📊 Weekly Cash Briefing for ${assessment.businessName}`;

  // CTA link target: prioritize /approval if strategy requires approval, else /dashboard
  const hasActionableStrategy = assessment.recommendedStrategy?.requiresApproval;
  const ctaPath = hasActionableStrategy ? "/approval" : "/dashboard";
  const ctaUrl = `${appBaseUrl.replace(/\/$/, "")}${ctaPath}`;
  const ctaLabel = hasActionableStrategy
    ? "Review & Approve Action Plan"
    : "Open CashPilot Dashboard";

  // Color theme
  const accentColor = isCritical ? "#ef4444" : isWarning ? "#f59e0b" : "#10b981";
  const badgeBg = isCritical ? "#450a0a" : isWarning ? "#451a03" : "#064e3b";
  const badgeText = isCritical ? "#fca5a5" : isWarning ? "#fcd34d" : "#6ee7b7";
  const badgeLabel = isCritical
    ? "🚨 CRITICAL LIQUIDITY DEFICIT"
    : isWarning
    ? "⚠️ LIQUIDITY BUFFER WARNING"
    : "📊 HEALTHY CASH POSITION";

  // Format metrics
  const currentBalanceFormatted = formatPaise(assessment.currentBalance);
  const safetyBufferFormatted = formatPaise(assessment.safetyBuffer);
  const deficitDateFormatted = formatDate(assessment.projectedDeficitDate);

  // Render Root Causes HTML
  const rootCausesHtml = assessment.rootCauses.length > 0
    ? assessment.rootCauses
        .slice(0, 3)
        .map((rc: RootCauseItem) => {
          const amountBadge = rc.amount ? `<span style="display:inline-block;padding:2px 8px;font-size:12px;font-weight:bold;border-radius:4px;background:#262626;color:#e5e5e5;margin-left:8px;">${escapeHtml(formatPaise(rc.amount))}</span>` : "";
          const dateInfo = rc.dueDate ? `<span style="font-size:12px;color:#a3a3a3;">Due: ${escapeHtml(formatDate(rc.dueDate))}</span>` : "";
          return `
            <div style="background:#171717;border:1px solid #262626;border-radius:8px;padding:12px 16px;margin-bottom:8px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <strong style="color:#ffffff;font-size:14px;">${escapeHtml(rc.title)}</strong>
                ${amountBadge}
              </div>
              <div style="color:#d4d4d4;font-size:13px;line-height:1.4;">${escapeHtml(rc.description)}</div>
              ${dateInfo ? `<div style="margin-top:4px;">${dateInfo}</div>` : ""}
            </div>
          `;
        })
        .join("")
    : `<div style="color:#a3a3a3;font-size:13px;padding:8px 0;">No active cash-flow blockers detected.</div>`;

  // Render Recommended Strategy HTML
  const strategyHtml = assessment.recommendedStrategy
    ? `
      <div style="background:#0f172a;border:1px solid #1e293b;border-left:4px solid #38bdf8;border-radius:8px;padding:14px 16px;margin-top:16px;">
        <div style="color:#38bdf8;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">AI Recommended Strategy</div>
        <div style="color:#ffffff;font-size:15px;font-weight:600;margin-bottom:6px;">${escapeHtml(assessment.recommendedStrategy.title)}</div>
        <div style="color:#cbd5e1;font-size:13px;line-height:1.4;">
          Expected runway recovery: <strong>+${assessment.recommendedStrategy.expectedRunwayChangeDays} days</strong>
        </div>
      </div>
    `
    : "";

  // Complete HTML document
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e5e5e5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#0a0a0a;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:600px;background-color:#121212;border:1px solid #262626;border-radius:12px;overflow:hidden;text-align:left;">
          
          <!-- Header -->
          <tr>
            <td style="padding:24px 28px;border-bottom:1px solid #262626;background-color:#171717;">
              <table role="presentation" width="100%">
                <tr>
                  <td>
                    <span style="font-size:20px;font-weight:bold;color:#ffffff;letter-spacing:-0.5px;">CashPilot</span>
                    <span style="display:inline-block;padding:2px 8px;margin-left:8px;font-size:11px;font-weight:600;background:#262626;color:#a3a3a3;border-radius:12px;">Automated CFO</span>
                  </td>
                  <td align="right">
                    <span style="font-size:12px;color:#737373;">${escapeHtml(formatDate(assessment.assessedAt))}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body Content -->
          <tr>
            <td style="padding:28px;">
              
              <!-- Severity Badge -->
              <div style="display:inline-block;padding:6px 12px;border-radius:6px;background-color:${badgeBg};color:${badgeText};font-size:12px;font-weight:700;letter-spacing:0.5px;margin-bottom:16px;border:1px solid ${accentColor}40;">
                ${badgeLabel}
              </div>

              <!-- Greeting -->
              <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:bold;color:#ffffff;line-height:1.3;">
                ${isCritical ? "Immediate Cash Action Needed" : "Liquidity Status Update"}
              </h1>
              <p style="margin:0 0 20px 0;font-size:14px;color:#a3a3a3;line-height:1.5;">
                Hello ${safeRecipientName}, CashPilot's continuous financial engine has detected a change in cash runway for <strong>${safeBizName}</strong>.
              </p>

              <!-- Metrics Grid -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px;">
                <tr>
                  <td width="33%" style="background:#171717;border:1px solid #262626;border-radius:8px;padding:14px;text-align:center;">
                    <div style="font-size:11px;color:#737373;text-transform:uppercase;font-weight:600;margin-bottom:4px;">Runway</div>
                    <div style="font-size:22px;font-weight:bold;color:${accentColor};">${assessment.runwayDays} Days</div>
                  </td>
                  <td width="4%"></td>
                  <td width="30%" style="background:#171717;border:1px solid #262626;border-radius:8px;padding:14px;text-align:center;">
                    <div style="font-size:11px;color:#737373;text-transform:uppercase;font-weight:600;margin-bottom:4px;">Balance</div>
                    <div style="font-size:18px;font-weight:bold;color:#ffffff;">${currentBalanceFormatted}</div>
                  </td>
                  <td width="4%"></td>
                  <td width="29%" style="background:#171717;border:1px solid #262626;border-radius:8px;padding:14px;text-align:center;">
                    <div style="font-size:11px;color:#737373;text-transform:uppercase;font-weight:600;margin-bottom:4px;">Deficit Date</div>
                    <div style="font-size:14px;font-weight:bold;color:#fca5a5;">${deficitDateFormatted}</div>
                  </td>
                </tr>
              </table>

              <!-- Root Causes Section -->
              <div style="margin-bottom:20px;">
                <div style="font-size:13px;font-weight:700;color:#ffffff;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">
                  Primary Drivers
                </div>
                ${rootCausesHtml}
              </div>

              <!-- AI Recommended Strategy -->
              ${strategyHtml}

              <!-- Call to Action -->
              <div style="text-align:center;margin-top:32px;margin-bottom:12px;">
                <a href="${escapeHtml(ctaUrl)}" target="_blank" style="display:inline-block;background-color:#2563eb;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 28px;border-radius:8px;box-shadow:0 4px 12px rgba(37,99,235,0.3);">
                  ${escapeHtml(ctaLabel)} &rarr;
                </a>
              </div>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 28px;border-top:1px solid #262626;background-color:#171717;color:#737373;font-size:12px;line-height:1.5;">
              <p style="margin:0 0 6px 0;">
                This alert was automatically generated for <strong>${safeBizName}</strong> because no active dashboard activity was observed after the liquidity change.
              </p>
              <p style="margin:0;">
                Manage your alert frequencies and cooldowns in your <a href="${escapeHtml(appBaseUrl)}/profile" style="color:#60a5fa;text-decoration:underline;">CashPilot Settings</a>.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  // Plain-text alternative
  const textRootCauses = assessment.rootCauses.length > 0
    ? assessment.rootCauses.map((rc, idx) => `  ${idx + 1}. ${rc.title} ${rc.amount ? `(${formatPaise(rc.amount)})` : ""} - ${rc.description}`).join("\n")
    : "  No active blockers detected.";

  const textStrategy = assessment.recommendedStrategy
    ? `\nAI RECOMMENDED STRATEGY:\n  ${assessment.recommendedStrategy.title}\n  Expected recovery: +${assessment.recommendedStrategy.expectedRunwayChangeDays} days runway\n`
    : "";

  const text = `
CashPilot Automated Liquidity Alert
====================================
Status: ${badgeLabel}
Business: ${assessment.businessName}
Date: ${formatDate(assessment.assessedAt)}

KEY METRICS:
- Runway: ${assessment.runwayDays} Days
- Current Cash: ${currentBalanceFormatted}
- Safety Buffer: ${safetyBufferFormatted}
- Projected Deficit Date: ${deficitDateFormatted}

PRIMARY DRIVERS:
${textRootCauses}
${textStrategy}
TAKE ACTION:
${ctaLabel}: ${ctaUrl}

---
You received this because you are registered for ${assessment.businessName} on CashPilot.
Manage preferences: ${appBaseUrl}/profile
  `.trim();

  return {
    subject,
    html,
    text,
    ctaUrl,
  };
}
