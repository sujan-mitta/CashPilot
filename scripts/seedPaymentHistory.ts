/**
 * Give a business enough settled payment history for the behavioural forecast
 * to form an opinion.
 *
 * WHY THIS IS NEEDED TO SEE THE FEATURE AT ALL
 *
 * `applyExpectedTiming` shifts an inflow only when a counterparty's behaviour is
 * SUFFICIENT, which needs at least five settled invoices carrying a due date, a
 * paid date, and a link to that counterparty. The sample scenario has unpaid
 * invoices and no settled history, so the model correctly forms no opinion and
 * the forecast does not move.
 *
 * That refusal is the right behaviour — a forecast must not shift on a guess —
 * but it means the feature is invisible until real history exists.
 *
 * WHAT IT CREATES
 *
 * One customer with a consistent, believable habit: paid every invoice, always
 * around twelve days after the due date. Consistency matters as much as
 * lateness — the model requires stable behaviour before it will act, so a
 * customer who is wildly erratic produces no opinion however many payments they
 * have made.
 *
 * It then links an UNPAID future invoice to that same customer, which is the
 * one the forecast should now move.
 *
 * REVERSIBLE
 *
 * Everything is prefixed BEHAV-DEMO so cleanup cannot match a real row:
 *   npx tsx scripts/seedPaymentHistory.ts --undo
 */

import "dotenv/config";
import { addDays, subDays } from "date-fns";
import { prisma } from "../src/lib/prisma";
import { normalizeEntityName } from "../src/lib/entities/normalize";

const CUSTOMER = "BEHAV-DEMO Retail Chain";
const PREFIX = "BEHAV-DEMO";

/** Consistently late, which is what makes the behaviour learnable. */
const HISTORY = [
  { daysAgo: 300, amount: 45_000_00, lateBy: 11 },
  { daysAgo: 250, amount: 52_000_00, lateBy: 13 },
  { daysAgo: 200, amount: 38_000_00, lateBy: 12 },
  { daysAgo: 150, amount: 61_000_00, lateBy: 12 },
  { daysAgo: 100, amount: 47_000_00, lateBy: 13 },
  { daysAgo: 55, amount: 55_000_00, lateBy: 11 },
];

/** The invoice the forecast should move once the habit is known. */
const FUTURE_DUE_IN_DAYS = 4;
const FUTURE_AMOUNT = 300_000_00;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BUSINESS_MATCH = arg("--business") ?? "Sujan Verify Co";

async function undo() {
  const invoices = await prisma.invoice.deleteMany({
    where: { customerName: { startsWith: PREFIX } },
  });
  const transactions = await prisma.transaction.deleteMany({
    where: { description: { startsWith: PREFIX } },
  });
  const counterparties = await prisma.counterparty.deleteMany({
    where: { displayName: { startsWith: PREFIX } },
  });
  console.log(`Removed ${invoices.count} invoice(s), ${transactions.count} transaction(s) and ${counterparties.count} counterparty(ies).`);
}

async function seed() {
  const business = await prisma.business.findFirst({
    where: { name: { contains: BUSINESS_MATCH, mode: "insensitive" } },
  });
  if (!business) {
    console.error(`No business matching '${BUSINESS_MATCH}'.`);
    process.exit(1);
  }

  const existing = await prisma.invoice.findFirst({
    where: { businessId: business.id, customerName: { startsWith: PREFIX } },
  });
  if (existing) {
    console.log("Already seeded. Run with --undo first to reseed.");
    return;
  }

  const counterparty = await prisma.counterparty.upsert({
    where: {
      businessId_type_normalizedName: {
        businessId: business.id,
        type: "CUSTOMER",
        normalizedName: normalizeEntityName(CUSTOMER),
      },
    },
    create: {
      businessId: business.id,
      type: "CUSTOMER",
      displayName: CUSTOMER,
      normalizedName: normalizeEntityName(CUSTOMER),
    },
    update: {},
  });

  const now = new Date();

  for (const [i, h] of HISTORY.entries()) {
    const dueDate = subDays(now, h.daysAgo);
    await prisma.invoice.create({
      data: {
        businessId: business.id,
        customerName: `${CUSTOMER} #${i + 1}`,
        amount: h.amount,
        paidAmount: h.amount,
        dueDate,
        // The fact the model actually learns from: how far after the due date
        // the money really arrived.
        paidAt: addDays(dueDate, h.lateBy),
        status: "PAID",
        priority: "MEDIUM",
        counterpartyId: counterparty.id,
      },
    });
  }

  const futureDue = addDays(now, FUTURE_DUE_IN_DAYS);
  await prisma.invoice.create({
    data: {
      businessId: business.id,
      customerName: `${CUSTOMER} — upcoming`,
      amount: FUTURE_AMOUNT,
      paidAmount: 0,
      dueDate: futureDue,
      status: "PENDING",
      priority: "HIGH",
      counterpartyId: counterparty.id,
    },
  });

  // The movement the FORECAST actually reads.
  //
  // buildForecast consumes transactions, not invoices — the same pairing the
  // existing sample data uses. Without this the behavioural model would form a
  // perfectly good opinion that nothing ever consulted, which is exactly the
  // state this branch started in.
  await prisma.transaction.create({
    data: {
      businessId: business.id,
      amount: FUTURE_AMOUNT,
      type: "INFLOW",
      status: "PENDING",
      description: `${PREFIX} Expected payment - ${CUSTOMER}`,
      expectedDate: futureDue,
      counterpartyId: counterparty.id,
    },
  });

  console.log(`business:        ${business.name}`);
  console.log(`customer:        ${CUSTOMER}`);
  console.log(`settled history: ${HISTORY.length} invoices, ${HISTORY.map((h) => h.lateBy).join("/")} days late`);
  console.log(`upcoming:        ${FUTURE_AMOUNT} paise due ${futureDue.toISOString().slice(0, 10)}`);
  console.log(`\nThe forecast should now expect that money ~12 days AFTER its due date.`);
}

const main = process.argv.includes("--undo") ? undo : seed;

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
