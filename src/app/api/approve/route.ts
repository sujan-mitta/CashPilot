import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { validateActionTransition } from "@/lib/engine/stateTransitions";
import { transitionDecision, InvalidDecisionTransitionError } from "@/lib/engine/decisionStateMachine";
import { checkStrategyFreshness, recordStaleBlock, describeStaleness } from "@/lib/engine/freshnessGate";
import { DecisionStatus } from "../../../../generated/prisma/client";
import { errorMessage, parseJsonBody } from "@/lib/errors";
import { logger } from "@/lib/observability";
import { appendAuditToActions } from "@/lib/db/auditTrail";

export async function POST(req: Request) {
  let strategyId: string | undefined = undefined;
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = await parseJsonBody<{ strategyId?: unknown; action?: unknown; reason?: unknown }>(req);
    if (!parsed.ok) return parsed.response;
    strategyId = typeof parsed.data.strategyId === "string" ? parsed.data.strategyId : "";
    const reason = typeof parsed.data.reason === "string" ? parsed.data.reason.slice(0, 2000) : null;

    if (!strategyId || strategyId.trim() === "") {
      return NextResponse.json({ error: "Missing or invalid strategyId parameter." }, { status: 400 });
    }

    // The verb is validated against a closed set, and an omitted verb is an
    // error rather than an approval.
    //
    // This previously read `action === "reject" ? reject : approve`, with
    // "approve" as the default for anything unrecognised. So {"action":"REJECT"},
    // {"action":"rejct"} and {"action":"cancel"} all APPROVED - on the single
    // endpoint that is the human gate for moving money. Defaulting an
    // unparseable instruction to the irreversible option is exactly backwards.
    const rawAction = parsed.data.action;
    const action =
      rawAction === undefined || rawAction === null
        ? "approve"
        : typeof rawAction === "string"
        ? rawAction.trim().toLowerCase()
        : "";

    if (action !== "approve" && action !== "reject") {
      return NextResponse.json(
        {
          error: "INVALID_ACTION",
          message: 'The "action" field must be exactly "approve" or "reject".',
        },
        { status: 400 }
      );
    }

    const business = await prisma.business.findUnique({
      where: { id: session.businessId },
    });
    if (!business) {
      return NextResponse.json({ error: "Business not found." }, { status: 404 });
    }

    const strategy = await prisma.strategy.findFirst({
      where: { id: strategyId, businessId: business.id },
      include: { agentActions: true },
    });

    if (!strategy) {
      return NextResponse.json({ error: "Strategy not found." }, { status: 404 });
    }

    // 1. Idempotency Check: If already approved or executing, return immediately
    const alreadyApproved = strategy.agentActions.every(
      (a) => a.status === "APPROVED" || a.status === "EXECUTING" || a.status === "COMPLETED"
    );
    if (alreadyApproved && strategy.agentActions.length > 0) {
      return NextResponse.json({
        approvalId: `app_${strategyId}`,
        status: "APPROVED",
        actions: strategy.agentActions.map((a) => ({
          id: a.id,
          status: a.status,
        })),
      });
    }

    // 2. Freshness gate (PART 11/14).
    //
    // Runs BEFORE the transaction because it reads a broad slice of the ledger,
    // and a rejection needs no write. Approving is the first of two boundaries;
    // /api/execute re-checks, because the world can move between the two.
    //
    // A rejection is only skipped when the strategy is being REJECTED - declining
    // a stale recommendation is always safe and should never be blocked.
    const approvalAlreadyStarted = strategy.agentActions.some(
      (a) => a.status !== "PENDING" && a.status !== "STALE"
    );

    if (action !== "reject" && !approvalAlreadyStarted) {
      const { verdict, blocked } = await checkStrategyFreshness(prisma, {
        businessId: business.id,
        strategyId,
        strategyType: strategy.name,
        actions: strategy.agentActions.map((a) => ({
          type: a.actionType,
          amount: a.amount,
          targetPayoutId: a.targetPayoutId,
          targetTransactionId: a.targetTransactionId,
        })),
      });

      if (blocked) {
        const decision = await prisma.decision.findFirst({ where: { strategyId } });
        if (decision) {
          await recordStaleBlock(prisma, decision, verdict, session.userId);
        }
        await prisma.agentAction.updateMany({
          where: { strategyId, status: "PENDING" },
          data: { status: "STALE" },
        });
        return NextResponse.json(
          {
            error: "STRATEGY_STALE",
            classification: verdict.classification,
            message: describeStaleness(verdict),
            changes: verdict.changes.filter((c) => c.severity !== "MINOR").slice(0, 10),
          },
          { status: 409 }
        );
      }
    }

    // 3. Status updates atomically inside a transaction.
    const updatedActions = await prisma.$transaction(async (tx) => {

      // Re-fetch strategy actions inside transaction to prevent race conditions
      const freshActions = await tx.agentAction.findMany({
        where: { strategyId },
      });

      // 3. Pre-execution validations: Ensure at least one executable action
      if (freshActions.length === 0) {
        throw new Error("INVALID_STRATEGY");
      }

      // Validate transitions
      const targetStatus = action === "reject" ? "REJECTED" : "APPROVED";
      for (const act of freshActions) {
        if (!validateActionTransition(act.status, targetStatus)) {
          throw new Error(`Cannot ${action} action ${act.id} from current state ${act.status}`);
        }
      }

      // 4. Update action statuses and Decision record atomically inside transaction
      if (action === "reject") {
        await tx.agentAction.updateMany({
          where: {
            strategyId,
            status: "PENDING",
          },
          data: {
            status: "REJECTED",
          },
        });
        // The audit trail is append-only everywhere else in the codebase, and
        // the schema comments promise it. `updateMany` cannot append per row, so
        // each row is extended individually rather than having its history
        // replaced by a single-entry array.
        await appendAuditToActions(tx, freshActions, {
          who: session.userId,
          what: "Transition PENDING -> REJECTED",
          when: new Date().toISOString(),
          why: reason ? `Human rejection: ${reason}` : "Human rejection click",
          result: "SUCCESS",
        });

        // Guarded transition: refuses e.g. OUTCOME_MEASURED -> REJECTED, and
        // will not restamp an approvalSnapshot that already exists.
        await transitionDecision(tx, { strategyId }, DecisionStatus.REJECTED, {
          approvalSnapshot: {
            rejectedBy: session.userId,
            rejectedByName: session.name,
            rejectedByEmail: session.email,
            rejectedAt: new Date().toISOString(),
            status: "rejected",
            rejectionReason: reason,
          },
        }, {
          audit: { actorType: "HUMAN", actorId: session.userId, metadata: { reason } },
        });
      } else {
        await tx.agentAction.updateMany({
          where: {
            strategyId,
            status: "PENDING",
          },
          data: {
            status: "APPROVED",
          },
        });
        await appendAuditToActions(tx, freshActions, {
          who: session.userId,
          what: "Transition PENDING -> APPROVED",
          when: new Date().toISOString(),
          why: "Human approval gate click",
          result: "SUCCESS",
        });

        // Guarded transition. A concurrent second approval lands here as a
        // self-transition and is a no-op: the original approver, and the time
        // they approved, are the historical record and are never overwritten.
        await transitionDecision(tx, { strategyId }, DecisionStatus.APPROVED, {
          approvalSnapshot: {
            approvedBy: session.userId,
            approvedByName: session.name,
            approvedByEmail: session.email,
            approvedAt: new Date().toISOString(),
            status: "approved",
          },
        }, {
          audit: { actorType: "HUMAN", actorId: session.userId },
        });
      }

      const processedActions = await tx.agentAction.findMany({
        where: { strategyId },
      });

      return processedActions;
    });

    const responseStatus = action === "reject" ? "REJECTED" : "APPROVED";
    return NextResponse.json({
      approvalId: `app_${strategyId}`,
      status: responseStatus,
      actions: updatedActions.map((a) => ({
        id: a.id,
        status: a.status,
      })),
    });
  } catch (error) {
    if (errorMessage(error) === "STRATEGY_STALE") {
      return NextResponse.json(
        { 
          error: "STRATEGY_STALE", 
          message: "The underlying ledger data has changed since this strategy was simulated." 
        }, 
        { status: 409 }
      );
    }
    if (errorMessage(error) === "INVALID_STRATEGY") {
      return NextResponse.json(
        { error: "INVALID_STRATEGY", message: "This strategy contains no executable actions." },
        { status: 400 }
      );
    }
    if (error instanceof InvalidDecisionTransitionError) {
      logger.warn("Approve refused by the decision state machine", {
        strategyId,
        reason: errorMessage(error),
      });
      return NextResponse.json(
        {
          error: "INVALID_TRANSITION",
          message: "This decision has already moved past the point where it can be approved or rejected.",
        },
        { status: 409 }
      );
    }
    if (/^Cannot (approve|reject) action/.test(errorMessage(error) || "")) {
      // The internal message names action ids and state-machine states. Logged
      // for an operator, replaced with something the person can act on.
      logger.warn("Approve refused by the action state machine", {
        strategyId,
        reason: errorMessage(error),
      });
      return NextResponse.json(
        {
          error: "INVALID_TRANSITION",
          message:
            "This plan can no longer be approved or rejected in its current state. Re-run the comparison to get a current one.",
        },
        { status: 409 }
      );
    }
    if (errorMessage(error).includes("Concurrency check failure")) {
      try {
        const freshActions = await prisma.agentAction.findMany({
          where: { strategyId },
        });
        const allApproved = freshActions.every(
          (a) => a.status === "APPROVED" || a.status === "EXECUTING" || a.status === "COMPLETED"
        );
        if (allApproved && freshActions.length > 0) {
          return NextResponse.json({
            approvalId: `app_${strategyId}`,
            status: "APPROVED",
            actions: freshActions.map((a) => ({
              id: a.id,
              status: a.status,
            })),
          });
        }
      } catch (refetchError) {
        console.error("Refetch check error in approve catch block:", refetchError);
      }
      logger.warn("Approve lost a concurrency race", { strategyId, reason: errorMessage(error) });
      return NextResponse.json(
        {
          error: "CONCURRENT_MODIFICATION",
          message: "Someone else acted on this plan at the same time. Reload to see its current state.",
        },
        { status: 409 }
      );
    }
    logger.error("API error in approve", { strategyId, error: errorMessage(error) });
    return NextResponse.json(
      { error: "Could not record your decision. Please try again." },
      { status: 500 }
    );
  }
}
