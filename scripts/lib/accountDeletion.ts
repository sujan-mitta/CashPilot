import { prisma } from "../../src/lib/prisma";

/**
 * Removing an account and everything that belonged to it.
 *
 * WHY THIS IS ONE FUNCTION AND NOT A SEQUENCE OF QUERIES
 *
 * Deleting a user is the easy half. The hard half is that a business is
 * reachable ONLY through its members, so removing the last one leaves a ledger
 * nobody can open — data still present, still holding its name, and impossible
 * to act on. Every deletion done ad hoc has left some of that behind, and each
 * time the leftovers were found afterwards rather than prevented.
 *
 * Business children have no onDelete: Cascade in the schema and roughly twenty
 * tables carry a businessId, several referencing each other — Evidence to
 * Claim, DecisionEvent to Decision, PaymentRecovery to Transaction, AgentAction
 * to Strategy. The order below is dependents-first and is not arbitrary. A
 * missed table surfaces as a foreign-key error rather than silent corruption,
 * which is the right way for this to fail.
 *
 * WHAT IT WILL NOT TOUCH
 *
 * A business with other members. That is somebody else's ledger, and the
 * departing user's membership is removed instead. Deleting shared data because
 * one member left would destroy work nobody asked to lose.
 */

export interface DeletionSummary {
  email: string;
  businessesDeleted: string[];
  businessesLeftAlone: string[];
  rowsDeleted: Record<string, number>;
}

/**
 * Re-exported so callers have one import, while the list itself lives in a file
 * with no dependencies — see businessChildTables.ts for why that matters.
 */
export { BUSINESS_CHILD_TABLES } from "./businessChildTables";

async function deleteBusinessCascade(
  businessId: string,
  tally: Record<string, number>
): Promise<void> {
  const add = (table: string, result: { count: number }) => {
    if (result.count > 0) tally[table] = (tally[table] ?? 0) + result.count;
  };

  add("evidence", await prisma.evidence.deleteMany({ where: { businessId } }));
  add("claim", await prisma.claim.deleteMany({ where: { businessId } }));
  add("decisionEvent", await prisma.decisionEvent.deleteMany({ where: { businessId } }));
  add("decision", await prisma.decision.deleteMany({ where: { businessId } }));
  add("executionIntent", await prisma.executionIntent.deleteMany({ where: { businessId } }));
  add("webhookDeliveryAttempt", await prisma.webhookDeliveryAttempt.deleteMany({ where: { businessId } }));
  add("financialEvent", await prisma.financialEvent.deleteMany({ where: { businessId } }));
  add("financialState", await prisma.financialState.deleteMany({ where: { businessId } }));

  // These reach the business through a parent rather than a column of their own.
  add("paymentRecovery", await prisma.paymentRecovery.deleteMany({ where: { transaction: { businessId } } }));
  add("agentAction", await prisma.agentAction.deleteMany({ where: { strategy: { businessId } } }));

  add("strategy", await prisma.strategy.deleteMany({ where: { businessId } }));
  add("cashForecast", await prisma.cashForecast.deleteMany({ where: { businessId } }));

  // Precede Counterparty, which they reference.
  add("transaction", await prisma.transaction.deleteMany({ where: { businessId } }));
  add("invoice", await prisma.invoice.deleteMany({ where: { businessId } }));
  add("payout", await prisma.payout.deleteMany({ where: { businessId } }));

  add("counterpartyAlias", await prisma.counterpartyAlias.deleteMany({ where: { businessId } }));
  add("counterparty", await prisma.counterparty.deleteMany({ where: { businessId } }));

  add("notificationDeliveryAudit", await prisma.notificationDeliveryAudit.deleteMany({ where: { businessId } }));
  add("notificationAlertRecord", await prisma.notificationAlertRecord.deleteMany({ where: { businessId } }));
  add("notificationPreference", await prisma.notificationPreference.deleteMany({ where: { businessId } }));
  add("userActivityRecord", await prisma.userActivityRecord.deleteMany({ where: { businessId } }));

  // RazorpayConnection and EmailVerificationCode cascade in the schema; the
  // business row goes last, once nothing points at it any more.
  add("business", { count: 1 });
  await prisma.business.delete({ where: { id: businessId } });
}

/**
 * Delete an account and everything that was only ever reachable through it.
 *
 * Returns what was removed, so a caller can report it rather than assert it.
 */
export async function deleteAccountCompletely(email: string): Promise<DeletionSummary | null> {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { businesses: { include: { _count: { select: { users: true } } } } },
  });
  if (!user) return null;

  const rowsDeleted: Record<string, number> = {};
  const businessesDeleted: string[] = [];
  const businessesLeftAlone: string[] = [];

  for (const business of user.businesses) {
    if (business._count.users > 1) {
      // Shared. Somebody else still works here.
      businessesLeftAlone.push(business.name);
      continue;
    }
    await deleteBusinessCascade(business.id, rowsDeleted);
    businessesDeleted.push(business.name);
  }

  // User-scoped rows that carry a plain userId with no foreign key, so nothing
  // removes them on their own. Repeated after the business sweep because a user
  // can hold rows for a business they were not the last member of.
  const addUser = (table: string, result: { count: number }) => {
    if (result.count > 0) rowsDeleted[table] = (rowsDeleted[table] ?? 0) + result.count;
  };
  addUser("notificationPreference", await prisma.notificationPreference.deleteMany({ where: { userId: user.id } }));
  addUser("userActivityRecord", await prisma.userActivityRecord.deleteMany({ where: { userId: user.id } }));
  addUser("notificationAlertRecord", await prisma.notificationAlertRecord.deleteMany({ where: { userId: user.id } }));

  // EmailVerificationCode cascades from the user.
  await prisma.user.delete({ where: { id: user.id } });
  rowsDeleted.user = 1;

  return { email, businessesDeleted, businessesLeftAlone, rowsDeleted };
}
