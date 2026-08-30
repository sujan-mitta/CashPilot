/**
 * Verify what actually happened after a real test-mode payment.
 *
 * Read-only. It asks two independent questions and reports both answers
 * without reconciling them for you:
 *
 *   1. What does the PROVIDER say about the link?
 *   2. What did WE record — webhook deliveries, processed events, financial
 *      events?
 *
 * The two are deliberately kept apart. A verification that merged them could
 * report success because one side said so, which is exactly the failure this
 * whole system is built to avoid.
 *
 * Usage: npx tsx scripts/verifyA2A3.ts <paymentLinkId>
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function main() {
  const linkId = process.argv[2];
  if (!linkId) {
    console.error("Usage: npx tsx scripts/verifyA2A3.ts <paymentLinkId>");
    process.exit(1);
  }

  console.log("═══ 1. WHAT THE PROVIDER SAYS ═══");
  try {
    const Razorpay = (await import("razorpay")).default;
    const rz = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID!,
      key_secret: process.env.RAZORPAY_KEY_SECRET!,
    });
    const link = (await rz.paymentLink.fetch(linkId)) as unknown as {
      id: string;
      status: string;
      amount: number;
      amount_paid: number;
      reference_id?: string;
      payments?: { payment_id: string; status: string; amount: number }[];
    };
    console.log(`  link id:        ${link.id}`);
    console.log(`  status:         ${link.status}`);
    console.log(`  amount:         ${link.amount} paise`);
    console.log(`  amount_paid:    ${link.amount_paid} paise`);
    console.log(`  reference_id:   ${link.reference_id ?? "(none)"}`);
    for (const p of link.payments ?? []) {
      console.log(`  payment:        ${p.payment_id} ${p.status} ${p.amount} paise`);
    }
  } catch (err) {
    console.log(`  PROVIDER QUERY FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n═══ 2. WHAT WE RECORDED ═══");

  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);

  const deliveries = await prisma.webhookDeliveryAttempt.findMany({
    where: { receivedAt: { gte: since } },
    orderBy: { receivedAt: "desc" },
    take: 20,
  });
  console.log(`\n  webhook deliveries in the last 6h: ${deliveries.length}`);
  for (const d of deliveries) {
    console.log(
      `    ${d.receivedAt.toISOString()}  ${d.status}  ${d.eventType ?? "-"}  ` +
        `event=${d.providerEventId ?? "-"}  ${d.errorClass ?? ""}`
    );
  }

  const processed = await prisma.processedEvent.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  console.log(`\n  processed events in the last 6h: ${processed.length}`);
  for (const p of processed) console.log(`    ${p.createdAt.toISOString()}  ${p.id}`);

  const events = await prisma.financialEvent.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  console.log(`\n  financial events in the last 6h: ${events.length}`);
  for (const e of events) {
    console.log(
      `    ${e.createdAt.toISOString()}  ${e.eventType}  ${e.amount ?? "-"} paise  ` +
        `src=${e.sourceRecordId}`
    );
  }

  console.log("\n═══ 3. READ THIS BEFORE CONCLUDING ═══");
  console.log(
    "  The link created by makeTestPaymentLink.ts is STANDALONE — it is not\n" +
      "  attached to any invoice or recovery row. So settlement having nothing to\n" +
      "  settle is the CORRECT outcome, not a failure. What this run can prove is\n" +
      "  A-3: that a real provider webhook reached the endpoint and passed\n" +
      "  signature verification. Settlement of a real obligation is a separate\n" +
      "  test, driven from the app's own execution flow."
  );
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
