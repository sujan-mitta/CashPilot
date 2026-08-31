/**
 * Mailer service for dispatching alert notifications.
 *
 * Supports:
 * - SMTP (via standard nodemailer if available)
 * - Resend API (if RESEND_API_KEY is configured)
 * - Local / Test Sandbox (default when credentials are not configured)
 */

import { logger } from "@/lib/observability";
import { logDeliveryAudit, sanitizeErrorMessage } from "./deliveryAudit";
import type { DeliveryAuditRecord, DeliveryStatus } from "./types";
import crypto from "crypto";
import nodemailer from "nodemailer";

export interface SendMailOptions {
  alertId: string;
  businessId: string;
  to: string;
  recipientName: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailerResult {
  status: DeliveryStatus;
  provider: "SMTP" | "RESEND" | "LOCAL_SANDBOX";
  providerMessageId?: string;
  error?: string;
  auditRecord: DeliveryAuditRecord;
}

/**
 * Checks which email provider is available from the environment.
 */
export function resolveMailerProvider(): "SMTP" | "RESEND" | "LOCAL_SANDBOX" {
  if (process.env.RESEND_API_KEY) {
    return "RESEND";
  }
  // SMTP_PASSWORD is required here because the transport AUTHENTICATES with it.
  //
  // Checking only host and user let a half-configured deployment select SMTP
  // and then fail at authentication on every send — the provider was chosen on
  // credentials it never verified it had. That failure is invisible in the
  // right way to be dangerous: the mailer reports FAILED, verification codes
  // never arrive, and the deployment looks configured.
  //
  // Falling through to the sandbox instead is strictly better. The sandbox is a
  // state the rest of the system understands: verificationCanBeRequired() sees
  // it, stands the sign-in gate down, and nobody is stranded behind a code that
  // cannot be sent.
  if (
    process.env.SMTP_HOST?.trim() &&
    process.env.SMTP_USER?.trim() &&
    process.env.SMTP_PASSWORD?.trim()
  ) {
    return "SMTP";
  }
  return "LOCAL_SANDBOX";
}

/**
 * Dispatches an email using the configured provider or simulated sandbox.
 */
export async function sendNotificationEmail(options: SendMailOptions): Promise<MailerResult> {
  const provider = resolveMailerProvider();
  const now = new Date().toISOString();
  const auditId = `audit_${crypto.randomUUID()}`;

  // 1. Resend Provider
  if (provider === "RESEND") {
    try {
      const fromEmail = process.env.EMAIL_FROM || "CashPilot Alerts <alerts@cashpilot.ai>";
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [options.to],
          subject: options.subject,
          html: options.html,
          text: options.text,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Resend API returned ${res.status}: ${errText}`);
      }

      const resData = (await res.json()) as { id?: string };
      const messageId = resData.id || `resend_${Date.now()}`;

      const audit: DeliveryAuditRecord = {
        auditId,
        alertId: options.alertId,
        businessId: options.businessId,
        recipientEmail: options.to,
        provider: "RESEND",
        attemptedAt: now,
        status: "ACCEPTED",
        providerMessageId: messageId,
      };

      logDeliveryAudit(audit);
      return { status: "ACCEPTED", provider: "RESEND", providerMessageId: messageId, auditRecord: audit };
    } catch (err) {
      const sanitized = sanitizeErrorMessage(err);
      const audit: DeliveryAuditRecord = {
        auditId,
        alertId: options.alertId,
        businessId: options.businessId,
        recipientEmail: options.to,
        provider: "RESEND",
        attemptedAt: now,
        status: "FAILED",
        errorCode: "RESEND_DISPATCH_ERROR",
        errorMessageSanitized: sanitized,
      };

      logDeliveryAudit(audit);
      return { status: "FAILED", provider: "RESEND", error: sanitized, auditRecord: audit };
    }
  }

  // 2. SMTP Provider
  if (provider === "SMTP") {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === "true",
        connectionTimeout: 10000,
        socketTimeout: 15000,
        greetingTimeout: 10000,
        auth: {
          user: process.env.SMTP_USER?.trim(),
          // Trimmed because this value is normally pasted into a deployment
          // provider's web field, where a trailing space survives invisibly and
          // fails authentication with an error that says nothing about
          // whitespace. Only the ends: a password may legitimately contain
          // spaces, and a Gmail app password is displayed in four groups that
          // people paste as-is.
          pass: process.env.SMTP_PASSWORD?.trim(),
        },
      });

      const info = await transporter.sendMail({
        from: process.env.EMAIL_FROM || '"CashPilot Alerts" <alerts@cashpilot.ai>',
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      });

      const messageId = info.messageId || `smtp_${Date.now()}`;
      const audit: DeliveryAuditRecord = {
        auditId,
        alertId: options.alertId,
        businessId: options.businessId,
        recipientEmail: options.to,
        provider: "SMTP",
        attemptedAt: now,
        status: "SENT",
        providerMessageId: messageId,
      };

      logDeliveryAudit(audit);
      return { status: "SENT", provider: "SMTP", providerMessageId: messageId, auditRecord: audit };
    } catch (err) {
      const sanitized = sanitizeErrorMessage(err);
      const audit: DeliveryAuditRecord = {
        auditId,
        alertId: options.alertId,
        businessId: options.businessId,
        recipientEmail: options.to,
        provider: "SMTP",
        attemptedAt: now,
        status: "FAILED",
        errorCode: "SMTP_DISPATCH_ERROR",
        errorMessageSanitized: sanitized,
      };

      logDeliveryAudit(audit);
      return { status: "FAILED", provider: "SMTP", error: sanitized, auditRecord: audit };
    }
  }

  // 3. Local Sandbox (Simulated mode with structured logging)
  const simulatedMessageId = `sim_${crypto.randomUUID()}`;
  logger.info("Alert email dispatched in LOCAL_SANDBOX mode", {
    alertId: options.alertId,
    businessId: options.businessId,
    recipientEmailDomain: options.to.split("@")[1] ?? "unknown",
    subject: options.subject,
    providerMessageId: simulatedMessageId,
  });

  const audit: DeliveryAuditRecord = {
    auditId,
    alertId: options.alertId,
    businessId: options.businessId,
    recipientEmail: options.to,
    provider: "LOCAL_SANDBOX",
    attemptedAt: now,
    status: "SIMULATED",
    providerMessageId: simulatedMessageId,
  };

  logDeliveryAudit(audit);
  return {
    status: "SIMULATED",
    provider: "LOCAL_SANDBOX",
    providerMessageId: simulatedMessageId,
    auditRecord: audit,
  };
}
