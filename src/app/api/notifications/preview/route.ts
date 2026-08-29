import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { assessBusinessHealth } from "@/lib/notifications/healthAssessment";
import { renderAlertEmail } from "@/lib/notifications/emailTemplates";
import { logger } from "@/lib/observability";

/**
 * GET /api/notifications/preview
 *
 * Generates an authentic preview of the alert email for the authenticated business.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session || !session.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let assessment = await assessBusinessHealth(session.businessId);
    if (!assessment || assessment.severity === "HEALTHY") {
      // Mock sample critical assessment for preview if current business is healthy
      assessment = {
        businessId: session.businessId,
        businessName: session.businessName || "Your Company Pvt Ltd",
        severity: "CRITICAL",
        crisisType: "DEFICIT",
        crisisKey: "DEFICIT:SAMPLE_PREVIEW",
        currentBalance: 42000000, // ₹4.20L
        safetyBuffer: 50000000, // ₹5.00L
        runwayDays: 9,
        projectedDeficitDate: new Date(Date.now() + 9 * 86400000).toISOString(),
        firstBelowSafetyDate: new Date(Date.now() + 3 * 86400000).toISOString(),
        rootCauses: [
          {
            type: "OVERDUE_INVOICE",
            title: "Overdue Invoice: Acme Corp",
            amount: 25000000,
            dueDate: new Date(Date.now() - 5 * 86400000).toISOString(),
            description: "Invoice #INV-2026-089 for Acme Corp is 5 days overdue.",
            counterpartyName: "Acme Corp",
          },
          {
            type: "PENDING_PAYOUT",
            title: "Scheduled Payout: Cloud Infrastructure",
            amount: 32000000,
            dueDate: new Date(Date.now() + 4 * 86400000).toISOString(),
            description: "Vendor payout scheduled for AWS / Hosting nodes.",
            counterpartyName: "Cloud Infrastructure",
          },
        ],
        criticalObligations: { count: 2, amount: 32000000, protected: false },
        recommendedStrategy: {
          id: "preview_strategy",
          title: "Prioritize High-Yield Collections + Reschedule Cloud Payout",
          actionCount: 2,
          expectedRunwayChangeDays: 14,
          expectedDeficitReductionPaise: 25000000,
          requiresApproval: true,
        },
        assessedAt: new Date().toISOString(),
        confidenceScore: 0.95,
      };
    }

    const rendered = renderAlertEmail(assessment, session.name || "Finance Leader");
    return NextResponse.json({
      success: true,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ctaUrl: rendered.ctaUrl,
    });
  } catch (error) {
    logger.error("Error generating notification preview", { error: String(error) });
    return NextResponse.json({ error: "Failed to generate preview" }, { status: 500 });
  }
}
