/**
 * Delete an account and everything that belonged to it.
 *
 * WHY THIS EXISTS RATHER THAN A HANDFUL OF QUERIES
 *
 * Every ad-hoc deletion in this project left something behind, and the
 * leftovers were found afterwards rather than prevented: a user removed while
 * their business stayed, unreachable but still holding its name; a business
 * removed while roughly twenty child tables kept pointing at it.
 *
 * So this does the whole thing, and then CHECKS ITSELF — it re-queries every
 * table that references a business or a user and reports anything still
 * pointing at something that no longer exists. A deletion that claims success
 * while leaving rows behind is worse than one that fails loudly.
 *
 * WHAT IT REFUSES
 *
 * A business with other members is left alone and the departing user's
 * membership removed instead. That is somebody else's ledger; deleting shared
 * work because one person left destroys what nobody asked to lose.
 *
 * USAGE
 *
 *   npx tsx scripts/deleteAccount.ts someone@example.com            # dry run
 *   npx tsx scripts/deleteAccount.ts someone@example.com --confirm  # apply
 *
 * A JSON backup is written to the OS temp directory before anything is removed.
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "../src/lib/prisma";
import { deleteAccountCompletely } from "./lib/accountDeletion";

const args = process.argv.slice(2);
const CONFIRMED = args.includes("--confirm");
const EMAIL = args.find((a) => !a.startsWith("--"));

/**
 * Rows pointing at a business or user that no longer exists.
 *
 * Run after every deletion. The whole point of this script is that nothing is
 * left behind, and the only way to say that honestly is to look.
 */
async function findDanglingRows(): Promise<Record<string, number>> {
  const liveBiz = (await prisma.business.findMany({ select: { id: true } })).map((b) => b.id);
  const liveUsers = (await prisma.user.findMany({ select: { id: true } })).map((u) => u.id);

  // An empty list is not a special case to guard against. When the last account
  // goes, `notIn: []` is always true and every remaining row that names a
  // business IS dangling, which is exactly the answer wanted.

  const found: Record<string, number> = {};
  const check = async (name: string, fn: () => Promise<number>) => {
    const n = await fn();
    if (n > 0) found[name] = n;
  };

  await check("transaction", () => prisma.transaction.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("invoice", () => prisma.invoice.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("payout", () => prisma.payout.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("cashForecast", () => prisma.cashForecast.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("strategy", () => prisma.strategy.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("decision", () => prisma.decision.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("decisionEvent", () => prisma.decisionEvent.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("executionIntent", () => prisma.executionIntent.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("financialEvent", () => prisma.financialEvent.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("financialState", () => prisma.financialState.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("claim", () => prisma.claim.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("evidence", () => prisma.evidence.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("counterparty", () => prisma.counterparty.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("counterpartyAlias", () => prisma.counterpartyAlias.count({ where: { businessId: { notIn: liveBiz } } }));
  // `not: null` matters, and only here.
  //
  // WebhookDeliveryAttempt is the one table whose businessId is nullable, on
  // purpose: a delivery rejected for a bad signature or an unknown token has no
  // business to attribute it to, and the row is the audit trail of that
  // rejection. Those rows reference nothing, so they cannot dangle — but
  // `notIn` matched them anyway and the script reported "LEFTOVERS FOUND - this
  // is a bug in the deletion order" over a deletion that was completely clean.
  //
  // Observed: deleting the last account left 50 of them, every one with a NULL
  // businessId, and the script exited non-zero. A verifier that cries wolf is
  // worse than none, because the real leftover it exists to catch would be read
  // as the same false alarm and waved through.
  await check("webhookDeliveryAttempt", () =>
    prisma.webhookDeliveryAttempt.count({ where: { businessId: { not: null, notIn: liveBiz } } })
  );
  await check("notificationPreference", () => prisma.notificationPreference.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("notificationAlertRecord", () => prisma.notificationAlertRecord.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("notificationDeliveryAudit", () => prisma.notificationDeliveryAudit.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("userActivityRecord", () => prisma.userActivityRecord.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("razorpayConnection", () => prisma.razorpayConnection.count({ where: { businessId: { notIn: liveBiz } } }));
  await check("emailVerificationCode", () => prisma.emailVerificationCode.count({ where: { userId: { notIn: liveUsers } } }));

  // Reached through a parent rather than a column of their own.
  await check("agentAction", () => prisma.agentAction.count({ where: { strategy: { businessId: { notIn: liveBiz } } } }));
  await check("paymentRecovery", () => prisma.paymentRecovery.count({ where: { transaction: { businessId: { notIn: liveBiz } } } }));

  // A business nobody can reach is not "left behind" in the same sense, but it
  // is exactly what earlier deletions kept producing, so it is reported too.
  await check("business (no members)", () => prisma.business.count({ where: { users: { none: {} } } }));

  return found;
}

async function main() {
  if (!EMAIL) {
    console.error("Give an email address. See the header for usage.");
    process.exit(1);
  }

  const user = await prisma.user.findUnique({
    where: { email: EMAIL },
    include: {
      businesses: {
        include: {
          _count: { select: { users: true, transactions: true, invoices: true, payouts: true } },
        },
      },
    },
  });

  if (!user) {
    console.log(`no account for ${EMAIL} — nothing to do`);
    return;
  }

  console.log(`account: ${user.email}`);
  for (const b of user.businesses) {
    const shared = b._count.users > 1;
    console.log(
      `  business "${b.name}"  members=${b._count.users} tx=${b._count.transactions} inv=${b._count.invoices} pay=${b._count.payouts}` +
        (shared ? "   -> KEPT (shared with others)" : "   -> will be deleted with all its data")
    );
  }

  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing was changed. Re-run with --confirm to apply.");
    return;
  }

  const backupPath = join(tmpdir(), `cashpilot-account-${Date.now()}.json`);
  writeFileSync(backupPath, JSON.stringify({ takenAt: new Date().toISOString(), user }, null, 2));
  console.log(`\nbackup written: ${backupPath}`);

  const summary = await deleteAccountCompletely(EMAIL);
  if (!summary) {
    console.log("account vanished between the check and the delete — nothing done");
    return;
  }

  console.log("\nremoved:");
  for (const [table, count] of Object.entries(summary.rowsDeleted)) {
    console.log(`  ${table.padEnd(28)} ${count}`);
  }
  if (summary.businessesLeftAlone.length > 0) {
    console.log(`\nkept (shared with other members): ${summary.businessesLeftAlone.join(", ")}`);
  }

  // The claim is only worth making if it was checked.
  const dangling = await findDanglingRows();
  if (Object.keys(dangling).length === 0) {
    console.log("\nverified: no rows anywhere reference a deleted business or user");
  } else {
    console.error("\nLEFTOVERS FOUND — this is a bug in the deletion order:");
    for (const [table, count] of Object.entries(dangling)) {
      console.error(`  ${table.padEnd(28)} ${count}`);
    }
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
