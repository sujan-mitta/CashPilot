import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, TransactionType, TransactionStatus, InvoiceStatus, Priority, PayoutCriticality, PayoutStatus, RecoveryStatus } from "../generated/prisma/client";
import { addDays } from "date-fns";
import { hashPassword } from "../src/lib/auth/password";

/** Password for every seeded demo account. Printed at the end of the seed. */
const DEMO_PASSWORD = "cashpilot2026";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not defined in the environment");
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Cleaning database...");
  await prisma.user.deleteMany();
  await prisma.agentAction.deleteMany();
  await prisma.strategy.deleteMany();
  await prisma.paymentRecovery.deleteMany();
  await prisma.cashForecast.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.business.deleteMany();

  // Seeded users were written with the literal string "mock-password-hash",
  // which is not a scrypt hash — verifyPassword parses it, finds no "scrypt$"
  // prefix and rejects it. So a freshly seeded database had three users and
  // nobody who could sign in. The demo password is hashed properly here.
  const demoPasswordHash = await hashPassword(DEMO_PASSWORD);

  console.log("Seeding canonical scenario data...");
  const business = await prisma.business.create({
    data: {
      name: "ABC Electronics Pvt Ltd",
      currentCash: 100000000, // ₹10.0L in paise
      users: {
        create: [
          {
            name: "Aryan Mittal",
            email: "mittal@company.com",
            password: demoPasswordHash,
          },
          {
            name: "Demo Guest",
            email: "demo-guest@cashpilot.ai",
            password: demoPasswordHash,
          },
        ],
      },
    },
  });

  // Create second business and user for tenant isolation testing
  const otherBusiness = await prisma.business.create({
    data: {
      name: "Deficit Inc",
      currentCash: 50000000, // ₹5.0L
      users: {
        create: [
          {
            name: "Malicious User",
            email: "attacker@company.com",
            password: demoPasswordHash,
          },
        ],
        connect: [
          { email: "mittal@company.com" },
        ],
      },
    },
  });

  const today = new Date();

  // Expected successful inflows (committed) inside 14 days: ₹5.8L total
  const inflow1 = await prisma.transaction.create({
    data: {
      businessId: business.id,
      amount: 30000000, // ₹3.0L
      type: TransactionType.INFLOW,
      status: TransactionStatus.PENDING,
      expectedDate: addDays(today, 3),
      description: "Expected customer payment - Order #4821",
    },
  });

  const inflow2 = await prisma.transaction.create({
    data: {
      businessId: business.id,
      amount: 28000000, // ₹2.8L
      type: TransactionType.INFLOW,
      status: TransactionStatus.PENDING,
      expectedDate: addDays(today, 6),
      description: "Expected customer payment - Order #4902",
    },
  });

  // Recoverable failed payment: ₹2.4L (24,000,000 paise)
  const failedTx = await prisma.transaction.create({
    data: {
      businessId: business.id,
      amount: 24000000, // ₹2.4L
      type: TransactionType.INFLOW,
      status: TransactionStatus.FAILED,
      expectedDate: addDays(today, -2), // occurred 2 days ago
      description: "Failed payment - Order #4790",
    },
  });

  // Create associated PaymentRecovery state tracker
  await prisma.paymentRecovery.create({
    data: {
      transactionId: failedTx.id,
      status: RecoveryStatus.RECOVERY_CANDIDATE,
      amount: 24000000,
    },
  });

  // Upcoming critical outflows: ₹20.0L total
  // Day 4: Components Supplier (₹7.0L) - Criticality HIGH
  const payoutTx1 = await prisma.transaction.create({
    data: {
      businessId: business.id,
      amount: 70000000, // ₹7.0L
      type: TransactionType.OUTFLOW,
      status: TransactionStatus.PENDING,
      expectedDate: addDays(today, 4),
      description: "Vendor payout - Components Supplier Ltd",
    },
  });

  await prisma.payout.create({
    data: {
      businessId: business.id,
      vendor: "Components Supplier Ltd",
      amount: 70000000,
      scheduledDate: addDays(today, 4),
      criticality: PayoutCriticality.HIGH,
      status: PayoutStatus.SCHEDULED,
    },
  });

  // Day 5: Payroll (₹6.0L) - Criticality HIGH
  const payoutTx2 = await prisma.transaction.create({
    data: {
      businessId: business.id,
      amount: 60000000, // ₹6.0L
      type: TransactionType.OUTFLOW,
      status: TransactionStatus.PENDING,
      expectedDate: addDays(today, 5),
      description: "Payroll run",
    },
  });

  // Day 7: Operational SaaS/recurring (₹1.5L) - Criticality LOW
  const payoutTx3 = await prisma.transaction.create({
    data: {
      businessId: business.id,
      amount: 15000000, // ₹1.5L
      type: TransactionType.OUTFLOW,
      status: TransactionStatus.PENDING,
      expectedDate: addDays(today, 7),
      description: "Operational SaaS + recurring services",
    },
  });

  // Day 8: Packaging Co (₹5.5L) - Criticality MEDIUM
  const payoutTx4 = await prisma.transaction.create({
    data: {
      businessId: business.id,
      amount: 55000000, // ₹5.5L
      type: TransactionType.OUTFLOW,
      status: TransactionStatus.PENDING,
      expectedDate: addDays(today, 8),
      description: "Vendor payout - Packaging Co",
    },
  });

  await prisma.payout.create({
    data: {
      businessId: business.id,
      vendor: "Packaging Co",
      amount: 55000000,
      scheduledDate: addDays(today, 8),
      criticality: PayoutCriticality.LOW, // Low or Medium criticality
      status: PayoutStatus.SCHEDULED,
    },
  });

  // Overdue Invoices (receivables that can be accelerated): ₹4.4L total
  await prisma.invoice.createMany({
    data: [
      {
        businessId: business.id,
        customerName: "Retail Chain A",
        amount: 30000000, // ₹3.0L
        dueDate: addDays(today, -5),
        status: InvoiceStatus.OVERDUE,
        priority: Priority.HIGH,
      },
      {
        businessId: business.id,
        customerName: "Distributor B",
        amount: 14000000, // ₹1.4L
        dueDate: addDays(today, -2),
        status: InvoiceStatus.OVERDUE,
        priority: Priority.MEDIUM,
      },
    ],
  });

  console.log("Database seeded successfully!");
  console.log(`Sign in with any seeded email and password: ${DEMO_PASSWORD}`);
  console.log("  mittal@company.com  |  demo-guest@cashpilot.ai");
  console.log("Business ID:", business.id);
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
