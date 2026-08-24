import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { reconcileUnknownIntent, isRetryPermitted } from "@/lib/execution/executor";
import { assertFinanciallySafeConfiguration, ConfigurationError } from "@/lib/config/productionConfig";
import { errorMessage } from "@/lib/errors";

/**
 * Operator-triggered reconciliation of one unresolved execution intent
 * (Phase 16 PART 5).
 *
 * This endpoint ASKS A QUESTION. It never re-issues a financial mutation, which
 * is why it is safe to expose as a button. Retrying is a separate decision that
 * only becomes available if reconciliation returns positive evidence the
 * original operation did not occur.
 */
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Reconciliation reads the payment provider; without credentials in
    // production it would silently report UNKNOWN forever.
    try {
      assertFinanciallySafeConfiguration();
    } catch (err) {
      if (err instanceof ConfigurationError) {
        return NextResponse.json(
          { error: err.code, message: err.message, missing: err.missing },
          { status: 503 }
        );
      }
      throw err;
    }

    const { intentId } = await req.json().catch(() => ({}));
    if (!intentId) {
      return NextResponse.json({ error: "Missing intentId parameter." }, { status: 400 });
    }

    // Tenant scoping in the query. A forged intentId from another tenant is a
    // 404, not a reconciliation.
    const intent = await prisma.executionIntent.findFirst({
      where: { id: intentId, businessId: session.businessId },
    });
    if (!intent) {
      return NextResponse.json({ error: "Execution intent not found." }, { status: 404 });
    }

    const reconciliation = await reconcileUnknownIntent(prisma, intent.id);
    const after = await prisma.executionIntent.findUnique({ where: { id: intent.id } });

    return NextResponse.json({
      intentId: intent.id,
      resolution: reconciliation.result.status,
      intentStatus: reconciliation.intentStatusAfter,
      reason: reconciliation.result.reason,
      expectedEvidence: reconciliation.result.expectedEvidence,
      observedEvidence: reconciliation.result.observedEvidence,
      searchExhaustive: reconciliation.result.searchExhaustive,
      providerReference: reconciliation.result.providerReference ?? null,
      providerStatus: reconciliation.result.providerStatus ?? null,
      checkedAt: reconciliation.result.checkedAt,
      // Server-decided, from stored evidence.
      retryPermitted: after ? isRetryPermitted(after as any) : false,
    });
  } catch (error) {
    console.error("API error in reconcile:", error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
