import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { isRetryPermitted } from "@/lib/execution/executor";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";

/**
 * Operator view of unresolved execution intents (Phase 16 PART 5/6).
 *
 * Everything an operator needs to act on an UNKNOWN action, and nothing that
 * would let the client decide whether a retry is safe. `retryPermitted` is
 * computed on the SERVER from stored reconciliation evidence; the UI only
 * renders it.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const strategyId = searchParams.get("strategyId");
    const unresolvedOnly = searchParams.get("unresolvedOnly") !== "false";

    const rawLimit = parseInt(searchParams.get("limit") || "", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), FINANCIAL_CONFIG.DECISION_PAGE_SIZE_MAX)
      : FINANCIAL_CONFIG.DECISION_PAGE_SIZE_DEFAULT;

    const intents = await prisma.executionIntent.findMany({
      where: {
        // Tenant scoping lives in the query, never in a post-filter.
        businessId: session.businessId,
        ...(strategyId ? { strategyId } : {}),
        ...(unresolvedOnly ? { status: { in: ["UNKNOWN", "DISPATCHING"] as any } } : {}),
      },
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      take: limit,
    });

    const actionIds = Array.from(new Set(intents.map((i) => i.actionId)));
    const actions = actionIds.length
      ? await prisma.agentAction.findMany({
          where: { id: { in: actionIds }, strategy: { businessId: session.businessId } },
          select: { id: true, actionType: true, status: true, amount: true },
        })
      : [];
    const actionById = new Map(actions.map((a) => [a.id, a]));

    return NextResponse.json({
      intents: intents.map((i) => {
        const action = actionById.get(i.actionId);
        const recon = i.reconciliationResult as any;
        return {
          intentId: i.id,
          strategyId: i.strategyId,
          actionId: i.actionId,
          actionType: action?.actionType ?? null,
          actionStatus: action?.status ?? null,
          operation: i.operation,
          amount: i.amount,
          targetType: i.targetType,
          targetId: i.targetId,
          // The stable reference an operator can paste into the provider console.
          idempotencyKey: i.idempotencyKey,
          externalRef: i.externalRef,
          status: i.status,
          attempts: i.attempts,
          recordedAt: i.recordedAt,
          dispatchedAt: i.dispatchedAt,
          unknownReason: i.unknownReason,
          lastReconciledAt: i.lastReconciledAt,
          lastReconciliation: recon
            ? {
                status: recon.status,
                reason: recon.reason,
                expectedEvidence: recon.expectedEvidence,
                observedEvidence: recon.observedEvidence,
                searchExhaustive: recon.searchExhaustive,
                checkedAt: recon.checkedAt,
              }
            : null,
          // SERVER-decided. Never trust a client to compute this.
          retryPermitted: isRetryPermitted(i as any),
          nextSafeAction: describeNextSafeAction(i as any),
        };
      }),
    });
  } catch (error: any) {
    console.error("API error in execution-intents:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/** Plain-language guidance for the operator. */
function describeNextSafeAction(intent: {
  status: string;
  retrySafe?: boolean | null;
  reconciliationResult?: any;
  lastReconciledAt?: Date | null;
}): string {
  if (intent.status === "SUCCEEDED") return "Nothing to do. The operation is confirmed.";
  if (intent.status === "DISPATCHING")
    return "An attempt is still in flight. Wait for it to resolve or be swept before acting.";

  if (intent.status === "FAILED") {
    return isRetryPermitted(intent as any)
      ? "Reconciliation proved the original operation did not occur. Re-running it is safe."
      : "The operation failed but re-running it is NOT safe - the original effect may have partially landed. Verify at the provider before acting.";
  }

  if (intent.status === "UNKNOWN") {
    return intent.lastReconciledAt
      ? "Reconciliation could not determine what happened. Verify manually at the provider or in the ledger; do NOT retry."
      : "Run reconciliation to determine whether the operation took effect. Do NOT retry until it reports.";
  }

  return "No action required.";
}
