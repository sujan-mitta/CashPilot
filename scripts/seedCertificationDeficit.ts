/**
 * Give the demo business a genuine projected deficit, so the crisis-intervention
 * flow can be exercised end to end.
 *
 * WHY THIS EXISTS
 *
 * The dashboard only offers "Find out why" when the projected balance actually
 * goes negative, and the workflow stepper keeps future steps inert. Both are
 * correct: a healthy business should not be routed into crisis intervention.
 * So certifying the settlement path requires a real deficit rather than a way
 * around the gate.
 *
 * WHAT IT INSERTS
 *
 * A scheduled payout AND its paired OUTFLOW transaction, sized so the deficit
 * is closable by the recovery that already exists in the ledger.
 *
 * Both are required, and that is not redundancy. In this data model a Payout is
 * scheduling metadata while the Transaction is the cash movement the forecast
 * actually consumes — buildForecastContextForBusiness reads transactions only.
 * The existing seed pairs them the same way ("Components Supplier Ltd" has both
 * a payout and a matching "Vendor payout - Components Supplier Ltd" outflow),
 * which is also why extractObligations deduplicates the two against each other.
 * A payout without its transaction is invisible to the runway. With cash at Rs 16,80,000 and a Rs 18,50,000
 * payout, the low point is -Rs 1,70,000 — which the existing Rs 2,40,000
 * failed-payment recovery closes. RECOVER_ONLY therefore becomes a genuinely
 * correct recommendation, not one selected past the recommendation.
 *
 * REVERSIBLE
 *
 * The vendor is prefixed CERT-TEMP so cleanup cannot match a real row:
 *   npx tsx scripts/seedCertificationDeficit.ts --undo
 */

import "dotenv/config";
import { addDays } from "date-fns";
import { prisma } from "../src/lib/prisma";

const VENDOR = "CERT-TEMP Supplier (CashPilot certification)";
const AMOUNT_PAISE = 185_000_000;
const DAYS_AHEAD = 6;

async function undo() {
  const payouts = await prisma.payout.deleteMany({
    where: { vendor: { startsWith: "CERT-TEMP" } },
  });
  const txs = await prisma.transaction.deleteMany({
    where: { description: { startsWith: "CERT-TEMP" } },
  });
  console.log(`Removed ${payouts.count} payout(s) and ${txs.count} transaction(s).`);
}

async function seed() {
  const business = await prisma.business.findFirst({ where: { name: { contains: "ABC" } } });
  if (!business) {
    console.error("No business matching 'ABC' found.");
    process.exit(1);
  }

  const existing = await prisma.payout.findFirst({
    where: { businessId: business.id, vendor: { startsWith: "CERT-TEMP" } },
  });
  if (existing) {
    console.log(`Already seeded (payout ${existing.id}). Nothing to do.`);
    return;
  }

  const due = addDays(new Date(), DAYS_AHEAD);

  const payout = await prisma.payout.create({
    data: {
      businessId: business.id,
      vendor: VENDOR,
      amount: AMOUNT_PAISE,
      scheduledDate: due,
      status: "SCHEDULED",
      criticality: "HIGH",
    },
  });

  // The movement the forecast actually reads. Same amount and date, so
  // extractObligations treats the pair as one obligation rather than two.
  const tx = await prisma.transaction.create({
    data: {
      businessId: business.id,
      amount: AMOUNT_PAISE,
      type: "OUTFLOW",
      status: "PENDING",
      description: "CERT-TEMP Vendor payout (CashPilot certification)",
      expectedDate: due,
    },
  });

  const low = business.currentCash - AMOUNT_PAISE;
  console.log(`business:       ${business.name}`);
  console.log(`cash before:    ${business.currentCash} paise`);
  console.log(`payout id:      ${payout.id}`);
  console.log(`transaction id: ${tx.id}`);
  console.log(`payout amount:  ${AMOUNT_PAISE} paise`);
  console.log(`scheduled:      ${payout.scheduledDate.toISOString().slice(0, 10)} (+${DAYS_AHEAD}d)`);
  console.log(`projected low:  ${low} paise  ${low < 0 ? "(DEFICIT — gate will open)" : "(still healthy)"}`);
}

const main = process.argv.includes("--undo") ? undo : seed;

main()
  .catch((err) => {
    console.error("FAILED:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
