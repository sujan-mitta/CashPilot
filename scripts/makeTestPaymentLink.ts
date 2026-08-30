/**
 * Create ONE Razorpay TEST-MODE payment link, so a human can complete a real
 * payment and close A-2 / A-3.
 *
 * This exists because the `paid -> CONFIRMED_SUCCESS` path — the one that tells
 * a CFO money actually arrived — has never run against reality. Every test of
 * it so far has been against recorded response shapes.
 *
 * SAFETY
 *
 *  - Refuses to run unless RAZORPAY_KEY_ID begins `rzp_test_`. A live key here
 *    would create a link that charges a real card.
 *  - Creates a link and nothing else. It moves no money, touches no ledger row,
 *    and writes no FinancialEvent — settlement is what does that, and settlement
 *    only happens when the provider tells us the link was paid.
 *  - Prints the link URL and the reference id. Neither is a secret: the URL is
 *    meant to be opened, and the reference is what we later reconcile against.
 *    No key or secret is read into the output.
 *
 * Usage:  npx tsx scripts/makeTestPaymentLink.ts [amountInRupees]
 */

import "dotenv/config";
import { createRecoveryPaymentLink } from "../src/lib/razorpay/client";

const DEFAULT_RUPEES = 100;

async function main() {
  const keyId = process.env.RAZORPAY_KEY_ID ?? "";

  if (!keyId.startsWith("rzp_test_")) {
    console.error(
      "REFUSING TO RUN: RAZORPAY_KEY_ID is not a test-mode key.\n" +
        "A live key would create a payment link that charges a real card.\n" +
        `Key mode seen: ${keyId.slice(0, 9) || "(unset)"}…`
    );
    process.exit(1);
  }

  const rupees = Number(process.argv[2] ?? DEFAULT_RUPEES);
  if (!Number.isFinite(rupees) || rupees <= 0) {
    console.error("Amount must be a positive number of rupees.");
    process.exit(1);
  }

  const paise = Math.round(rupees * 100);

  // Deterministic, and short enough for Razorpay's 40-char reference_id limit —
  // the constraint that silently rejected every fan-out link in Phase 17.
  const reference = `cp_a2_${Date.now().toString(36)}`;

  console.log(`Creating a TEST-MODE payment link for Rs ${rupees} (${paise} paise)…`);

  const link = await createRecoveryPaymentLink(
    paise,
    "CashPilot A-2 certification — test mode",
    reference,
    { name: "CashPilot Test", email: "", contact: "" }
  );

  console.log("\n─────────────────────────────────────────────");
  console.log("  PAY THIS LINK (test mode — use a Razorpay test card)");
  console.log("─────────────────────────────────────────────");
  console.log(`  URL:        ${link.short_url}`);
  console.log(`  Link id:    ${link.id}`);
  console.log(`  Reference:  ${reference}`);
  console.log(`  Amount:     Rs ${rupees}`);
  console.log("─────────────────────────────────────────────");
  console.log("\nTest card: 4111 1111 1111 1111, any future expiry, any CVV.");
  console.log("After paying, the webhook should reach /api/webhooks and settle it.");
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
