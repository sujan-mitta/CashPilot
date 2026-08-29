/**
 * Types and interfaces for CashPilot Intelligent Email Alert and Notification System.
 */

export type AlertSeverity = "CRITICAL" | "WARNING" | "HEALTHY";

export type CrisisType =
  | "DEFICIT"
  | "RUNWAY_LT_14"
  | "OBLIGATION_RISK"
  | "SAFETY_BUFFER_BREACH"
  | "HEALTHY";

export type AlertEvaluationStatus =
  | "QUALIFIED"
  | "SUPPRESSED"
  | "COOLDOWN"
  | "ALREADY_VIEWED"
  | "ACTIVE_USER"
  | "PREFERENCE_DISABLED"
  | "INSUFFICIENT_CONFIDENCE"
  | "SEND_FAILED"
  | "SENT";

export type DeliveryStatus =
  | "SIMULATED"
  | "ACCEPTED"
  | "SENT"
  | "FAILED"
  | "SUPPRESSED";

export interface RootCauseItem {
  type: "OVERDUE_INVOICE" | "PENDING_PAYOUT" | "NEGATIVE_CASHFLOW" | "SAFETY_BUFFER_DIP";
  title: string;
  amount?: number; // in paise
  dueDate?: string;
  description: string;
  counterpartyName?: string;
}

export interface RecommendedStrategySummary {
  id: string;
  title: string;
  actionCount: number;
  expectedRunwayChangeDays: number;
  expectedDeficitReductionPaise: number;
  requiresApproval: boolean;
}

export interface HealthAssessment {
  businessId: string;
  businessName: string;
  severity: AlertSeverity;
  crisisType: CrisisType;
  crisisKey: string | null;
  currentBalance: number; // in paise
  safetyBuffer: number; // in paise
  runwayDays: number;
  projectedDeficitDate: string | null;
  firstBelowSafetyDate: string | null;
  rootCauses: RootCauseItem[];
  criticalObligations: {
    count: number;
    amount: number;
    protected: boolean;
  };
  recommendedStrategy?: RecommendedStrategySummary | null;
  assessedAt: string;
  confidenceScore: number;
}

export interface NotificationPreferences {
  criticalAlertsEnabled: boolean;
  warningAlertsEnabled: boolean;
  weeklyDigestEnabled: boolean;
  criticalCooldownHours: number; // default 72, min 24, max 168
  warningCooldownHours: number; // default 168, min 48, max 336
  offlineThresholdMinutes: number; // default 30, min 15, max 120
  recipientEmail?: string;
}

export interface UserActivity {
  userId: string;
  businessId: string;
  userEmail: string;
  userName: string;
  lastSeenAt: string;
  lastDashboardViewAt: string;
  lastActivityAt: string;
  lastViewedCrisisKey?: string | null;
  lastViewedCrisisAt?: string | null;
}

export interface AlertRecord {
  alertId: string;
  tenantId: string;
  businessId: string;
  businessName: string;
  userId: string;
  userEmail: string;
  severity: AlertSeverity;
  crisisKey: string;
  crisisTitle: string;
  occurredAt: string;
  detectedAt: string;
  viewedAt?: string | null;
  emailEligibleAt?: string | null;
  sentAt?: string | null;
  deliveryStatus: DeliveryStatus;
  suppressionReason?: string | null;
  provider?: "SMTP" | "RESEND" | "LOCAL_SANDBOX";
  providerMessageId?: string | null;
  healthAssessment?: HealthAssessment | null;
  renderedSubject?: string;
}

export interface DeliveryAuditRecord {
  auditId: string;
  alertId: string;
  businessId: string;
  recipientEmail: string;
  provider: "SMTP" | "RESEND" | "LOCAL_SANDBOX";
  attemptedAt: string;
  status: "SIMULATED" | "ACCEPTED" | "SENT" | "FAILED";
  providerMessageId?: string;
  errorCode?: string;
  errorMessageSanitized?: string;
}

export interface AlertEvaluationResult {
  businessId: string;
  businessName: string;
  assessedAt: string;
  healthAssessment: HealthAssessment;
  evaluationStatus: AlertEvaluationStatus;
  evaluatedRecipients: Array<{
    userId: string;
    email: string;
    status: AlertEvaluationStatus;
    suppressionReason?: string;
    alertId?: string;
    deliveryStatus?: DeliveryStatus;
  }>;
  crisisKey: string | null;
  emailsAttempted: number;
  emailsSent: number;
  emailsSuppressed: number;
}
