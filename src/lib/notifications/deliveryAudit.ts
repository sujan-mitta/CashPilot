/**
 * Delivery audit logger for email notifications.
 *
 * Ensures all email send attempts, provider responses, and failures are recorded
 * with sanitization to guarantee no secrets, credentials, or sensitive headers leak.
 */

import { logger } from "@/lib/observability";
import type { DeliveryAuditRecord } from "./types";

/**
 * Sanitizes error messages by redacting potential keys, tokens, or passwords.
 */
export function sanitizeErrorMessage(err: unknown): string {
  if (!err) return "Unknown error";
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/(key|token|secret|password|auth|bearer)[\s:=]+([^\s,;]+)/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

/**
 * Records an auditable delivery attempt.
 */
export function logDeliveryAudit(record: DeliveryAuditRecord): void {
  const isSuccess = record.status === "SENT" || record.status === "ACCEPTED" || record.status === "SIMULATED";

  if (isSuccess) {
    logger.info("Notification email delivered", {
      auditId: record.auditId,
      alertId: record.alertId,
      businessId: record.businessId,
      recipientEmailDomain: record.recipientEmail.split("@")[1] ?? "unknown",
      provider: record.provider,
      status: record.status,
      providerMessageId: record.providerMessageId,
      attemptedAt: record.attemptedAt,
    });
  } else {
    logger.warn("Notification email delivery failed", {
      auditId: record.auditId,
      alertId: record.alertId,
      businessId: record.businessId,
      recipientEmailDomain: record.recipientEmail.split("@")[1] ?? "unknown",
      provider: record.provider,
      status: record.status,
      errorCode: record.errorCode,
      errorMessage: record.errorMessageSanitized,
      attemptedAt: record.attemptedAt,
    });
  }
}
