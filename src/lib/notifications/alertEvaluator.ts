/**
 * Core alert evaluation and dispatch engine for CashPilot.
 *
 * Implements the 14-step evaluation pipeline:
 * 1. Retrieves authoritative business health
 * 2. Determines severity (CRITICAL, WARNING, HEALTHY)
 * 3. Builds crisisKey (deterministic identity)
 * 4. Checks user offline state (30m for Critical, 24h for Warning)
 * 5. Checks if user viewed dashboard after crisis occurred (suppresses email)
 * 6. Checks user preferences
 * 7. Enforces cooldowns (72h for Critical, 7d for Warning)
 * 8. Atomically claims and dispatches email via mailer
 * 9. Persists delivery audit
 */

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability";
import { assessBusinessHealth } from "./healthAssessment";
import { renderAlertEmail } from "./emailTemplates";
import { sendNotificationEmail } from "./mailer";
import {
  claimAlertForDispatch,
  findLatestAlertForCrisis,
  getPreferences,
  getUserActivity,
  recordAlert,
  updateAlertDelivery,
} from "./alertStore";
import type {
  AlertEvaluationResult,
  AlertEvaluationStatus,
  AlertRecord,
  DeliveryStatus,
  HealthAssessment,
} from "./types";
import crypto from "crypto";
import { evaluateRecipient } from "./recipientEligibility";

export interface EvaluateAlertsOptions {
  businessId: string;
  now?: Date;
  appBaseUrl?: string;
  forceSendForTesting?: boolean;
}

/**
 * Evaluates business health and dispatches email alerts if criteria are met.
 */
export async function evaluateAndDispatchAlerts(
  options: EvaluateAlertsOptions
): Promise<AlertEvaluationResult> {
  const now = options.now || new Date();
  const nowIso = now.toISOString();

  // 1. Authoritative Health Assessment
  const assessment = await assessBusinessHealth(options.businessId, now);
  if (!assessment) {
    logger.warn("Health assessment returned null for business", { businessId: options.businessId });
    return {
      businessId: options.businessId,
      businessName: "Unknown",
      assessedAt: nowIso,
      healthAssessment: null as unknown as HealthAssessment,
      evaluationStatus: "INSUFFICIENT_CONFIDENCE",
      evaluatedRecipients: [],
      crisisKey: null,
      emailsAttempted: 0,
      emailsSent: 0,
      emailsSuppressed: 0,
    };
  }

  // Healthy businesses: no emergency emails
  if (assessment.severity === "HEALTHY" || !assessment.crisisKey) {
    return {
      businessId: assessment.businessId,
      businessName: assessment.businessName,
      assessedAt: nowIso,
      healthAssessment: assessment,
      evaluationStatus: "SUPPRESSED",
      evaluatedRecipients: [],
      crisisKey: null,
      emailsAttempted: 0,
      emailsSent: 0,
      emailsSuppressed: 0,
    };
  }

  // 2. Fetch Business Users & Preferences
  const business = await prisma.business.findUnique({
    where: { id: options.businessId },
    include: { users: true },
  });

  const users = business?.users || [];
  const preferences = await getPreferences(options.businessId);

  // 3. Resolve Registered User Recipients
  const evaluatedRecipients: AlertEvaluationResult["evaluatedRecipients"] = [];
  let emailsAttempted = 0;
  let emailsSent = 0;
  let emailsSuppressed = 0;

  for (const user of users) {
    const alertId = `alert_${crypto.randomUUID()}`;

    // One recipient's failure must not abort the batch, and must never be
    // mistaken for a decision to stay silent. The dispatch gates now throw when
    // the database cannot answer — deliberately, so that "I cannot tell" never
    // becomes "go ahead" — and that has to be contained here or a single
    // unhealthy lookup would end the whole scheduled pass for every business.
    try {
    const userActivity = await getUserActivity(user.id, options.businessId);

    // Default timestamps if activity has not been recorded yet
    const lastSeenAt = userActivity?.lastSeenAt ? new Date(userActivity.lastSeenAt) : new Date(0);

    const minutesSinceSeen = (now.getTime() - lastSeenAt.getTime()) / (1000 * 60);

    let evaluationStatus: AlertEvaluationStatus = "QUALIFIED";
    let suppressionReason: string | undefined = undefined;

    // Check A: Preferences Check
    if (assessment.severity === "CRITICAL" && !preferences.criticalAlertsEnabled) {
      evaluationStatus = "PREFERENCE_DISABLED";
      suppressionReason = "Critical alerts disabled in user preferences";
    } else if (assessment.severity === "WARNING" && !preferences.warningAlertsEnabled) {
      evaluationStatus = "PREFERENCE_DISABLED";
      suppressionReason = "Warning alerts disabled in user preferences";
    }

    // Check B: User Activity / Online Check
    if (evaluationStatus === "QUALIFIED" && !options.forceSendForTesting) {
      const offlineThresholdMinutes = assessment.severity === "CRITICAL"
        ? preferences.offlineThresholdMinutes // 30 mins
        : 24 * 60; // 24 hours for warning

      if (minutesSinceSeen < offlineThresholdMinutes) {
        evaluationStatus = "ACTIVE_USER";
        suppressionReason = `User active recently (${Math.round(minutesSinceSeen)}m ago < ${offlineThresholdMinutes}m threshold)`;
      }
    }

    // Check C: Dashboard Viewed Check (Suppress if user explicitly viewed this crisis on the dashboard)
    if (evaluationStatus === "QUALIFIED" && !options.forceSendForTesting) {
      const viewedThisExactCrisis =
        userActivity?.lastViewedCrisisKey === assessment.crisisKey ||
        userActivity?.lastViewedCrisisKey === "CRITICAL_VIEWED";

      if (viewedThisExactCrisis) {
        evaluationStatus = "ALREADY_VIEWED";
        suppressionReason = `User has already viewed crisis ${assessment.crisisKey} on the dashboard`;
      }
    }

    // Check D: Cooldown Check (by deterministic crisisKey)
    if (evaluationStatus === "QUALIFIED" && !options.forceSendForTesting) {
      const latestAlert = await findLatestAlertForCrisis(options.businessId, assessment.crisisKey);
      if (latestAlert && latestAlert.sentAt) {
        const hoursSinceLastAlert = (now.getTime() - new Date(latestAlert.sentAt).getTime()) / (1000 * 60 * 60);
        const cooldownHours = assessment.severity === "CRITICAL"
          ? preferences.criticalCooldownHours // 72 hours
          : preferences.warningCooldownHours; // 168 hours (7 days)

        if (hoursSinceLastAlert < cooldownHours) {
          evaluationStatus = "COOLDOWN";
          suppressionReason = `Cooldown active for crisis ${assessment.crisisKey} (${hoursSinceLastAlert.toFixed(1)}h < ${cooldownHours}h)`;
        }
      }
    }

    // Check E: Can this address actually receive mail?
    //
    // An address that does not exist bounces, and the bounce comes back to US —
    // so an unverified recipient turns every alert cycle into another "recipient
    // does not exist" in the operator's own inbox, while the alert itself is
    // read by nobody.
    //
    // Deliberately NOT gated on forceSendForTesting. Every other check above is
    // a judgement about whether the user needs this alert, and forcing past
    // those is a reasonable thing to do while testing. This one is a statement
    // about whether the mail can be delivered at all, and forcing past it just
    // produces a bounce.
    if (evaluationStatus === "QUALIFIED") {
      const eligibility = evaluateRecipient(user);
      if (!eligibility.sendable) {
        evaluationStatus = "SUPPRESSED";
        suppressionReason = eligibility.reason ?? "Recipient address is not sendable";
      }
    }

    // 4. Decision Recording
    const initialDeliveryStatus: DeliveryStatus = evaluationStatus === "QUALIFIED" ? "SIMULATED" : "SUPPRESSED";
    const rendered = renderAlertEmail(assessment, user.name || "Finance Leader", options.appBaseUrl);

    const alertRecord: AlertRecord = {
      alertId,
      tenantId: options.businessId,
      businessId: options.businessId,
      businessName: assessment.businessName,
      userId: user.id,
      userEmail: user.email,
      severity: assessment.severity,
      crisisKey: assessment.crisisKey,
      crisisTitle: rendered.subject,
      occurredAt: assessment.assessedAt,
      detectedAt: nowIso,
      viewedAt: userActivity?.lastDashboardViewAt ?? null,
      emailEligibleAt: evaluationStatus === "QUALIFIED" ? nowIso : null,
      sentAt: null,
      deliveryStatus: initialDeliveryStatus,
      suppressionReason: suppressionReason ?? null,
      healthAssessment: assessment,
      renderedSubject: rendered.subject,
    };

    await recordAlert(alertRecord);

    // 5. Send Email if QUALIFIED
    let finalDeliveryStatus: DeliveryStatus = initialDeliveryStatus;

    if (evaluationStatus === "QUALIFIED") {
      emailsAttempted++;

      // Concurrency claim
      const claimed = await claimAlertForDispatch(alertId);
      if (!claimed) {
        evaluationStatus = "SUPPRESSED";
        suppressionReason = "Alert already claimed by another evaluator instance";
        emailsSuppressed++;
      } else {
        const mailResult = await sendNotificationEmail({
          alertId,
          businessId: options.businessId,
          to: user.email,
          recipientName: user.name || "Finance Leader",
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });

        finalDeliveryStatus = mailResult.status;
        if (mailResult.status === "SENT" || mailResult.status === "ACCEPTED" || mailResult.status === "SIMULATED") {
          evaluationStatus = "SENT";
          emailsSent++;
          await updateAlertDelivery(alertId, {
            sentAt: nowIso,
            deliveryStatus: mailResult.status,
            provider: mailResult.provider,
            providerMessageId: mailResult.providerMessageId,
          });
        } else {
          evaluationStatus = "SEND_FAILED";
          await updateAlertDelivery(alertId, {
            deliveryStatus: "FAILED",
            provider: mailResult.provider,
            suppressionReason: mailResult.error,
          });
        }
      }
    } else {
      emailsSuppressed++;
    }

    evaluatedRecipients.push({
      userId: user.id,
      email: user.email,
      status: evaluationStatus,
      suppressionReason,
      alertId,
      deliveryStatus: finalDeliveryStatus,
    });
    } catch (err) {
      // Suppressed, not sent, and recorded as such. The next scheduled
      // evaluation retries; nothing here is lost, and no email is duplicated.
      emailsSuppressed++;
      logger.error("Recipient evaluation failed; suppressing this recipient", {
        businessId: options.businessId,
        userId: user.id,
        crisisKey: assessment.crisisKey,
        error: String(err),
      });
      evaluatedRecipients.push({
        userId: user.id,
        email: user.email,
        status: "SEND_FAILED",
        suppressionReason: `Evaluation failed: ${String(err)}`,
        alertId,
        deliveryStatus: "FAILED",
      });
    }
  }

  const overallStatus: AlertEvaluationStatus = emailsSent > 0
    ? "SENT"
    : emailsSuppressed === evaluatedRecipients.length
    ? "SUPPRESSED"
    : "QUALIFIED";

  logger.info("Notification alert evaluation completed", {
    businessId: options.businessId,
    severity: assessment.severity,
    crisisKey: assessment.crisisKey,
    recipientsCount: users.length,
    emailsSent,
    emailsSuppressed,
  });

  return {
    businessId: options.businessId,
    businessName: assessment.businessName,
    assessedAt: nowIso,
    healthAssessment: assessment,
    evaluationStatus: overallStatus,
    evaluatedRecipients,
    crisisKey: assessment.crisisKey,
    emailsAttempted,
    emailsSent,
    emailsSuppressed,
  };
}
