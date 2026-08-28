import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runAgent } from "@/lib/ai/agents";
import { investigatorPrompt } from "@/lib/ai/prompts";
import { buildForecast, calculateRunway } from "@/lib/engine/forecast";
import { buildMovementsForBusiness } from "@/lib/forecast/movements";
import { calculateRisk } from "@/lib/engine/riskDetector";
import { getSession } from "@/lib/auth";
import { calculateLiquiditySafetyRequirement } from "@/lib/engine/liquiditySafety";
import { errorMessage } from "@/lib/errors";

export async function POST() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const business = await prisma.business.findUnique({
      where: { id: session.businessId },
    });
    if (!business) {
      return NextResponse.json({ error: "No business found." }, { status: 404 });
    }

    const transactions = await prisma.transaction.findMany({
      where: { businessId: business.id },
    });
    const invoices = await prisma.invoice.findMany({
      where: { businessId: business.id },
    });

    // 1. Run baseline forecast
    const movements = await buildMovementsForBusiness(prisma, business.id, transactions);
    const forecast = buildForecast(business.currentCash, movements, 14);
    const { requiredBuffer } = await calculateLiquiditySafetyRequirement(business.id, prisma);
    const runway = calculateRunway(forecast, requiredBuffer);
    
    // Final closing balance at end of 14 days
    const finalBalance = forecast[forecast.length - 1]?.closingBalance ?? 0;
    const projectedDeficit = finalBalance < 0 ? finalBalance : 0;
    const riskLevel = calculateRisk(runway.minimumBalance, requiredBuffer);

    // 2. Identify intervention opportunities
    const failedPaymentAmount = transactions
      .filter((t) => t.status === "FAILED")
      .reduce((sum, t) => sum + t.amount, 0);

    const overdueReceivablesAmount = invoices
      .filter((i) => i.status === "OVERDUE")
      .reduce((sum, i) => sum + i.amount, 0);

    const totalPotentialLiquidity = failedPaymentAmount + overdueReceivablesAmount;

    // 3. Compile timing mismatch root cause (outflows vs inflows)
    const upcomingObligations = transactions
      .filter((t) => t.type === "OUTFLOW")
      .reduce((sum, t) => sum + t.amount, 0);

    const committedInflows = transactions
      .filter((t) => t.type === "INFLOW" && t.status === "PENDING")
      .reduce((sum, t) => sum + t.amount, 0);

    const timingGap = upcomingObligations - committedInflows;

    // List of events for timing gap evidence
    const timingEvents = transactions
      .filter((t) => t.status !== "FAILED")
      .sort((a, b) => new Date(a.expectedDate).getTime() - new Date(b.expectedDate).getTime())
      .map((t) => ({
        description: t.description || (t.type === "INFLOW" ? "Customer Inflow" : "Obligation Outflow"),
        amount: t.type === "INFLOW" ? t.amount : -t.amount,
        expectedDate: t.expectedDate.toISOString(),
      }));

    // List of failed payment transactions
    const failedTxList = transactions
      .filter((t) => t.status === "FAILED")
      .map((t) => ({
        id: t.id,
        description: t.description,
        amount: t.amount,
        expectedDate: t.expectedDate.toISOString(),
      }));

    // List of overdue invoices
    const overdueInvoiceList = invoices
      .filter((i) => i.status === "OVERDUE")
      .map((i) => ({
        id: i.id,
        customerName: i.customerName,
        amount: i.amount,
        dueDate: i.dueDate.toISOString(),
      }));

    // 4. Construct ranked causes list
    const causes = [
      {
        id: "cause-timing-gap",
        rank: 1,
        type: "TIMING_MISMATCH" as const,
        severity: "HIGH" as const,
        amount: timingGap,
        classification: "ROOT_CAUSE" as const,
        title: "Bills fall due before the money arrives",
        deterministicExplanation: "Upcoming obligations exceed committed inflows.",
        evidence: {
          events: timingEvents,
        },
      },
      {
        id: "cause-failed-payment",
        rank: 2,
        type: "FAILED_PAYMENT" as const,
        severity: "HIGH" as const,
        amount: failedPaymentAmount,
        classification: "INTERVENTION_OPPORTUNITY" as const,
        title: "A customer payment failed and is still unpaid",
        deterministicExplanation: "Recoverable cash currently unresolved.",
        evidence: {
          transactions: failedTxList,
        },
      },
      {
        id: "cause-overdue-receivables",
        rank: 3,
        type: "OVERDUE_RECEIVABLE" as const,
        severity: "MEDIUM" as const,
        amount: overdueReceivablesAmount,
        classification: "INTERVENTION_OPPORTUNITY" as const,
        title: "Customers are late paying you",
        deterministicExplanation: "Customer payments overdue and potentially acceleratable.",
        evidence: {
          invoices: overdueInvoiceList,
        },
      },
    ];

    // 5. Query AI narrative layer
    const promptInput = {
      currentCash: business.currentCash,
      projectedBalance: finalBalance,
      riskLevel,
      crisisDay: runway.crisisDay,
      rootCauses: causes.map((rc) => ({
        type: rc.type,
        amount: rc.amount,
        detail: rc.deterministicExplanation,
      })),
    };
    // The narration model can be unavailable. When it is, the fallback must
    // describe the SHAPE of the problem without asserting any figure - the
    // previous text quoted the seed dataset's rupee amounts and would have
    // told a real business a diagnosis built from someone else's ledger.
    const fallbackNarration =
      "Automated narration is unavailable. The figures shown above are computed directly from your ledger: review the projected deficit, the crisis day and the ranked root causes for the exact amounts.";

    const aiNarrative = await runAgent(
      investigatorPrompt(promptInput),
      fallbackNarration
    );

    return NextResponse.json({
      status: "SUCCESS",
      summary: {
        projectedDeficit,
        crisisDay: runway.crisisDay,
        riskLevel,
      },
      causes,
      opportunities: {
        failedPaymentRecovery: failedPaymentAmount,
        overdueReceivables: overdueReceivablesAmount,
        totalPotentialLiquidity: totalPotentialLiquidity,
      },
      aiNarrative,
    });
  } catch (error) {
    console.error("API error in investigate:", error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
