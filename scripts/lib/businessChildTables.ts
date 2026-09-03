/**
 * Every table hanging off a business, in the order they must be cleared.
 *
 * DATA, NOT BEHAVIOUR, AND DELIBERATELY IN ITS OWN FILE
 *
 * The deletion logic needs a database client; this list does not. Keeping them
 * together meant importing the order pulled Prisma in, so the test that checks
 * the list against the schema could not run without a live DATABASE_URL — the
 * third time in this codebase that a static import has dragged the database
 * into something that had no business touching it.
 *
 * THE ORDER IS LOAD-BEARING
 *
 * Business children have no onDelete: Cascade, and several reference each other:
 * Evidence to Claim, DecisionEvent to Decision, PaymentRecovery to Transaction,
 * AgentAction to Strategy, and Transaction/Invoice/Payout to Counterparty.
 * Dependents come first. Get it wrong and the database refuses with a foreign
 * key error, which is the right way for this to fail — loudly, rather than by
 * leaving rows behind.
 */
export const BUSINESS_CHILD_TABLES = [
  "evidence",
  "claim",
  "decisionEvent",
  "decision",
  "executionIntent",
  "webhookDeliveryAttempt",
  "financialEvent",
  "financialState",
  "paymentRecovery",
  "agentAction",
  "strategy",
  "cashForecast",
  "transaction",
  "invoice",
  "payout",
  "counterpartyAlias",
  "counterparty",
  "notificationDeliveryAudit",
  "notificationAlertRecord",
  "notificationPreference",
  "userActivityRecord",
] as const;
