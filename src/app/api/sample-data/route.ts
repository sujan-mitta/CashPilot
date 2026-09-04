import { NextResponse } from "next/server";
import { addDays } from "date-fns";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { resolveDeploymentTier } from "@/lib/config/productionConfig";
import { errorMessage } from "@/lib/errors";
import { logger } from "@/lib/observability";
import { syncFinancialBrain } from "@/lib/brain/sync";
import {
  TransactionType,
  TransactionStatus,
  InvoiceStatus,
  Priority,
  PayoutCriticality,
  PayoutStatus,
  RecoveryStatus,
} from "../../../../generated/prisma/client";

/**
 * Loads the canonical demo scenario into the SIGNED-IN user's own business.
 *
 * The dashboard has always offered a "Load the sample data" button for the
 * empty state, but nothing behind it ever wrote a row: the handler re-fetched
 * /api/forecast, got NO_DATA back again, and called window.location.reload(),
 * which returned the operator to the same empty screen. This is the endpoint
 * that button was always describing.
 *
 * It writes financial records, so it is fenced on four sides:
 *
 *   1. A session is required, and the target is ALWAYS session.businessId.
 *      The business id is never read from the request body — otherwise this
 *      would be a way to write invoices into somebody else's ledger.
 *   2. It refuses on a business that already holds ledger data. Sample data
 *      may create a ledger; it may never overwrite or extend a real one.
 *   3. It refuses outside the certification tier. resolveDeploymentTier fails
 *      safe to "production", so an unset or misspelled env var disables this
 *      route rather than exposing it.
 *   4. Everything is written in one transaction, so a failure part-way leaves
 *      no half-built scenario behind.
 *
 * Figures match prisma/seed.ts and the scenario documented in the README.
 */
export async function POST() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Two signals, because they answer different questions — the distinction
    // productionConfig.ts already draws. NODE_ENV answers "was this compiled
    // for production?"; the tier answers "does this deployment move real
    // money?". Writing a fake ledger is only dangerous when BOTH are true, so
    // a local dev server and a certification deployment are both allowed and
    // a real production deployment is not.
    const isProductionBuild = process.env.NODE_ENV === "production";
    const movesRealMoney = resolveDeploymentTier() === "production";

    if (isProductionBuild && movesRealMoney) {
      return NextResponse.json(
        {
          error: "SAMPLE_DATA_DISABLED",
          message:
            "Sample data cannot be loaded on a production deployment. Run it locally, set CASHPILOT_DEPLOYMENT_TIER=certification, or seed the database directly with `npx prisma db seed`.",
        },
        { status: 403 }
      );
    }

    const business = await prisma.business.findUnique({
      where: { id: session.businessId },
      select: { id: true, name: true },
    });
    if (!business) {
      return NextResponse.json({ error: "Business not found." }, { status: 404 });
    }

    // Never touch a ledger that already has anything in it.
    const [txCount, invoiceCount, payoutCount] = await Promise.all([
      prisma.transaction.count({ where: { businessId: business.id } }),
      prisma.invoice.count({ where: { businessId: business.id } }),
      prisma.payout.count({ where: { businessId: business.id } }),
    ]);

    if (txCount > 0 || invoiceCount > 0 || payoutCount > 0) {
      return NextResponse.json(
        {
          error: "LEDGER_NOT_EMPTY",
          message:
            "This business already has ledger records. Sample data is only loaded into an empty business, so nothing was changed.",
        },
        { status: 409 }
      );
    }

    const today = new Date();
    const businessId = business.id;

    await prisma.$transaction(
      async (tx) => {
        // Starting position: ₹10.00L
        await tx.business.update({
          where: { id: businessId },
          data: { currentCash: 100000000 },
        });

        // Committed inflows inside the horizon: ₹5.80L
        await tx.transaction.createMany({
          data: [
            {
              businessId,
              amount: 30000000,
              type: TransactionType.INFLOW,
              status: TransactionStatus.PENDING,
              expectedDate: addDays(today, 3),
              description: "Expected customer payment - Order #4821",
            },
            {
              businessId,
              amount: 28000000,
              type: TransactionType.INFLOW,
              status: TransactionStatus.PENDING,
              expectedDate: addDays(today, 6),
              description: "Expected customer payment - Order #4902",
            },
          ],
        });

        // Recoverable failed payment: ₹2.40L
        const failedTx = await tx.transaction.create({
          data: {
            businessId,
            amount: 24000000,
            type: TransactionType.INFLOW,
            status: TransactionStatus.FAILED,
            expectedDate: addDays(today, -2),
            description: "Failed payment - Order #4790",
          },
        });
        await tx.paymentRecovery.create({
          data: {
            transactionId: failedTx.id,
            status: RecoveryStatus.RECOVERY_CANDIDATE,
            amount: 24000000,
          },
        });

        // Committed outflows: ₹20.00L
        await tx.transaction.createMany({
          data: [
            {
              businessId,
              amount: 70000000,
              type: TransactionType.OUTFLOW,
              status: TransactionStatus.PENDING,
              expectedDate: addDays(today, 4),
              description: "Vendor payout - Components Supplier Ltd",
            },
            {
              businessId,
              amount: 60000000,
              type: TransactionType.OUTFLOW,
              status: TransactionStatus.PENDING,
              expectedDate: addDays(today, 5),
              description: "Payroll run",
            },
            {
              businessId,
              amount: 15000000,
              type: TransactionType.OUTFLOW,
              status: TransactionStatus.PENDING,
              expectedDate: addDays(today, 7),
              description: "Operational SaaS + recurring services",
            },
            {
              businessId,
              amount: 55000000,
              type: TransactionType.OUTFLOW,
              status: TransactionStatus.PENDING,
              expectedDate: addDays(today, 8),
              description: "Vendor payout - Packaging Co",
            },
          ],
        });

        await tx.payout.createMany({
          data: [
            {
              businessId,
              vendor: "Components Supplier Ltd",
              amount: 70000000,
              scheduledDate: addDays(today, 4),
              criticality: PayoutCriticality.HIGH,
              status: PayoutStatus.SCHEDULED,
            },
            {
              businessId,
              vendor: "Packaging Co",
              amount: 55000000,
              scheduledDate: addDays(today, 8),
              criticality: PayoutCriticality.LOW,
              status: PayoutStatus.SCHEDULED,
            },
          ],
        });

        // Overdue receivables that can be accelerated: ₹4.40L
        await tx.invoice.createMany({
          data: [
            {
              businessId,
              customerName: "Retail Chain A",
              amount: 30000000,
              dueDate: addDays(today, -5),
              status: InvoiceStatus.OVERDUE,
              priority: Priority.HIGH,
            },
            {
              businessId,
              customerName: "Distributor B",
              amount: 14000000,
              dueDate: addDays(today, -2),
              status: InvoiceStatus.OVERDUE,
              priority: Priority.MEDIUM,
            },
          ],
        });
      },
      // Same reasoning as /api/strategies: the database is a managed Postgres
      // in another region, and Prisma's 5s default assumes a local one.
      { timeout: 30_000, maxWait: 15_000 }
    );

    // Resolve the ledger we just wrote into entities and a state snapshot.
    //
    // WHY HERE
    //
    // Entity resolution is what fills Transaction.counterpartyId, and the
    // behavioural forecast keys on exactly that: without it a counterparty's
    // observed payment delay can never reach a projection, however much history
    // the ledger holds. Nothing on the operator's path used to run it — the
    // only callers were the alert dispatcher and a manual script — so a new
    // account began with every counterpartyId null and the behavioural forecast
    // permanently inert.
    //
    // The sync runs where the LEDGER CHANGES rather than where it is read. Doing
    // it on the dashboard would repeat the same work on every page load; doing
    // it here happens once, on data that was just created.
    //
    // Best-effort on purpose. The rows are committed and the seed succeeded; a
    // failure to derive entities from them is a degraded forecast, not a failed
    // request, and reporting it as one would strand an operator whose data is
    // actually fine.
    try {
      const brain = await syncFinancialBrain(prisma, businessId);
      logger.info("Seeded ledger synced", {
        businessId,
        customersLinked: brain.entities?.customersLinked ?? 0,
        stateVersion: brain.state?.stateVersion ?? null,
      });
    } catch (error) {
      logger.error("Seeded ledger, but the brain sync failed", {
        businessId,
        error: errorMessage(error),
      });
    }

    return NextResponse.json({ status: "SEEDED", businessId, businessName: business.name });
  } catch (error) {
    logger.error("API error in sample-data", { error: errorMessage(error) });
    return NextResponse.json({ error: "Could not load the sample data." }, { status: 500 });
  }
}
