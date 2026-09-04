import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { errorMessage } from "@/lib/errors";
import { buildMovementsForBusiness } from "@/lib/forecast/movements";
import { buildForecast } from "@/lib/engine/forecast";
import { calculateLiquiditySafetyRequirement } from "@/lib/engine/liquiditySafety";
import { describeSafetyProgress } from "@/lib/engine/safetyProgress";
import { logger } from "@/lib/observability";

/**
 * Money that has actually arrived.
 *
 * WHY THIS EXISTS
 *
 * The execution page only ever knew two states: "not started" and "started in
 * THIS browser session". Settlement happens elsewhere entirely — the payer opens
 * a Razorpay link, and a webhook credits the ledger minutes later, possibly
 * after the operator has closed the tab.
 *
 * So a real payment could land, move the cash, write the ledger event, and the
 * screen would still say "Awaiting Execution" and offer to run the plan again.
 * Observed exactly that: Rs 2,40,000 settled, cash went from Rs 10,00,000 to
 * Rs 12,40,000, and the page reported nothing.
 *
 * Read-only, and scoped to the caller's own business.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const business = await prisma.business.findUnique({
      where: { id: session.businessId },
      select: { currentCash: true },
    });
    if (!business) return NextResponse.json({ error: "Business not found." }, { status: 404 });

    const settled = await prisma.paymentRecovery.findMany({
      where: {
        status: "RECOVERED",
        transaction: { businessId: session.businessId },
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: {
        id: true,
        amount: true,
        paymentLinkId: true,
        updatedAt: true,
        transaction: { select: { description: true } },
      },
    });

    const pending = await prisma.paymentRecovery.findMany({
      where: {
        status: "PAYMENT_PENDING",
        transaction: { businessId: session.businessId },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        amount: true,
        shortUrl: true,
        paymentLinkId: true,
        transaction: { select: { description: true } },
      },
    });

    // Collection links issued against INVOICES.
    //
    // These were invisible here, and the omission read as a contradiction on
    // screen: the panel announced "nothing is currently out for collection"
    // directly above two live Razorpay links worth Rs 4,40,000, and counted the
    // operator as short by the full gap when most of it was already out being
    // chased.
    //
    // The cause is that the two kinds of link are recorded in different places.
    // RECOVER_FAILED_PAYMENTS writes a PaymentRecovery row; PRIORITIZE_COLLECTIONS
    // writes neither that nor anything on the invoice beyond a raised priority —
    // its durable record is the ExecutionIntent, which is the audit spine and
    // the honest source to read.
    //
    // Counting them does NOT double-count the forecast: this ledger's invoices
    // are separate rows from its transactions, and the projection is built from
    // transactions alone, so an unpaid invoice is money the projected low does
    // not yet contain.
    const collectionIntents = await prisma.executionIntent.findMany({
      where: {
        businessId: session.businessId,
        operation: "CREATE_PAYMENT_LINK",
        targetType: "INVOICE",
        status: "SUCCEEDED",
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, amount: true, targetId: true, externalRef: true, actionId: true },
    });

    // One entry per invoice. A retried obligation has several intents against
    // it and the money is owed once; the most recent is kept because its link
    // is the one an operator should be sent to.
    const latestPerInvoice = new Map<string, (typeof collectionIntents)[number]>();
    for (const i of collectionIntents) {
      if (i.targetId && !latestPerInvoice.has(i.targetId)) latestPerInvoice.set(i.targetId, i);
    }

    const linkedInvoices = latestPerInvoice.size
      ? await prisma.invoice.findMany({
          where: {
            id: { in: [...latestPerInvoice.keys()] },
            businessId: session.businessId,
            status: { not: "PAID" },
          },
          select: { id: true, customerName: true, amount: true },
        })
      : [];

    // The checkout URL the executor resolved, recovered from the action it
    // wrote. Rebuilding one here would be guesswork: a sandbox link and a real
    // Razorpay short_url are not the same shape, and only the executor knows
    // which was issued.
    const shortUrlByLinkId = new Map<string, string>();
    if (linkedInvoices.length > 0) {
      const actions = await prisma.agentAction.findMany({
        where: { id: { in: [...new Set([...latestPerInvoice.values()].map((i) => i.actionId))] } },
        select: { result: true },
      });
      for (const a of actions) {
        try {
          const parsed = JSON.parse(a.result ?? "{}") as {
            links?: Array<{ paymentLinkId?: string; shortUrl?: string }>;
          };
          for (const l of parsed.links ?? []) {
            if (l.paymentLinkId && l.shortUrl) shortUrlByLinkId.set(l.paymentLinkId, l.shortUrl);
          }
        } catch {
          // A result that is not JSON simply yields no URL. The amount is what
          // the arithmetic needs; the link is a convenience.
        }
      }
    }

    const outstandingCollections = linkedInvoices.map((inv) => {
      const intent = latestPerInvoice.get(inv.id)!;
      return {
        id: intent.id,
        amount: inv.amount,
        description: `Invoice — ${inv.customerName}`,
        shortUrl: intent.externalRef ? shortUrlByLinkId.get(intent.externalRef) ?? null : null,
        paymentLinkId: intent.externalRef,
      };
    });

    // Where the projection stands NOW — after whatever has already settled.
    //
    // Recomputed here rather than trusting a figure captured when the plan was
    // built: money has landed since, which is the entire reason an operator is
    // looking at this page.
    const transactions = await prisma.transaction.findMany({
      where: { businessId: session.businessId },
    });
    const movements = await buildMovementsForBusiness(prisma, session.businessId, transactions);
    const days = buildForecast(business.currentCash, movements);
    const projectedLow = days.length
      ? Math.min(...days.map((d) => d.closingBalance))
      : business.currentCash;

    const safety = await calculateLiquiditySafetyRequirement(session.businessId, prisma);

    const progress = describeSafetyProgress({
      projectedLow,
      safeFloor: safety.requiredBuffer,
      recovered: settled.reduce((sum, r) => sum + r.amount, 0),
      outstanding:
        pending.reduce((sum, r) => sum + r.amount, 0) +
        outstandingCollections.reduce((sum, c) => sum + c.amount, 0),
    });

    return NextResponse.json({
      currentCash: business.currentCash,
      totalReceived: settled.reduce((sum, r) => sum + r.amount, 0),
      outstandingCount: pending.length + outstandingCollections.length,
      progress,
      // The links still payable, so the operator can act on them from here
      // rather than being told a gap exists and left to find them.
      outstanding: [
        ...pending.map((r) => ({
          id: r.id,
          amount: r.amount,
          description: r.transaction?.description ?? "Outstanding payment",
          shortUrl: r.shortUrl,
          paymentLinkId: r.paymentLinkId,
        })),
        ...outstandingCollections,
      ],
      received: settled.map((r) => ({
        id: r.id,
        amount: r.amount,
        paymentLinkId: r.paymentLinkId,
        // What the money was FOR, in the operator's own words, rather than an
        // internal id nobody outside this system can interpret.
        description: r.transaction?.description ?? "Recovered payment",
        settledAt: r.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    logger.error("recovery-status failed", { error: errorMessage(error) });
    return NextResponse.json({ error: "Could not read payment status." }, { status: 500 });
  }
}
