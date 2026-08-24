import "dotenv/config";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../generated/prisma/client";
import { transactionsToMovements, buildForecast, calculateRunway } from "./forecast";
import { generateStrategies } from "./strategyEngine";
import { scoreAllStrategies } from "./scorer";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not defined in the environment");
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Fetching seeded scenario data...");
  const business = await prisma.business.findFirst({
    include: {
      transactions: true,
      invoices: true,
      payouts: true,
    },
  });

  if (!business) {
    console.error("No business found. Run seed script first!");
    return;
  }

  console.log(`Business name: ${business.name}`);
  console.log(`Current Cash: ₹${(business.currentCash / 10000000).toFixed(1)}L`);

  // 1. Run baseline forecast
  const baseMovements = transactionsToMovements(business.transactions);
  const baselineForecast = buildForecast(business.currentCash, baseMovements, 14);
  const baselineRunway = calculateRunway(baselineForecast);

  console.log("\n--- Baseline Forecast (Do Nothing) ---");
  console.log(`Projected Closing Balance: ₹${(baselineForecast[baselineForecast.length - 1].closingBalance / 10000000).toFixed(2)}L`);
  console.log(`Minimum Projected Balance: ₹${(baselineRunway.minimumBalance / 10000000).toFixed(2)}L`);
  console.log(`Crisis Expected on Day: ${baselineRunway.crisisDay ?? "None (No Deficit)"}`);

  // 2. Identify strategy library amounts
  const failedTx = business.transactions.find((t) => t.status === "FAILED");
  const failedAmount = failedTx ? failedTx.amount : 0;

  const overdueAmount = business.invoices
    .filter((i) => i.status === "OVERDUE")
    .reduce((sum, i) => sum + i.amount, 0);

  const packagingPayout = business.payouts.find((p) => p.vendor === "Packaging Co");
  const rescheduleAmount = packagingPayout ? packagingPayout.amount : 0;

  const saasTx = business.transactions.find(
    (t) => t.description?.toLowerCase().includes("saas") || t.description?.toLowerCase().includes("recurring")
  );
  const pauseAmount = saasTx ? saasTx.amount : 0;

  console.log("\n--- Actions Library ---");
  console.log(`Failed Payment Recovery Opportunity: ₹${(failedAmount / 10000000).toFixed(2)}L`);
  console.log(`Acceleratable Overdue Receivables: ₹${(overdueAmount / 10000000).toFixed(2)}L`);
  console.log(`Rescheduling Candidate Payout: ₹${(rescheduleAmount / 10000000).toFixed(2)}L`);
  console.log(`Pausable Recurring Expense: ₹${(pauseAmount / 10000000).toFixed(2)}L`);

  // 3. Generate and score strategies
  const strategies = generateStrategies(business.currentCash, baseMovements, {
    recoverFailedPayments: failedAmount,
    prioritizeCollections: overdueAmount,
    reschedulePayout: rescheduleAmount,
    pauseExpense: pauseAmount,
  });

  const scoredStrategies = scoreAllStrategies(strategies);

  console.log("\n--- Simulated Strategy Results ---");
  scoredStrategies.forEach((s) => {
    console.log(`\nStrategy: ${s.name}`);
    console.log(`  Projected Closing Balance: ₹${(s.projectedBalance / 10000000).toFixed(2)}L`);
    console.log(`  Minimum Projected Balance: ₹${(s.runway.minimumBalance / 10000000).toFixed(2)}L`);
    console.log(`  Risk Classification: ${s.riskLevel}`);
    console.log(`  Runway Crisis Day: ${s.runway.crisisDay ?? "None"}`);
    console.log(`  Action Count: ${s.actions.length}`);
    console.log(`  Dynamic Score: ${s.score}`);
    console.log(`  Recommended Strategy: ${s.recommended ? "YES ⭐" : "NO"}`);
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
