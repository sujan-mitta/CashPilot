import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { syncFinancialBrain } from "../src/lib/brain/sync";

/**
 * Run the unified financial brain over one tenant, or all of them.
 *
 * Deliberately a script rather than an API route or a cron job. Running this
 * the first time over real data is a decision someone should make on purpose:
 * it creates counterparties from free-text names, and although a near-match is
 * never merged automatically, the entity set it produces is what every later
 * behaviour metric will hang off.
 *
 *   npx tsx scripts/syncBrain.ts                 # every business
 *   npx tsx scripts/syncBrain.ts <businessId>    # one business
 *   npx tsx scripts/syncBrain.ts --dry-run       # compute, skip evidence rescoring
 *
 * Requires the Phase 1/2/4/6/7/9 migrations to have been applied. Without them
 * the tables it writes to do not exist and it will fail immediately and
 * harmlessly, before touching anything.
 *
 * Safe to re-run: every stage is idempotent, so a second pass resumes rather
 * than duplicating. Nothing here moves money or calls a provider.
 */

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const businessId = args.find((a) => !a.startsWith("--"));

  const businesses = businessId
    ? [{ id: businessId, name: businessId }]
    : await prisma.business.findMany({ select: { id: true, name: true } });

  if (businesses.length === 0) {
    console.log("No businesses found.");
    return;
  }

  console.log(
    `Syncing ${businesses.length} business(es)${dryRun ? " (dry run: evidence not rescored)" : ""}.\n`
  );

  let failures = 0;

  for (const b of businesses) {
    try {
      const r = await syncFinancialBrain(prisma, b.id, { dryRunReconciliation: dryRun });

      console.log(`${b.name} (${b.id})`);
      if (r.entities) {
        console.log(
          `  entities    : ${r.entities.created} created, ` +
            `${r.entities.customersLinked} invoices + ${r.entities.suppliersLinked} payouts linked, ` +
            `${r.entities.unresolved} unresolved`
        );
        if (r.entities.mergeSuggestions > 0) {
          // Never applied automatically - a wrong merge is unrecoverable.
          console.log(
            `  ** ${r.entities.mergeSuggestions} possible duplicate counterparties need a human decision **`
          );
        }
      }
      if (r.claims) {
        console.log(
          `  claims      : ${r.claims.claimsCreated} new from ` +
            `${r.claims.invoices} invoices / ${r.claims.transactions} transactions / ${r.claims.payouts} payouts`
        );
      }
      if (r.reconciliation) {
        console.log(
          `  reconciled  : ${r.reconciliation.reconciled}/${r.reconciliation.total} subjects, ` +
            `${r.reconciliation.conflicts} conflict(s), ${r.reconciliation.missing} missing`
        );
        if (r.reconciliation.conflicts > 0) {
          console.log(`  ** ${r.reconciliation.conflicts} source conflict(s) need a human decision **`);
        }
      }
      console.log(`  evidence    : ${r.evidenceRescored} rescored`);
      if (r.state) {
        console.log(
          `  state       : v${r.state.stateVersion} ${r.state.riskState}` +
            `${r.state.unchanged ? " (unchanged)" : ""}`
        );
      }
      console.log("");
    } catch (error) {
      failures++;
      // One tenant failing must not stop the rest; every stage is idempotent,
      // so a re-run picks this one up where it stopped.
      console.error(`${b.name} (${b.id}) FAILED:`, error instanceof Error ? error.message : error);
      console.error("");
    }
  }

  if (failures > 0) {
    console.error(`${failures} business(es) failed. Re-running is safe.`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
