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
import { buildMovementsForBusiness } from "../src/lib/forecast/movements";
import { buildForecast } from "../src/lib/engine/forecast";

const VENDOR = "CERT-TEMP Supplier (CashPilot certification)";

/**
 * Which business, how much, and when — all overridable.
 *
 * The amount and date are not arbitrary. To exercise the whole flow the deficit
 * has to be CLOSABLE by recovery money that already exists in the ledger,
 * otherwise the engine correctly declines to recommend RECOVER_ONLY and steps
 * 3-5 lead nowhere. Size it under the available recovery, and land it on the
 * day the projection already troughs.
 *
 *   npx tsx scripts/seedCertificationDeficit.ts  *     --business "Sujan Verify Co" --amount 20000000 --days 4
 */
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BUSINESS_MATCH = arg("--business") ?? "ABC";
const AMOUNT_PAISE = Number(arg("--amount") ?? 185_000_000);
const DAYS_AHEAD = Number(arg("--days") ?? 6);

if (!Number.isFinite(AMOUNT_PAISE) || AMOUNT_PAISE <= 0) {
  console.error("--amount must be a positive number of paise");
  process.exit(1);
}
if (!Number.isFinite(DAYS_AHEAD) || DAYS_AHEAD < 0) {
  console.error("--days must be a non-negative number");
  process.exit(1);
}

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
  const business = await prisma.business.findFirst({
    where: { name: { contains: BUSINESS_MATCH, mode: "insensitive" } },
  });
  if (!business) {
    console.error(`No business matching '${BUSINESS_MATCH}' found.`);
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

  console.log(`business:       ${business.name}`);
  console.log(`cash before:    ${business.currentCash} paise`);
  console.log(`payout id:      ${payout.id}`);
  console.log(`transaction id: ${tx.id}`);
  console.log(`payout amount:  ${AMOUNT_PAISE} paise`);
  console.log(`scheduled:      ${payout.scheduledDate.toISOString().slice(0, 10)} (+${DAYS_AHEAD}d)`);
  // The projected low is NOT `cash - amount`. That ignores every movement
  // already in the ledger and reported "still healthy" for a seed that in fact
  // took the trough to -Rs 2,00,000, because the projection had already spent
  // its way down to zero before this landed. Computed from the real engine
  // instead, so the script cannot mislead about what it just did.
  const transactions = await prisma.transaction.findMany({ where: { businessId: business.id } });
  const movements = await buildMovementsForBusiness(prisma, business.id, transactions);
  const forecast = buildForecast(business.currentCash, movements, 14);
  const low = Math.min(...forecast.map((d) => d.closingBalance));

  console.log(`projected low:  ${low} paise (Rs ${low / 100})  ${low < 0 ? "DEFICIT — the gate is open" : "still healthy — the gate stays shut"}`);
}

const main = process.argv.includes("--undo") ? undo : seed;

main()
  .catch((err) => {
    console.error("FAILED:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
