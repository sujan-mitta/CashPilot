/**
 * Delete a business and everything hanging off it.
 *
 * WHY THIS IS NEEDED
 *
 * Removing a user does not remove their business, and a business with no
 * members is not harmless. It is unreachable — there is no "join an existing
 * business" path — but it still HOLDS ITS NAME, and signup rejects any new
 * business whose name collides case-insensitively. So a deleted account leaves
 * behind a tombstone that permanently blocks its own name from ever being
 * registered again, by anyone, including the person who just deleted it.
 *
 * That was observed directly: deleting a test account and immediately trying to
 * re-register the same business name was refused, by a business nobody could
 * reach.
 *
 * WHY IT IS A LONG EXPLICIT LIST
 *
 * Business children have no onDelete: Cascade in the schema, and roughly twenty
 * tables carry a businessId. Several also reference each other — Evidence to
 * Claim, DecisionEvent to Decision, Invoice to Counterparty — so the order
 * below is dependents-first and is not arbitrary. A missed table surfaces as a
 * foreign-key error rather than silent corruption, which is the right failure.
 *
 * USAGE
 *
 *   npx tsx scripts/deleteBusiness.ts "Exact Name"            # dry run
 *   npx tsx scripts/deleteBusiness.ts "Exact Name" --confirm  # apply
 *   npx tsx scripts/deleteBusiness.ts --orphans               # dry run, all member-less
 *   npx tsx scripts/deleteBusiness.ts --orphans --confirm
 *
 * It refuses to touch a business that still has members: that is a live tenant,
 * and this tool is for tombstones.
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";

const args = process.argv.slice(2);
const CONFIRMED = args.includes("--confirm");
const ORPHANS_ONLY = args.includes("--orphans");
const NAME = args.find((a) => !a.startsWith("--"));

/**
 * Dependents before parents. Each entry is a table and how it points at the
 * business; the ones taking `id` are reached through a parent's ids.
 */
async function deleteBusinessCascade(businessId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const record = (table: string, result: { count: number }) => {
    if (result.count > 0) counts[table] = result.count;
  };

  // Evidence hangs off Claim, so it goes first.
  record("evidence", await prisma.evidence.deleteMany({ where: { businessId } }));
  record("claim", await prisma.claim.deleteMany({ where: { businessId } }));

  // DecisionEvent hangs off Decision.
  record("decisionEvent", await prisma.decisionEvent.deleteMany({ where: { businessId } }));
  record("decision", await prisma.decision.deleteMany({ where: { businessId } }));

  record("executionIntent", await prisma.executionIntent.deleteMany({ where: { businessId } }));
  record(
    "webhookDeliveryAttempt",
    await prisma.webhookDeliveryAttempt.deleteMany({ where: { businessId } })
  );
  record("financialEvent", await prisma.financialEvent.deleteMany({ where: { businessId } }));
  record("financialState", await prisma.financialState.deleteMany({ where: { businessId } }));
  // PaymentRecovery hangs off Transaction, and AgentAction off Strategy —
  // neither carries a businessId of its own, so they are reached through their
  // parent and must be cleared before it.
  record(
    "paymentRecovery",
    await prisma.paymentRecovery.deleteMany({ where: { transaction: { businessId } } })
  );
  record(
    "agentAction",
    await prisma.agentAction.deleteMany({ where: { strategy: { businessId } } })
  );
  record("strategy", await prisma.strategy.deleteMany({ where: { businessId } }));
  record("cashForecast", await prisma.cashForecast.deleteMany({ where: { businessId } }));

  // These may reference a Counterparty, so they precede it.
  record("transaction", await prisma.transaction.deleteMany({ where: { businessId } }));
  record("invoice", await prisma.invoice.deleteMany({ where: { businessId } }));
  record("payout", await prisma.payout.deleteMany({ where: { businessId } }));

  record("counterpartyAlias", await prisma.counterpartyAlias.deleteMany({ where: { businessId } }));
  record("counterparty", await prisma.counterparty.deleteMany({ where: { businessId } }));

  record(
    "notificationDeliveryAudit",
    await prisma.notificationDeliveryAudit.deleteMany({ where: { businessId } })
  );
  record(
    "notificationAlertRecord",
    await prisma.notificationAlertRecord.deleteMany({ where: { businessId } })
  );
  record(
    "notificationPreference",
    await prisma.notificationPreference.deleteMany({ where: { businessId } })
  );
  record("userActivityRecord", await prisma.userActivityRecord.deleteMany({ where: { businessId } }));

  await prisma.business.delete({ where: { id: businessId } });
  return counts;
}

async function main() {
  if (!NAME && !ORPHANS_ONLY) {
    console.error('Give a business name, or --orphans. See the header for usage.');
    process.exit(1);
  }

  const targets = ORPHANS_ONLY
    ? await prisma.business.findMany({
        where: { users: { none: {} } },
        include: { users: { select: { id: true } } },
      })
    : await prisma.business.findMany({
        where: { name: { equals: NAME!, mode: "insensitive" } },
        include: { users: { select: { id: true } } },
      });

  if (targets.length === 0) {
    console.log("nothing matched — nothing to do");
    return;
  }

  const live = targets.filter((b) => b.users.length > 0);
  if (live.length > 0) {
    console.error("REFUSING: these still have members and are live tenants, not tombstones:");
    for (const b of live) console.error(`   - "${b.name}"  members=${b.users.length}`);
    console.error("Remove the members first if you really mean to delete the business.");
    process.exit(1);
  }

  console.log(`would delete ${targets.length} member-less business(es):`);
  for (const b of targets) console.log(`   - "${b.name}"`);

  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing was changed. Re-run with --confirm to apply.");
    return;
  }

  for (const b of targets) {
    const counts = await deleteBusinessCascade(b.id);
    const detail = Object.entries(counts)
      .map(([t, n]) => `${t}=${n}`)
      .join(" ");
    console.log(`  deleted "${b.name}"${detail ? `  [${detail}]` : ""}`);
  }

  const left = await prisma.business.count({ where: { users: { none: {} } } });
  console.log(`\nmember-less businesses remaining: ${left}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
