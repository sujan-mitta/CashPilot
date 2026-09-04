import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateStrategies, type DeferredObligation } from "@/lib/engine/strategyEngine";
import { scoreAllStrategies, type ScoredStrategy } from "@/lib/engine/scorer";
import { runAgent } from "@/lib/ai/agents";
import { recommenderPrompt } from "@/lib/ai/prompts";
import { buildForecast, calculateRunway } from "@/lib/engine/forecast";
import { buildMovementsForBusiness } from "@/lib/forecast/movements";
import { currentForecastVersion } from "@/lib/forecast/forecastEvent";
import { decisionExpiryFrom } from "@/lib/engine/decisionValidity";
import { calculateRisk } from "@/lib/engine/riskDetector";
import { addDays } from "date-fns";
import { getSession } from "@/lib/auth";
import { calculateLiquiditySafetyRequirement, extractObligations } from "@/lib/engine/liquiditySafety";
import { buildDecisionContext, buildObligationSnapshot } from "@/lib/engine/decisionContext";
import { appendDecisionEvent } from "@/lib/engine/decisionStateMachine";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import { DecisionEventType, DecisionStatus } from "../../../../generated/prisma/client";
import { errorMessage } from "@/lib/errors";
import { logger } from "@/lib/observability";
import { rateLimit } from "@/lib/auth/rateLimit";
import type { Prisma } from "../../../../generated/prisma/client";
import { getLatestFinancialState } from "@/lib/state/store";
import { totalOutstanding } from "@/lib/engine/invoiceOutstanding";
import {
  isReschedulablePayout,
  isPausableExpense,
  HANDLED_RECOVERY_STATUSES,
  COLLECTIBLE_INVOICE_STATUSES,
} from "@/lib/engine/actionEligibility";

/** The per-strategy object returned to the client and fed to the AI narrator. */
interface ResponseStrategy {
  id: string;
  name: string;
  actions: {
    id: string;
    type: string;
    sourceEntityId: string;
    amount: number;
    effectiveDate: string;
    status: "SIMULATED";
    label: string;
  }[];
  forecast: {
    date: string;
    openingBalance: number;
    expectedInflows: number;
    expectedOutflows: number;
    projectedBalance: number;
  }[];
  result: {
    projectedBalance: number;
    minimumProjectedBalance: number;
    crisisDay: number | null;
    riskLevel: string;
  };
  scoring: ScoredStrategy["scoring"];
  recommended: boolean;
  deferredObligations: DeferredObligation[];
}

export async function POST() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // This route holds a 30-second transaction, makes ~14 sequential
    // cross-region round trips and calls an LLM. Unthrottled, any signed-in
    // user could exhaust the connection pool from one browser tab. The limit is
    // per business rather than per IP: simulating is a tenant-level operation
    // and several colleagues share an office IP.
    const limited = rateLimit(`strategies:${session.businessId}`, 10, 60_000);
    if (!limited.ok) {
      return NextResponse.json(
        {
          error: "RATE_LIMITED",
          message: "Too many simulations in a row. Wait a moment and try again.",
        },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
      );
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
    const payouts = prisma.payout
      ? await prisma.payout.findMany({ where: { businessId: business.id } })
      : [];

    const today = new Date();

    // 1. Identify amounts for action simulation
    //
    // `transactions.find(t => t.status === "FAILED")` returned whatever row came
    // back first, which is neither deterministic nor necessarily the right one:
    // a FAILED OUTFLOW is a payment WE failed to make and is not recoverable
    // revenue at all, yet it could be picked and simulated as an inflow.
    //
    // Only failed INFLOWS are recoverable, and the largest is chosen so the
    // same ledger always produces the same recommendation - which is what the
    // decision fingerprint assumes.
    // Debts already collected, or already being collected.
    //
    // A recovered payment leaves its transaction FAILED — correctly, because the
    // original payment DID fail and the behaviour model needs that fact. The
    // money arrived by another route and is counted in currentCash.
    //
    // But that left the planner proposing to recover a debt that was already
    // paid, and the executor then refusing with "No candidate failed payment
    // found to recover" — a plan that could never run, presented as approved.
    // Observed live: the operator paid a link, built a fresh plan, and the
    // first action failed on the money they had just successfully recovered.
    //
    // PAYMENT_PENDING is excluded too. A link is already out for that debt, and
    // issuing a second one asks the same customer to pay twice.
    let alreadyHandled = new Set<string>();
    try {
      const settledOrInFlight = await prisma.paymentRecovery.findMany({
        where: {
          transaction: { businessId: business.id },
          status: { in: [...HANDLED_RECOVERY_STATUSES] },
        },
        select: { transactionId: true },
      });
      alreadyHandled = new Set(settledOrInFlight.map((r) => r.transactionId));
    } catch (error) {
      // Unreadable recovery state falls back to offering every failed inflow —
      // the behaviour before this filter existed.
      //
      // The failure modes are not symmetric. Offering an already-settled debt
      // produces a plan whose first action refuses with a clear message, which
      // is annoying and recoverable. Refusing to produce ANY plan leaves an
      // operator staring at a shortfall with nothing to act on, which is worse.
      logger.error("Could not read recovery state; offering all failed inflows", {
        businessId: business.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const recoverableFailures = transactions
      .filter((t) => t.status === "FAILED" && t.type === "INFLOW" && !alreadyHandled.has(t.id))
      .sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id));

    const failedTx = recoverableFailures[0];
    const failedAmount = failedTx ? failedTx.amount : 0;
    const failedTxId = failedTx ? failedTx.id : "";
    // Surfaced rather than silently dropped: the executor recovers ONE debt per
    // action, so any others are real money this recommendation does not address
    // and the operator is entitled to know that.
    const unaddressedFailures = recoverableFailures.slice(1).map((t) => ({
      id: t.id,
      amount: t.amount,
      description: t.description,
    }));

    // Recoverable receivables are what is STILL OUTSTANDING, not the face value
    // of the invoices. A customer who has already paid ₹6L of a ₹10L invoice
    // will only ever deliver the remaining ₹4L, and simulating a collection of
    // the full ₹10L overstates the inflow the strategy can actually produce.
    //
    // PARTIALLY_PAID is included alongside OVERDUE: a part-paid invoice past its
    // due date is exactly the case this figure exists to describe.
    const overdueAmount = totalOutstanding(
      invoices.filter((i) =>
        (COLLECTIBLE_INVOICE_STATUSES as readonly string[]).includes(i.status)
      )
    );

    // Only a payout the executor could actually move. Proposing to reschedule
    // one already rescheduled fails at execution, and worse, double-counts: the
    // benefit of moving that money was banked the first time.
    const packagingPayout = payouts.find(
      (p) => p.vendor === "Packaging Co" && isReschedulablePayout(p)
    );
    const rescheduleAmount = packagingPayout ? packagingPayout.amount : 0;
    const packagingPayoutId = packagingPayout ? packagingPayout.id : "";
    const packagingTx = transactions.find(
      (t) => t.type === "OUTFLOW" && t.amount === rescheduleAmount && (t.description?.includes("Packaging") ?? false)
    );
    const packagingTxId = packagingTx ? packagingTx.id : "";

    // Matched on type and status as well as description. Description alone
    // picked up a FAILED outflow — a payment that already did not happen, so no
    // saving is available — and would have picked an INFLOW described as a
    // "recurring payment" too, offering money coming IN as an expense to stop.
    const saasTx = transactions.find(isPausableExpense);
    const pauseAmount = saasTx ? saasTx.amount : 0;
    const saasTxId = saasTx ? saasTx.id : "";

    // 2. Generate baseline forecast
    const safetyReq = await calculateLiquiditySafetyRequirement(business.id, prisma, today);
    const requiredBuffer = safetyReq.requiredBuffer;
    const baseMovements = await buildMovementsForBusiness(prisma, business.id, transactions, { now: today });
    const HORIZON = FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS;
    const baselineForecast = buildForecast(business.currentCash, baseMovements, HORIZON, today);
    const baselineRunway = calculateRunway(baselineForecast, requiredBuffer);
    const baselineRisk = calculateRisk(baselineRunway.minimumBalance, requiredBuffer);
    const baselineClosing = baselineForecast[baselineForecast.length - 1]?.closingBalance ?? 0;
    // 1-BASED, to match `runway.crisisDay`.
    //
    // The baseline used a 0-based findIndex while the recommendation used the
    // 1-based crisisDay, both subtracted from 14. A strategy that changed
    // nothing therefore appeared to remove exactly one deficit day - and these
    // two numbers are what outcome measurement later compares.
    const baselineCrisisIndex = baselineForecast.findIndex((d) => d.closingBalance < 0);
    const baselineCrisisDay = baselineCrisisIndex >= 0 ? baselineCrisisIndex + 1 : null;
    const deficitDaysFrom = (crisisDay: number | null) =>
      crisisDay === null ? 0 : HORIZON - crisisDay + 1;

    const formattedBaselineForecast = baselineForecast.map((f) => ({
      date: f.date.toISOString(),
      openingBalance: f.openingBalance,
      expectedInflows: f.expectedInflows,
      expectedOutflows: f.expectedOutflows,
      projectedBalance: f.closingBalance,
    }));

    // 3. Generate and score strategies using the deterministic engine
    const strategies = generateStrategies(business.currentCash, baseMovements, {
      recoverFailedPayments: failedAmount,
      prioritizeCollections: overdueAmount,
      reschedulePayout: rescheduleAmount,
      pauseExpense: pauseAmount,
      recoverFailedPaymentsId: failedTxId,
      reschedulePayoutId: packagingPayoutId,
      rescheduleTransactionId: packagingTxId,
      pauseExpenseId: saasTxId,
    }, today, requiredBuffer);

    const obligations = extractObligations(payouts, transactions, today);
    const scored = scoreAllStrategies(strategies, requiredBuffer, obligations, baseMovements);

    // Fingerprint every candidate BEFORE opening the transaction.
    //
    // buildDecisionContext performs several reads plus a liquidity computation.
    // Running it once per strategy INSIDE the write transaction pushed the
    // transaction past Prisma's 5s interactive limit and aborted the whole
    // simulation ("Simulation failed" in the UI, every time). It is read-only
    // work with no reason to hold a write transaction open, so it is hoisted
    // out; the transaction now does nothing but writes.
    // Every candidate strategy fingerprints the SAME ledger — nothing below is
    // filtered per strategy — so the rows are loaded once and shared. This used
    // to re-read business, transactions and payouts inside the loop, turning
    // three queries into twelve; against a database on another continent that
    // is twelve full round trips, and it dominated the endpoint's 20-30s
    // response time.
    //
    // The reads are already in hand from the work above, so this adds no query
    // at all.
    const preloaded = { business, transactions, payouts };

    // Built in parallel now they no longer contend for the same reads. The
    // fingerprint is a pure function of the rows plus the strategy's own
    // actions, so order cannot affect the result.
    const fingerprintByStrategy = new Map<string, Awaited<ReturnType<typeof buildDecisionContext>>>();
    const builtContexts = await Promise.all(
      scored.map(async (s) => [
        s.name,
        await buildDecisionContext(prisma, business.id, {
          strategyType: s.name,
          actions: s.actions.map((a) => ({
            type: a.type,
            amount: a.amount,
            targetPayoutId: a.targetPayoutId ?? null,
            targetTransactionId: a.targetTransactionId ?? null,
          })),
          today,
          requiredBuffer,
          preloaded,
        }),
      ] as const)
    );
    for (const [name, ctx] of builtContexts) fingerprintByStrategy.set(name, ctx);

    // 4. Clear old strategies and persist new ones in the database atomically inside a transaction
    const responseStrategies: ResponseStrategy[] = [];
    let recommendedStrategyId = "";

    // B-8: the materialised financial state these recommendations were computed
    // against, so the freshness gate can later tell whether the ground has
    // moved underneath them.
    //
    // Null when no state has ever been materialised, which is the current
    // reality for every tenant until brain:sync runs. The gate reads a null
    // version as NOT_TRACKED and does not block, so recording it is strictly
    // additive: it can only ever turn an unverifiable decision into a
    // verifiable one, never the reverse.
    //
    // Read outside the transaction on purpose. This one already had a 5s
    // timeout problem from work done inside it.
    const financialStateVersion =
      (await getLatestFinancialState(prisma, business.id))?.stateVersion ?? null;

    await prisma.$transaction(
      async (tx) => {
      // Discard the previous UNACTED simulation for this business.
      //
      // This used to filter on `decision: null`, but a Decision is created for
      // every strategy a few lines below (`if (tx.decision)` is a Prisma
      // delegate - always truthy), so the filter matched nothing and the
      // cleanup was dead code. Every visit to /strategies therefore added four
      // more Strategy rows, four Decisions and their actions, permanently.
      //
      // The real rule is "a decision a human has acted on is history and is
      // never deleted". PRESENTED means shown and not yet acted on, so those
      // are the ones a fresh simulation replaces.
      const supersededStrategyIds = (
        await tx.strategy.findMany({
          where: {
            businessId: business.id,
            OR: [
              { decision: null },
              { decision: { status: DecisionStatus.PRESENTED } },
              { decision: { status: DecisionStatus.GENERATED } },
            ],
          },
          select: { id: true },
        })
      ).map((row) => row.id);

      if (supersededStrategyIds.length > 0) {
        // Children first; a superseded strategy that ever dispatched an intent
        // is NOT deleted, because that intent is the durable record of an
        // external side effect.
        const withIntents = new Set(
          (
            await tx.executionIntent.findMany({
              where: { strategyId: { in: supersededStrategyIds } },
              select: { strategyId: true },
            })
          ).map((i) => i.strategyId)
        );
        const deletable = supersededStrategyIds.filter((id) => !withIntents.has(id));

        if (deletable.length > 0) {
          await tx.decisionEvent.deleteMany({
            where: { decision: { strategyId: { in: deletable } } },
          });
          await tx.decision.deleteMany({ where: { strategyId: { in: deletable } } });
          await tx.agentAction.deleteMany({ where: { strategyId: { in: deletable } } });
          await tx.strategy.deleteMany({ where: { id: { in: deletable } } });
        }
      }

      for (const s of scored) {
        // Persist the strategy in the database
        const created = await tx.strategy.create({
          data: {
            businessId: business.id,
            name: s.name,
            actions: s.actions as unknown as Prisma.InputJsonValue,
            projectedBalance: s.projectedBalance,
            riskLevel: s.riskLevel,
            score: s.score,
            recommended: s.recommended,
            startingCash: business.currentCash,
            scoring: {
              ...s.scoring,
              deferredObligations: s.deferredObligations || [],
            } as unknown as Prisma.InputJsonValue,
            agentActions: {
              create: s.actions.map((a) => {
                let targetTransactionId: string | null = null;
                let targetPayoutId: string | null = null;

                if (a.type === "RECOVER_FAILED_PAYMENTS") {
                  targetTransactionId = failedTxId;
                } else if (a.type === "RESCHEDULE_PAYOUT") {
                  targetPayoutId = packagingPayoutId;
                  targetTransactionId = packagingTxId;
                } else if (a.type === "PAUSE_EXPENSE") {
                  targetTransactionId = saasTxId;
                }

                return {
                  actionType: a.type,
                  amount: a.amount,
                  status: "PENDING",
                  targetTransactionId,
                  targetPayoutId,
                };
              }),
            },
          },
          include: {
            agentActions: true,
          },
        });

        if (s.recommended) {
          recommendedStrategyId = created.id;
        }

        if (tx.decision) {
          // Computed above, outside the transaction.
          const fingerprint = fingerprintByStrategy.get(s.name)!;

          // Every deferred obligation must still be observable at measurement
          // time, so the outcome horizon stretches to cover the latest one.
          // The FORECAST horizon is untouched (PART 19).
          const deferredDaysBeyond = (s.deferredObligations || []).reduce(
            (max, o) => Math.max(max, o.daysBeyondHorizon ?? 0),
            0
          );
          const outcomeHorizonDays =
            FINANCIAL_CONFIG.OUTCOME_WINDOW_DAYS + Math.max(0, deferredDaysBeyond);

          const createdDecision = await tx.decision.create({
            data: {
              businessId: business.id,
              strategyId: created.id,
              status: "PRESENTED",
              engineVersion: FINANCIAL_CONFIG.ENGINE_VERSION,
              scoringConfigVersion: FINANCIAL_CONFIG.SCORING_CONFIG_VERSION,
              liquidityConfigVersion: FINANCIAL_CONFIG.LIQUIDITY_CONFIG_VERSION,
              outcomeRulesVersion: FINANCIAL_CONFIG.OUTCOME_RULES_VERSION,
              // Phase 11 (spec §32). The METHOD that produced this, and when it
              // stops being executable on age alone. Recorded here so the gate
              // can catch a pipeline flip or a stale plan that no fact change
              // would reveal.
              forecastVersion: currentForecastVersion(),
              expiresAt: decisionExpiryFrom(today),
              financialStateVersion,
              contextFingerprint: fingerprint.fingerprint,
              fingerprintDetail: fingerprint as unknown as Prisma.InputJsonValue,
              obligationSnapshot: buildObligationSnapshot(
                fingerprint.context
              ) as unknown as Prisma.InputJsonValue,
              outcomeMeasurementHorizonDays: outcomeHorizonDays,
              outcomePhase: "WINDOW_OPEN",
              baselineSnapshot: {
                startingCash: business.currentCash,
                minimumBalance: baselineRunway.minimumBalance,
                finalBalance: baselineClosing,
                deficitDays: deficitDaysFrom(baselineCrisisDay),
                requiredLiquidity: requiredBuffer,
                coverageRatio: business.currentCash / (requiredBuffer || 1),
                forecastHorizon: HORIZON,
                timestamp: today.toISOString(),
              },
              recommendedSnapshot: {
                minimumBalance: s.runway.minimumBalance,
                finalBalance: s.projectedBalance,
                deficitDays: deficitDaysFrom(s.runway.crisisDay ?? null),
                coverageRatio: s.scoring?.bufferCoverageRatio || 0,
                criticalObligationProtection: s.scoring?.criticalObligations?.protected || 0,
                effectiveness: s.scoring?.counterfactual?.effectiveness || "NO_MATERIAL_IMPROVEMENT",
                deferredObligations: (s.deferredObligations ||
                  []) as unknown as Prisma.InputJsonValue,
                strategyType: s.name,
              },
            },
          });

          await appendDecisionEvent(
            tx,
            { id: createdDecision.id, businessId: business.id },
            {
              eventType: DecisionEventType.GENERATED,
              toStatus: DecisionStatus.PRESENTED,
              actorType: "SYSTEM",
              actorId: session.userId,
              metadata: {
                strategyType: s.name,
                contextFingerprint: fingerprint.fingerprint,
                outcomeMeasurementHorizonDays: outcomeHorizonDays,
                engineVersion: FINANCIAL_CONFIG.ENGINE_VERSION,
              },
            }
          );
        }

        // Map actions to match client-side requirements (with database generated Action IDs)
        const mappedActions = s.actions.map((a, idx) => {
          const matchingDbAction = created.agentActions.find((dbA) => dbA.actionType === a.type);
          
          let sourceEntityId = "";
          let effectiveDate = today;

          if (a.type === "RECOVER_FAILED_PAYMENTS") {
            sourceEntityId = failedTxId;
            effectiveDate = addDays(today, 2);
          } else if (a.type === "PRIORITIZE_COLLECTIONS") {
            sourceEntityId = "invoice-overdue-list";
            effectiveDate = addDays(today, 1);
          } else if (a.type === "RESCHEDULE_PAYOUT") {
            sourceEntityId = packagingPayoutId;
            // The date the EXECUTOR will actually write, from the shared
            // constant. This said 15 with a comment claiming "a week", while
            // the executor moved the payout 20 days out - so the approval
            // screen showed the operator a date the system would not honour.
            effectiveDate = addDays(today, FINANCIAL_CONFIG.RESCHEDULE_DELAY_DAYS);
          } else if (a.type === "PAUSE_EXPENSE") {
            sourceEntityId = saasTxId;
            effectiveDate = today;
          }

          return {
            id: matchingDbAction ? matchingDbAction.id : `mock-id-${idx}`,
            type: a.type,
            sourceEntityId,
            amount: a.amount,
            effectiveDate: effectiveDate.toISOString(),
            status: "SIMULATED" as const,
            label: a.label,
          };
        });

        const formattedStrategyForecast = s.forecast.map((f) => ({
          date: f.date.toISOString(),
          openingBalance: f.openingBalance,
          expectedInflows: f.expectedInflows,
          expectedOutflows: f.expectedOutflows,
          projectedBalance: f.closingBalance,
        }));

        responseStrategies.push({
          id: created.id,
          name: s.name,
          actions: mappedActions,
          forecast: formattedStrategyForecast,
          result: {
            projectedBalance: s.projectedBalance,
            minimumProjectedBalance: s.runway.minimumBalance,
            crisisDay: s.runway.crisisDay,
            riskLevel: s.riskLevel,
          },
          scoring: s.scoring,
          recommended: s.recommended,
          deferredObligations: s.deferredObligations || [],
        });
      }
      },
      {
        // Prisma's 5s default is a local-database assumption. This transaction
        // is ~14 sequential round trips (2 deletes, then create + decision +
        // audit event for each of 4 candidates), and the database is a managed
        // Postgres in another region — measured at ~300ms per round trip from
        // here, so the network alone is ~4.2s before any query runs. It was
        // aborting every simulation with "A query cannot be executed on an
        // expired transaction" at ~6s.
        //
        // The write set is deliberately atomic: a partial run would leave
        // strategies without their decisions, and the decision ledger is the
        // one thing that must never be half-written. So the fix is to give the
        // transaction a realistic budget rather than to split it up.
        timeout: 30_000,
        maxWait: 15_000,
      }
    );

    // 5. Query AI narrative layer
    const recommendedStrategy = responseStrategies.find((s) => s.recommended)!;
    const alternatives = responseStrategies.filter((s) => !s.recommended);

    const promptInput = {
      recommendedStrategy: {
        name: recommendedStrategy.name,
        projectedBalance: recommendedStrategy.result.projectedBalance,
        riskLevel: recommendedStrategy.result.riskLevel,
        score: recommendedStrategy.scoring.finalScore,
        actions: recommendedStrategy.actions.map((a) => ({
          label: a.label,
          amount: a.amount,
        })),
      },
      alternatives: alternatives.map((s) => ({
        name: s.name,
        projectedBalance: s.result.projectedBalance,
        riskLevel: s.result.riskLevel,
        score: s.scoring.finalScore,
      })),
    };

    // Same rule as the investigation narration: no invented figures. The name
    // and score below are read from the strategy that was actually recommended.
    const fallbackNarration = `Strategy ${recommendedStrategy.name} is recommended with a score of ${recommendedStrategy.scoring?.finalScore ?? "n/a"}. Automated narration is unavailable; the comparison table above carries the exact projected balances, safety status and deferred obligations for each option.`;

    const recommendationNarration = await runAgent(
      recommenderPrompt(promptInput),
      fallbackNarration
    );

    return NextResponse.json({
      baseline: {
        // Identity and the adaptive buffer travel with the payload so the client
        // never has to hardcode either (PART 29).
        businessId: business.id,
        businessName: business.name,
        requiredBuffer,
        projectedBalance: baselineClosing,
        minimumProjectedBalance: baselineRunway.minimumBalance,
        crisisDay: baselineRunway.crisisDay,
        riskLevel: baselineRisk,
        forecast: formattedBaselineForecast,
      },
      // When these recommendations stop being executable.
      //
      // Recorded on every Decision since P11, but never sent to the client — so
      // expiry reached the operator exactly once, as a refusal at the moment
      // they tried to approve. That is the worst possible time to learn it:
      // they have read the plan, decided, and committed to acting. Sending it
      // lets the screen say so while the decision is still usable.
      decisionExpiresAt: decisionExpiryFrom(today).toISOString(),
      strategies: responseStrategies,
      // Real recoverable money that this recommendation does NOT act on, so the
      // UI can say so instead of implying the shortfall is fully addressed.
      unaddressedFailures,
      recommendedStrategyId,
      recommendationNarration,
      safetyRequirement: safetyReq,
    });
  } catch (error) {
    logger.error("API error in strategies", { error: errorMessage(error) });
    return NextResponse.json(
      { error: "We could not finish comparing your options. Please try again." },
      { status: 500 }
    );
  }
}
