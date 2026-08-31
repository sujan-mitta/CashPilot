/**
 * Repair stored checkout URLs that point at the local sandbox.
 *
 * WHY THESE EXIST
 *
 * Before eca8e00 the executor discarded the provider's own `short_url`, kept
 * only the link id, and stored a hardcoded `/sandbox/checkout?...` path. So a
 * real, payable Razorpay link was created and the URL handed to the operator
 * led to a simulation page instead — one that refuses to run in production at
 * all, because `simulatePaid` is gated on NODE_ENV.
 *
 * The rows written in that window still hold the wrong URL, and a Razorpay
 * short_url cannot be derived from a link id: only the provider knows it. So
 * this asks the provider.
 *
 * WHAT IT WILL NOT DO
 *
 * It never creates a payment link, never cancels one, and never changes a
 * status or an amount. It only replaces a URL that leads nowhere with the one
 * the provider actually minted for that same link id. Rows whose link cannot be
 * fetched are left exactly as they are and reported.
 *
 * A sandbox link (`plink_sim_...`) is skipped: its sandbox URL is correct.
 *
 * USAGE
 *
 *   npx tsx scripts/repairCheckoutUrls.ts             # dry run
 *   npx tsx scripts/repairCheckoutUrls.ts --confirm    # apply
 */

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { fetchPaymentLink } from "../src/lib/razorpay/client";
import { withActionId } from "../src/lib/execution/actionExecutors";

const CONFIRMED = process.argv.includes("--confirm");

/** A link the provider actually minted, as opposed to our own simulation. */
const isRealProviderLink = (id: string | null) =>
  !!id && id.startsWith("plink_") && !id.startsWith("plink_sim_");

async function main() {
  const broken = await prisma.paymentRecovery.findMany({
    where: {
      shortUrl: { contains: "/sandbox/checkout" },
      paymentLinkId: { not: null },
    },
    select: { id: true, paymentLinkId: true, shortUrl: true, status: true, amount: true },
  });

  const candidates = broken.filter((r) => isRealProviderLink(r.paymentLinkId));
  const skipped = broken.length - candidates.length;

  console.log(`recoveries with a sandbox URL: ${broken.length}`);
  console.log(`  of those, real provider links: ${candidates.length}`);
  if (skipped > 0) console.log(`  simulated links skipped (their URL is correct): ${skipped}`);

  if (candidates.length === 0) {
    console.log("\nnothing to repair");
    return;
  }

  let repaired = 0;
  let unresolved = 0;

  for (const r of candidates) {
    const link = await fetchPaymentLink(r.paymentLinkId!);

    if (!link?.short_url) {
      // Left exactly as it is. A row we cannot resolve is better than a row we
      // guessed at: this URL is where a payer is sent for money genuinely owed.
      console.log(`  UNRESOLVED ${r.paymentLinkId}  (provider did not return a URL)`);
      unresolved++;
      continue;
    }

    // Preserve the actionId already on the stored URL, so the settlement poll
    // still knows which action this belongs to.
    const actionId = /actionId=([^&]+)/.exec(r.shortUrl ?? "")?.[1];
    const repairedUrl = actionId ? withActionId(link.short_url, actionId) : link.short_url;

    console.log(`  ${r.paymentLinkId}  status=${link.status}`);
    console.log(`     was: ${r.shortUrl}`);
    console.log(`     now: ${repairedUrl}`);

    if (CONFIRMED) {
      await prisma.paymentRecovery.update({
        where: { id: r.id },
        data: { shortUrl: repairedUrl },
      });
      repaired++;
    }
  }

  if (!CONFIRMED) {
    console.log("\nDRY RUN — nothing was changed. Re-run with --confirm to apply.");
    return;
  }

  console.log(`\nrepaired: ${repaired}   unresolved: ${unresolved}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
