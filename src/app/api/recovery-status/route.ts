import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { errorMessage } from "@/lib/errors";
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

    const outstanding = await prisma.paymentRecovery.count({
      where: {
        status: "PAYMENT_PENDING",
        transaction: { businessId: session.businessId },
      },
    });

    return NextResponse.json({
      currentCash: business.currentCash,
      totalReceived: settled.reduce((sum, r) => sum + r.amount, 0),
      outstandingCount: outstanding,
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
