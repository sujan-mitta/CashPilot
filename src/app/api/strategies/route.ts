import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateStrategies } from "@/lib/engine/strategyEngine";
import { scoreAllStrategies } from "@/lib/engine/scorer";
import { runAgent } from "@/lib/ai/agents";
import { recommenderPrompt } from "@/lib/ai/prompts";
import { transactionsToMovements, buildForecast, calculateRunway } from "@/lib/engine/forecast";
import { calculateRisk } from "@/lib/engine/riskDetector";
import { addDays } from "date-fns";
import { getSession } from "@/lib/auth";
import { calculateLiquiditySafetyRequirement, extractObligations } from "@/lib/engine/liquiditySafety";
import { buildDecisionContext, buildObligationSnapshot } from "@/lib/engine/decisionContext";
import { appendDecisionEvent } from "@/lib/engine/decisionStateMachine";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import { DecisionEventType, DecisionStatus } from "../../../../generated/prisma/client";

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
    const payouts = prisma.payout
      ? await prisma.payout.findMany({ where: { businessId: business.id } })
      : [];

    const today = new Date();

    // 1. Identify amounts for action simulation
    const failedTx = transactions.find((t) => t.status === "FAILED");
    const failedAmount = failedTx ? failedTx.amount : 0;
    const failedTxId = failedTx ? failedTx.id : "";

    const overdueAmount = invoices
      .filter((i) => i.status === "OVERDUE")
      .reduce((sum, i) => sum + i.amount, 0);

    const packagingPayout = payouts.find((p) => p.vendor === "Packaging Co");
    const rescheduleAmount = packagingPayout ? packagingPayout.amount : 0;
    const packagingPayoutId = packagingPayout ? packagingPayout.id : "";
    const packagingTx = transactions.find(
      (t) => t.type === "OUTFLOW" && t.amount === rescheduleAmount && (t.description?.includes("Packaging") ?? false)
    );
    const packagingTxId = packagingTx ? packagingTx.id : "";

    const saasTx = transactions.find(
      (t) => t.description?.toLowerCase().includes("saas") || t.description?.toLowerCase().includes("recurring")
    );
    const pauseAmount = saasTx ? saasTx.amount : 0;
    const saasTxId = saasTx ? saasTx.id : "";

    // 2. Generate baseline forecast
    const safetyReq = await calculateLiquiditySafetyRequirement(business.id, prisma, today);
    const requiredBuffer = safetyReq.requiredBuffer;
    const baseMovements = transactionsToMovements(transactions);
    const baselineForecast = buildForecast(business.currentCash, baseMovements, 14, today);
    const baselineRunway = calculateRunway(baselineForecast, requiredBuffer);
    const baselineRisk = calculateRisk(baselineRunway.minimumBalance, requiredBuffer);
    const baselineClosing = baselineForecast[baselineForecast.length - 1]?.closingBalance ?? 0;
    const baselineCrisisIndex = baselineForecast.findIndex((d) => d.closingBalance < 0);

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
    const fingerprintByStrategy = new Map<string, Awaited<ReturnType<typeof buildDecisionContext>>>();
    for (const s of scored) {
      fingerprintByStrategy.set(
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
        })
      );
    }

    // 4. Clear old strategies and persist new ones in the database atomically inside a transaction
    const responseStrategies: any[] = [];
    let recommendedStrategyId = "";

    await prisma.$transaction(async (tx) => {
      await tx.agentAction.deleteMany({
        where: { strategy: { businessId: business.id, decision: null } },
      });
      await tx.strategy.deleteMany({
        where: { businessId: business.id, decision: null },
      });

      for (const s of scored) {
        // Persist the strategy in the database
        const created = await tx.strategy.create({
          data: {
            businessId: business.id,
            name: s.name,
            actions: s.actions as any,
            projectedBalance: s.projectedBalance,
            riskLevel: s.riskLevel,
            score: s.score,
            recommended: s.recommended,
            startingCash: business.currentCash,
            scoring: {
              ...(s.scoring as any),
              deferredObligations: s.deferredObligations || [],
            } as any,
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

        if ((tx as any).decision) {
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

          const createdDecision = await (tx as any).decision.create({
            data: {
              businessId: business.id,
              strategyId: created.id,
              status: "PRESENTED",
              engineVersion: FINANCIAL_CONFIG.ENGINE_VERSION,
              scoringConfigVersion: FINANCIAL_CONFIG.SCORING_CONFIG_VERSION,
              liquidityConfigVersion: FINANCIAL_CONFIG.LIQUIDITY_CONFIG_VERSION,
              outcomeRulesVersion: FINANCIAL_CONFIG.OUTCOME_RULES_VERSION,
              contextFingerprint: fingerprint.fingerprint,
              fingerprintDetail: fingerprint as any,
              obligationSnapshot: buildObligationSnapshot(fingerprint.context) as any,
              outcomeMeasurementHorizonDays: outcomeHorizonDays,
              outcomePhase: "WINDOW_OPEN",
              baselineSnapshot: {
                startingCash: business.currentCash,
                minimumBalance: baselineRunway.minimumBalance,
                finalBalance: baselineClosing,
                deficitDays: baselineCrisisIndex >= 0 ? 14 - baselineCrisisIndex : 0,
                requiredLiquidity: requiredBuffer,
                coverageRatio: business.currentCash / (requiredBuffer || 1),
                forecastHorizon: 14,
                timestamp: today.toISOString(),
              },
              recommendedSnapshot: {
                minimumBalance: s.runway.minimumBalance,
                finalBalance: s.projectedBalance,
                deficitDays: s.runway.crisisDay ? 14 - s.runway.crisisDay : 0,
                coverageRatio: s.scoring?.bufferCoverageRatio || 0,
                criticalObligationProtection: s.scoring?.criticalObligations?.protected || 0,
                effectiveness: s.scoring?.counterfactual?.effectiveness || "NO_MATERIAL_IMPROVEMENT",
                deferredObligations: s.deferredObligations || [],
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
            effectiveDate = addDays(today, 15); // Postponed by a week
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
    });

    // 5. Query AI narrative layer
    const recommendedStrategy = responseStrategies.find((s) => s.recommended)!;
    const alternatives = responseStrategies.filter((s) => !s.recommended);

    const promptInput = {
      recommendedStrategy: {
        name: recommendedStrategy.name,
        projectedBalance: recommendedStrategy.result.projectedBalance,
        riskLevel: recommendedStrategy.result.riskLevel,
        score: recommendedStrategy.scoring.finalScore,
        actions: recommendedStrategy.actions.map((a: any) => ({
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
      strategies: responseStrategies,
      recommendedStrategyId,
      recommendationNarration,
      safetyRequirement: safetyReq,
    });
  } catch (error: any) {
    console.error("API error in strategies:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
