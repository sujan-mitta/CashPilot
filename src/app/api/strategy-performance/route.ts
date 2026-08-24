import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import { STRATEGY_NAMES, StrategyName } from "@/lib/engine/strategyEngine";
import { DecisionStatus, Prisma } from "../../../../generated/prisma/client";

/** The measured-outcome payload, as written by outcomeMeasurer into Json. */
interface MeasuredOutcome {
  status?: string;
  actualMinimumBalance?: number | null;
  predictionError?: { minimumBalance?: number | null };
}

/** The forecast snapshot fields this endpoint reads. */
interface SnapshotMinimum {
  minimumBalance?: number | null;
}

/** Narrows a Json column. A non-object value reads as empty rather than throwing. */
function readJson<T extends object>(value: unknown): T {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : ({} as T);
}

interface StrategyPerformance {
  strategyType: StrategyName;
  sampleConfidence: "NONE" | "LOW" | "SUFFICIENT";
  minimumSampleSize: number;
  statisticallyMeaningful: boolean;
  timesRecommended: number;
  timesApproved: number;
  timesRejected: number;
  timesExecuted: number;
  timesReconciled: number;
  timesMeasured: number;
  successCount: number;
  partialCount: number;
  failedCount: number;
  partiallyMeasuredCount: number;
  sampleSize: number;
  avgPredictedImprovement: number | null;
  avgActualImprovement: number | null;
  avgPredictionError: number | null;
  medianPredictionError: number | null;
}

function calculateMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted[half];
  return (sorted[half - 1] + sorted[half]) / 2.0;
}

/** Statuses that mean the operator said yes. */
const APPROVED_STATES: DecisionStatus[] = [
  DecisionStatus.APPROVED,
  DecisionStatus.EXECUTED,
  DecisionStatus.RECONCILED,
  DecisionStatus.RECONCILIATION_MISMATCH,
  DecisionStatus.OUTCOME_MEASURED,
];
const EXECUTED_STATES: DecisionStatus[] = [
  DecisionStatus.EXECUTED,
  DecisionStatus.RECONCILED,
  DecisionStatus.RECONCILIATION_MISMATCH,
  DecisionStatus.OUTCOME_MEASURED,
];
const RECONCILED_STATES: DecisionStatus[] = [
  DecisionStatus.RECONCILED,
  DecisionStatus.RECONCILIATION_MISMATCH,
  DecisionStatus.OUTCOME_MEASURED,
];

/**
 * Per-strategy performance aggregates.
 *
 * Phase 14 loaded EVERY decision for the tenant, with every JSON snapshot
 * attached, and bucketed them in JavaScript. At ten thousand decisions that is
 * tens of megabytes pulled into memory to compute a handful of numbers.
 *
 * Now:
 *  - counts come from indexed COUNT queries with a JSON-path filter, so the
 *    rows never leave the database
 *  - only MEASURED decisions are read back, paginated, and with `select`
 *    narrowed to the three fields the averages actually need
 *  - query count is constant (6 per strategy type), not proportional to history
 *
 * The aggregate MEANING is unchanged: same buckets, same statistics. Only the
 * sample used for the averages is now an explicit, paginated window, reported
 * back to the caller so nobody mistakes a page for the whole history.
 */
export async function GET(req?: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = req?.url ? new URL(req.url) : null;
    const rawSize = parseInt(url?.searchParams.get("pageSize") || "", 10);
    const pageSize = Number.isFinite(rawSize)
      ? Math.min(Math.max(rawSize, 1), FINANCIAL_CONFIG.DECISION_PAGE_SIZE_MAX)
      : FINANCIAL_CONFIG.DECISION_PAGE_SIZE_MAX;

    const rawPage = parseInt(url?.searchParams.get("page") || "", 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const skip = (page - 1) * pageSize;

    const performance: Record<string, StrategyPerformance> = {};

    for (const type of STRATEGY_NAMES as readonly StrategyName[]) {
      // Tenant filter and strategy-type filter both live in the WHERE clause.
      // A caller cannot widen either from the request.
      const typeWhere = {
        businessId: session.businessId,
        recommendedSnapshot: { path: ["strategyType"], equals: type },
      } satisfies Prisma.DecisionWhereInput;

      const [timesRecommended, timesApproved, timesRejected, timesExecuted, timesReconciled, timesMeasured] =
        await Promise.all([
          prisma.decision.count({ where: typeWhere }),
          prisma.decision.count({ where: { ...typeWhere, status: { in: APPROVED_STATES } } }),
          prisma.decision.count({ where: { ...typeWhere, status: DecisionStatus.REJECTED } }),
          prisma.decision.count({ where: { ...typeWhere, status: { in: EXECUTED_STATES } } }),
          prisma.decision.count({ where: { ...typeWhere, status: { in: RECONCILED_STATES } } }),
          prisma.decision.count({ where: { ...typeWhere, status: DecisionStatus.OUTCOME_MEASURED } }),
        ]);

      // Only measured decisions carry an outcome worth averaging, and only three
      // of their fields are needed. Deterministic ordering so pages cannot
      // repeat or skip rows.
      const measuredDecisions = await prisma.decision.findMany({
        where: { ...typeWhere, status: DecisionStatus.OUTCOME_MEASURED },
        select: {
          id: true,
          actualOutcome: true,
          recommendedSnapshot: true,
          baselineSnapshot: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: pageSize,
        skip,
      });

      const withOutcome = measuredDecisions.filter((d) => d.actualOutcome);

      const successCount = withOutcome.filter((d) => readJson<MeasuredOutcome>(d.actualOutcome).status === "SUCCESS").length;
      const partialCount = withOutcome.filter((d) => readJson<MeasuredOutcome>(d.actualOutcome).status === "PARTIAL_SUCCESS").length;
      const failedCount = withOutcome.filter((d) => readJson<MeasuredOutcome>(d.actualOutcome).status === "FAILED").length;
      const partiallyMeasuredCount = withOutcome.filter(
        (d) => readJson<MeasuredOutcome>(d.actualOutcome).status === "PARTIALLY_MEASURED"
      ).length;

      const predictedImprovements = withOutcome
        .map((d) => {
          const rec = readJson<SnapshotMinimum>(d.recommendedSnapshot);
          const base = readJson<SnapshotMinimum>(d.baselineSnapshot);
          if (typeof rec?.minimumBalance !== "number" || typeof base?.minimumBalance !== "number") return null;
          return rec.minimumBalance - base.minimumBalance;
        })
        .filter((v): v is number => v !== null);

      const actualImprovements = withOutcome
        .map((d) => {
          const act = readJson<MeasuredOutcome>(d.actualOutcome);
          const base = readJson<SnapshotMinimum>(d.baselineSnapshot);
          // actualMinimumBalance is null when the outcome was never measurable.
          if (typeof act?.actualMinimumBalance !== "number" || typeof base?.minimumBalance !== "number") return null;
          return act.actualMinimumBalance - base.minimumBalance;
        })
        .filter((v): v is number => v !== null);

      const predictionErrors = withOutcome
        .map((d) => readJson<MeasuredOutcome>(d.actualOutcome).predictionError?.minimumBalance)
        .filter((v: unknown): v is number => typeof v === "number");

      const sampleSize = withOutcome.length;
      const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

      // PRINCIPLE 12: a small sample is not a track record.
      const sampleConfidence: "NONE" | "LOW" | "SUFFICIENT" =
        timesMeasured === 0
          ? "NONE"
          : timesMeasured < FINANCIAL_CONFIG.MIN_PERFORMANCE_SAMPLE_SIZE
          ? "LOW"
          : "SUFFICIENT";

      performance[type] = {
        strategyType: type,
        sampleConfidence,
        minimumSampleSize: FINANCIAL_CONFIG.MIN_PERFORMANCE_SAMPLE_SIZE,
        statisticallyMeaningful: sampleConfidence === "SUFFICIENT",
        timesRecommended,
        timesApproved,
        timesRejected,
        timesExecuted,
        timesReconciled,
        timesMeasured,
        successCount,
        partialCount,
        failedCount,
        partiallyMeasuredCount,
        // Size of the page actually averaged, distinct from timesMeasured which
        // counts the whole history.
        sampleSize,
        avgPredictedImprovement: mean(predictedImprovements),
        avgActualImprovement: mean(actualImprovements),
        avgPredictionError: mean(predictionErrors),
        medianPredictionError: calculateMedian(predictionErrors),
      };
    }

    return NextResponse.json({
      performance,
      pagination: {
        page,
        pageSize,
        note: "Counts span the full history; averages are computed over this page of measured decisions.",
      },
    });
  } catch (error) {
    console.error("API error in strategy-performance GET:", error);
    const message = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
