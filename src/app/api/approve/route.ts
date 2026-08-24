import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { validateActionTransition } from "@/lib/engine/stateTransitions";
import { transitionDecision, InvalidDecisionTransitionError } from "@/lib/engine/decisionStateMachine";
import { checkStrategyFreshness, recordStaleBlock, describeStaleness } from "@/lib/engine/freshnessGate";
import { DecisionStatus } from "../../../../generated/prisma/client";

export async function POST(req: Request) {
  let strategyId: string | undefined = undefined;
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    strategyId = body.strategyId;
    const action = body.action || "approve";
    const reason = body.reason || null;

    if (!strategyId) {
      return NextResponse.json({ error: "Missing strategyId parameter." }, { status: 400 });
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
            auditLog: [
              {
                who: session.userId,
                what: "Transition PENDING -> REJECTED",
                when: new Date().toISOString(),
                why: "Human rejection click",
                result: "SUCCESS",
              }
            ] as any,
          },
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
            auditLog: [
              {
                who: session.userId,
                what: "Transition PENDING -> APPROVED",
                when: new Date().toISOString(),
                why: "Human approval gate click",
                result: "SUCCESS",
              }
            ] as any,
          },
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
  } catch (error: any) {
    if (error.message === "STRATEGY_STALE") {
      return NextResponse.json(
        { 
          error: "STRATEGY_STALE", 
          message: "The underlying ledger data has changed since this strategy was simulated." 
        }, 
        { status: 409 }
      );
    }
    if (error.message === "INVALID_STRATEGY") {
      return NextResponse.json(
        { error: "INVALID_STRATEGY", message: "This strategy contains no executable actions." },
        { status: 400 }
      );
    }
    if (error instanceof InvalidDecisionTransitionError) {
      return NextResponse.json(
        { error: "INVALID_TRANSITION", message: error.message },
        { status: 409 }
      );
    }
    if (/^Cannot (approve|reject) action/.test(error.message || "")) {
      return NextResponse.json(
        {
          error: "INVALID_TRANSITION",
          message: error.message,
        },
        { status: 400 }
      );
    }
    if (error.message.includes("Concurrency check failure")) {
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
      return NextResponse.json(
        { error: "CONCURRENT_MODIFICATION", message: error.message },
        { status: 409 }
      );
    }
    console.error("API error in approve:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
