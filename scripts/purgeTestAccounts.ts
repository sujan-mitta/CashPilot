/**
 * Remove the leftover test accounts from the database.
 *
 * WHY THIS IS A SCRIPT AND NOT A ONE-LINER
 *
 * Eight accounts accumulated across development, most of them on addresses that
 * cannot receive mail — @company.com, @example.test, @cashpilot.local. Those
 * were the bounce source: the alert dispatcher mailed every one of them each
 * cycle, and every bounce came back to the operator.
 *
 * They are already harmless (unverified means suppressed), so this is tidiness
 * rather than a fix. That is exactly why it should not be done carelessly.
 *
 * WHAT IT REFUSES TO DO
 *
 * A business in this schema is reachable only through its members. Delete every
 * member and the business still exists, with its ledger intact, and nobody can
 * ever sign in to see it again — there is no "join an existing business" path,
 * because signup deliberately refuses to attach a new account to a business it
 * did not create.
 *
 * ABC Electronics Pvt Ltd has three members and ALL THREE are on undeliverable
 * addresses. Removing them all would strand its 7 transactions, 2 invoices and
 * 2 payouts permanently. So one member is kept as an anchor, and the script
 * refuses to run if the KEEP list would leave that business empty.
 *
 * USAGE
 *
 *   npx tsx scripts/purgeTestAccounts.ts              # dry run, changes nothing
 *   npx tsx scripts/purgeTestAccounts.ts --confirm     # actually deletes
 *
 * A JSON backup of every user and business is written before anything is
 * removed, so a mistake is recoverable.
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "../src/lib/prisma";

/**
 * Accounts to keep.
 *
 * `mittal@company.com` is here because it is the last member of the primary
 * demo ledger, not because the address works — it does not. Once a real
 * verified account has been connected to ABC Electronics Pvt Ltd, this entry
 * can be removed and the script re-run.
 */
const KEEP = ["mittal@company.com"];

const CONFIRMED = process.argv.includes("--confirm");

async function main() {
  const users = await prisma.user.findMany({
    include: { businesses: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });

  const keep = users.filter((u) => KEEP.includes(u.email));
  const doomed = users.filter((u) => !KEEP.includes(u.email));

  // Safety gate: would any business lose its last member?
  const survivingMemberIds = new Set(keep.map((u) => u.id));
  const businesses = await prisma.business.findMany({
    include: { users: { select: { id: true } }, _count: { select: { transactions: true, invoices: true, payouts: true } } },
  });

  // The gate distinguishes a SHARED ledger from a single-owner sandbox.
  //
  // A business several accounts belong to is collaborative: someone set it up
  // deliberately and more than one person was given access, so stranding it
  // destroys something nobody asked to lose. ABC Electronics Pvt Ltd is that
  // case, with three members.
  //
  // A business with exactly one member is that member's own sandbox. Discarding
  // it along with its owner is the intended outcome of a cleanup, not an
  // accident — every one of these was created by an automated test run or a
  // one-off UX check, and its "data" is seeded demo rows.
  const stranded = businesses.filter((b) => {
    const hasData = b._count.transactions + b._count.invoices + b._count.payouts > 0;
    const shared = b.users.length > 1;
    const keepsOne = b.users.some((u) => survivingMemberIds.has(u.id));
    return hasData && shared && !keepsOne;
  });

  const discarded = businesses.filter(
    (b) => b.users.length === 1 && !b.users.some((u) => survivingMemberIds.has(u.id))
  );

  console.log(`accounts found:    ${users.length}`);
  console.log(`keeping:           ${keep.map((u) => u.email).join(", ") || "(none)"}`);
  console.log(`would delete:      ${doomed.length}`);
  for (const u of doomed) {
    const where = u.businesses.map((b) => b.name).join(", ") || "(no business)";
    console.log(`   - ${u.email}   [${where}]`);
  }

  if (discarded.length > 0) {
    console.log(`
single-owner sandboxes discarded with their owner: ${discarded.length}`);
    for (const b of discarded) console.log(`   - "${b.name}"`);
  }

  if (stranded.length > 0) {
    console.error("\nREFUSING TO RUN. These businesses hold data and would be left with no");
    console.error("members, making them permanently unreachable:");
    for (const b of stranded) {
      console.error(
        `   - "${b.name}"  tx=${b._count.transactions} inv=${b._count.invoices} pay=${b._count.payouts}`
      );
    }
    console.error("\nAdd one of their members to KEEP, or connect a real account first.");
    process.exit(1);
  }

  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing was changed. Re-run with --confirm to apply.");
    return;
  }

  // Written to the OS temp directory, never the repo. This file contains every
  // account's email and password hash; a stray commit of it would be worse than
  // the mess it is cleaning up.
  const backupPath = join(tmpdir(), `cashpilot-account-backup-${Date.now()}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify({ takenAt: new Date().toISOString(), users, businesses }, null, 2)
  );
  console.log(`\nbackup written: ${backupPath}`);

  for (const u of doomed) {
    // These key off userId as a plain column with no foreign key, so they are
    // cleared explicitly rather than relying on a cascade that does not exist.
    // Leaving them keeps an alert history pointing at an account that is gone.
    await prisma.notificationPreference.deleteMany({ where: { userId: u.id } });
    await prisma.userActivityRecord.deleteMany({ where: { userId: u.id } });
    await prisma.notificationAlertRecord.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
    console.log(`  removed ${u.email}`);
  }

  const left = await prisma.user.findMany({
    select: { email: true, emailVerified: true, businesses: { select: { name: true } } },
  });
  console.log("\nremaining accounts:");
  for (const u of left) {
    console.log(
      `  ${u.email}  verified=${u.emailVerified ? "yes" : "no"}  -> ${
        u.businesses.map((b) => b.name).join(", ") || "(none)"
      }`
    );
  }

  const orphaned = await prisma.business.count({ where: { users: { none: {} } } });
  console.log(`\nbusinesses with no members (inert, retained): ${orphaned}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
