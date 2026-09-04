import { StrategyResult, applyActionsToMovements } from "./strategyEngine";
import { DailyMovement } from "./forecast";
import { CashObligation, calculateTemporalRequiredLiquidity } from "./liquiditySafety";
import { addDays } from "date-fns";
import { FINANCIAL_CONFIG } from "./financialConfig";

export interface ScoredStrategy extends StrategyResult {
  score: number;
  recommended: boolean;
  scoring: {
    liquiditySafety: number;
    deficitElimination: number;
    criticalObligationProtection: number;
    lowDisruption: number;
    executionConfidence: number;
    finalScore: number;
    // Structured explainability data
    rank?: number;
    tier?: "Tier I (Deficit Resolved)" | "Tier II (Deficit Persists)";
    strengths: string[];
    tradeoffs: string[];
    disqualifications: string[];
    // Adaptive safety buffer explainability
    requiredBuffer?: number;
    projectedMinimumBalance?: number;
    bufferCoverageRatio?: number;
    safetyStatus?: "SAFE" | "BELOW_SAFETY_BUFFER" | "CRITICAL_OBLIGATION_RISK" | "DEFICIT" | "MEETS_SAFETY_BUFFER" | "EXCEEDS_SAFETY_BUFFER";
    criticalObligations?: {
      count: number;
      amount: number;
      protected: boolean;
    };
    temporalRisk?: {
      firstCriticalDate: string | null;
      criticalAmount: number;
    };
    requiredLiquidityByDay?: number[];
    counterfactual?: {
      baselineMinimumBalance: number;
      strategyMinimumBalance: number;
      minimumBalanceDelta: number;
      baselineDeficitDays: number;
      strategyDeficitDays: number;
      deficitDaysDelta: number;
      baselineCoverageRatio: number;
      strategyCoverageRatio: number;
      coverageRatioDelta: number;
      baselineCriticalObligationsProtected: number;
      strategyCriticalObligationsProtected: number;
      criticalObligationsProtectedDelta: number;
      effectiveness: "DEFICIT_ELIMINATED" | "DEFICIT_ELIMINATED_WITH_DEFERRED_OBLIGATION" | "DEFICIT_REDUCED" | "OBLIGATION_RISK_ELIMINATED" | "LIQUIDITY_IMPROVED" | "NO_MATERIAL_IMPROVEMENT" | "WORSE_THAN_BASELINE" | "INVALID";
    };
    deferredObligations?: {
      count: number;
      amount: number;
      latestDueDate: string | null;
      items: {
        sourceId: string;
        amount: number;
        originalDueDate: string;
        newDueDate: string;
        daysBeyondHorizon: number;
      }[];
    };
  };
}

/**
 * Scoring constants. Every value is sourced from financialConfig.ts so there is
 * exactly one definition per business rule (Phase 14, PART 37). This object is
 * retained as a named export because the engine and API layers already import
 * it; it is a view over FINANCIAL_CONFIG, not a second source of truth.
 */
/**
 * Scoring constants.
 *
 * These are ACCESSORS over FINANCIAL_CONFIG, not a copy of it. The previous
 * version spread the values once at module load, which meant the two objects
 * silently diverged the moment anything changed FINANCIAL_CONFIG at runtime -
 * the comment claimed "single source of truth" while the code held a snapshot.
 * Reads and writes both delegate, so there is genuinely one definition per rule.
 */
export const SCORING_CONFIG = {
  get SAFETY_THRESHOLD() { return FINANCIAL_CONFIG.SAFETY_THRESHOLD; },
  set SAFETY_THRESHOLD(v: number) { FINANCIAL_CONFIG.SAFETY_THRESHOLD = v; },

  get SAFETY_BUFFER_COVERAGE_DAYS() { return FINANCIAL_CONFIG.SAFETY_BUFFER_COVERAGE_DAYS; },
  set SAFETY_BUFFER_COVERAGE_DAYS(v: number) { FINANCIAL_CONFIG.SAFETY_BUFFER_COVERAGE_DAYS = v; },

  get SAFETY_BUFFER_MIN_FLOOR() { return FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR; },
  set SAFETY_BUFFER_MIN_FLOOR(v: number) { FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR = v; },

  get DECAY_RATE() { return FINANCIAL_CONFIG.DECAY_RATE; },
  get RESCHEDULE_PENALTY() { return FINANCIAL_CONFIG.RESCHEDULE_PENALTY; },

  get COLLECTIONS_DISRUPTION() { return FINANCIAL_CONFIG.COLLECTIONS_DISRUPTION; },
  get PAUSE_EXPENSE_DISRUPTION() { return FINANCIAL_CONFIG.PAUSE_EXPENSE_DISRUPTION; },
  get RESCHEDULE_PAYOUT_DISRUPTION() { return FINANCIAL_CONFIG.RESCHEDULE_PAYOUT_DISRUPTION; },

  get RECOVER_FAILED_PAYMENTS_CONFIDENCE() { return FINANCIAL_CONFIG.RECOVER_FAILED_PAYMENTS_CONFIDENCE; },
  get PRIORITIZE_COLLECTIONS_CONFIDENCE() { return FINANCIAL_CONFIG.PRIORITIZE_COLLECTIONS_CONFIDENCE; },
  get PAUSE_EXPENSE_CONFIDENCE() { return FINANCIAL_CONFIG.PAUSE_EXPENSE_CONFIDENCE; },
  get RESCHEDULE_PAYOUT_CONFIDENCE() { return FINANCIAL_CONFIG.RESCHEDULE_PAYOUT_CONFIDENCE; },
};

function getActionDayOffset(type: string): number {
  if (type === "PRIORITIZE_COLLECTIONS") return 1;
  if (type === "RECOVER_FAILED_PAYMENTS") return 2;
  if (type === "PAUSE_EXPENSE") return 7;
  if (type === "RESCHEDULE_PAYOUT") return 8;
  return 1;
}

function getActionBaseConfidence(type: string): number {
  if (type === "RECOVER_FAILED_PAYMENTS") return SCORING_CONFIG.RECOVER_FAILED_PAYMENTS_CONFIDENCE;
  if (type === "PRIORITIZE_COLLECTIONS") return SCORING_CONFIG.PRIORITIZE_COLLECTIONS_CONFIDENCE;
  if (type === "PAUSE_EXPENSE") return SCORING_CONFIG.PAUSE_EXPENSE_CONFIDENCE;
  if (type === "RESCHEDULE_PAYOUT") return SCORING_CONFIG.RESCHEDULE_PAYOUT_CONFIDENCE;
  return 100;
}

function getActionDisruptionPenalty(type: string): number {
  if (type === "PRIORITIZE_COLLECTIONS") return SCORING_CONFIG.COLLECTIONS_DISRUPTION;
  if (type === "PAUSE_EXPENSE") return SCORING_CONFIG.PAUSE_EXPENSE_DISRUPTION;
  if (type === "RESCHEDULE_PAYOUT") return SCORING_CONFIG.RESCHEDULE_PAYOUT_DISRUPTION;
  return 0;
}

/**
 * Dynamically scores all generated strategies using a constraint-first, lexicographical tier model.
 */
export function scoreAllStrategies(
  strategies: StrategyResult[],
  safetyThreshold: number = SCORING_CONFIG.SAFETY_THRESHOLD,
  obligations: CashObligation[] = [],
  baseMovements: DailyMovement[] = []
): ScoredStrategy[] {
  const baselineStrategy = strategies.find((s) => s.name === "DO_NOTHING");
  
  let baselineMinimumBalance = 0;
  let baselineDeficitDays = 0;
  let baselineCoverageRatio = 1.0;
  let baselineProtectedCount = 0;
  let baselineCriticalCount = 0;

  if (baselineStrategy) {
    baselineMinimumBalance = baselineStrategy.runway.minimumBalance;
    baselineDeficitDays = baselineStrategy.forecast.filter((d) => d.closingBalance < 0).length;

    let requiredLiquidityByDay = new Array(baselineStrategy.forecast.length).fill(safetyThreshold);

    if (obligations.length > 0 && baseMovements.length > 0) {
      const forecastStartDate = baselineStrategy.forecast[0]?.date ? new Date(baselineStrategy.forecast[0].date) : new Date();
      const simulatedMovements = applyActionsToMovements(baseMovements, [], forecastStartDate);
      const temporalMetrics = calculateTemporalRequiredLiquidity(
        baselineStrategy.forecast,
        simulatedMovements,
        obligations,
        safetyThreshold,
        forecastStartDate
      );
      requiredLiquidityByDay = temporalMetrics.requiredLiquidityByDay;
      baselineCriticalCount = temporalMetrics.criticalObligationsCount;

      const startUtc = new Date(Date.UTC(forecastStartDate.getUTCFullYear(), forecastStartDate.getUTCMonth(), forecastStartDate.getUTCDate()));
      const horizonEnd = addDays(startUtc, baselineStrategy.forecast.length);
      const criticalInHorizon = obligations.filter((o) => {
        const isCritical = o.priority === "CRITICAL" || o.priority === "HIGH";
        const inHorizon = o.dueDate >= startUtc && o.dueDate <= horizonEnd;
        return isCritical && inHorizon && o.amount > 0;
      });

      criticalInHorizon.forEach((o) => {
        const day = baselineStrategy.forecast.find((f) => {
          return (
            f.date.getUTCFullYear() === o.dueDate.getUTCFullYear() &&
            f.date.getUTCMonth() === o.dueDate.getUTCMonth() &&
            f.date.getUTCDate() === o.dueDate.getUTCDate()
          );
        });
        if (day && day.closingBalance >= 0) {
          baselineProtectedCount++;
        }
      });

      if (baselineStrategy.forecast.length > 0 && requiredLiquidityByDay.length > 0) {
        const ratios = baselineStrategy.forecast.map((day, idx) => {
          const req = requiredLiquidityByDay[idx] || safetyThreshold;
          return req > 0 ? day.closingBalance / req : 1.0;
        });
        baselineCoverageRatio = Math.min(...ratios);
      }
    } else {
      baselineCoverageRatio = safetyThreshold > 0 ? baselineMinimumBalance / safetyThreshold : 1.0;
    }
  }

  const baselineDeficit = Math.abs(Math.min(0, baselineMinimumBalance));

  const scored: ScoredStrategy[] = strategies.map((strategy) => {
    const strengths: string[] = [];
    const tradeoffs: string[] = [];
    const disqualifications: string[] = [];

    // Calculate this strategy's outcome snapshot metrics
    const minBalance = strategy.runway.minimumBalance;
    const isDeficitEliminated = minBalance >= 0;
    const strategyMinimumBalance = minBalance;
    const strategyDeficitDays = strategy.forecast.filter((d) => d.closingBalance < 0).length;
    let strategyProtectedCount = 0;

    let requiredLiquidityByDay = new Array(strategy.forecast.length).fill(safetyThreshold);
    let criticalObligationsCount = 0;
    let criticalObligationsAmount = 0;
    let criticalObligationsProtected = true;
    let firstCriticalDate: string | null = null;
    let criticalAmount = 0;

    let minCoverageRatio = safetyThreshold > 0 ? minBalance / safetyThreshold : 1.0;

    if (strategy.error) {
      disqualifications.push(strategy.error);
      const minimumBalanceDelta = 0 - baselineMinimumBalance;
      const deficitDaysDelta = 14 - baselineDeficitDays;
      const coverageRatioDelta = 0 - baselineCoverageRatio;
      const criticalObligationsProtectedDelta = 0 - baselineProtectedCount;

      return {
        ...strategy,
        score: 0,
        recommended: false,
        scoring: {
          liquiditySafety: 0,
          deficitElimination: 0,
          criticalObligationProtection: 0,
          lowDisruption: 0,
          executionConfidence: 0,
          finalScore: 0,
          tier: "Tier II (Deficit Persists)",
          strengths: [],
          tradeoffs: [],
          disqualifications,
          requiredBuffer: safetyThreshold,
          projectedMinimumBalance: 0,
          bufferCoverageRatio: 0,
          safetyStatus: "DEFICIT",
          criticalObligations: { count: 0, amount: 0, protected: false },
          temporalRisk: { firstCriticalDate: null, criticalAmount: 0 },
          requiredLiquidityByDay: [],
          counterfactual: {
            baselineMinimumBalance,
            strategyMinimumBalance: 0,
            minimumBalanceDelta,
            baselineDeficitDays,
            strategyDeficitDays: 14,
            deficitDaysDelta,
            baselineCoverageRatio: parseFloat(baselineCoverageRatio.toFixed(2)),
            strategyCoverageRatio: 0,
            coverageRatioDelta: parseFloat(coverageRatioDelta.toFixed(2)),
            baselineCriticalObligationsProtected: baselineProtectedCount,
            strategyCriticalObligationsProtected: 0,
            criticalObligationsProtectedDelta,
            effectiveness: "INVALID",
          },
          deferredObligations: {
            count: 0,
            amount: 0,
            latestDueDate: null,
            items: [],
          },
        },
      };
    }

    if (obligations.length > 0 && baseMovements.length > 0) {
      const forecastStartDate = strategy.forecast[0]?.date ? new Date(strategy.forecast[0].date) : new Date();
      const simulatedMovements = applyActionsToMovements(baseMovements, strategy.actions, forecastStartDate);
      const temporalMetrics = calculateTemporalRequiredLiquidity(
        strategy.forecast,
        simulatedMovements,
        obligations,
        safetyThreshold,
        forecastStartDate
      );
      requiredLiquidityByDay = temporalMetrics.requiredLiquidityByDay;
      criticalObligationsCount = temporalMetrics.criticalObligationsCount;
      criticalObligationsAmount = temporalMetrics.criticalObligationsAmount;
      criticalObligationsProtected = temporalMetrics.criticalObligationsProtected;
      firstCriticalDate = temporalMetrics.firstCriticalDate;
      criticalAmount = temporalMetrics.criticalAmount;

      const startUtc = new Date(Date.UTC(forecastStartDate.getUTCFullYear(), forecastStartDate.getUTCMonth(), forecastStartDate.getUTCDate()));
      const horizonEnd = addDays(startUtc, strategy.forecast.length);
      const criticalInHorizon = obligations.filter((o) => {
        const isCritical = o.priority === "CRITICAL" || o.priority === "HIGH";
        const inHorizon = o.dueDate >= startUtc && o.dueDate <= horizonEnd;
        return isCritical && inHorizon && o.amount > 0;
      });

      criticalInHorizon.forEach((o) => {
        const day = strategy.forecast.find((f) => {
          return (
            f.date.getUTCFullYear() === o.dueDate.getUTCFullYear() &&
            f.date.getUTCMonth() === o.dueDate.getUTCMonth() &&
            f.date.getUTCDate() === o.dueDate.getUTCDate()
          );
        });
        if (day && day.closingBalance >= 0) {
          strategyProtectedCount++;
        }
      });

      if (strategy.forecast.length > 0 && requiredLiquidityByDay.length > 0) {
        const ratios = strategy.forecast.map((day, idx) => {
          const req = requiredLiquidityByDay[idx] || safetyThreshold;
          return req > 0 ? day.closingBalance / req : 1.0;
        });
        minCoverageRatio = Math.min(...ratios);
      }
    } else {
      minCoverageRatio = safetyThreshold > 0 ? minBalance / safetyThreshold : 1.0;
    }

    // Common Metrics Extraction
    const hasReschedulePayout = strategy.actions.some((a) => a.type === "RESCHEDULE_PAYOUT");
    const criticalObligationProtection = hasReschedulePayout ? (100 - SCORING_CONFIG.RESCHEDULE_PENALTY) : 100;

    let disruptionPenalty = 0;
    strategy.actions.forEach((a) => {
      disruptionPenalty += getActionDisruptionPenalty(a.type);
    });
    const lowDisruption = Math.max(50, 100 - disruptionPenalty);

    let executionConfidence = 100;
    if (strategy.actions.length > 0) {
      const totalConf = strategy.actions.reduce((sum, a) => {
        const baseConf = getActionBaseConfidence(a.type);
        const dayOffset = getActionDayOffset(a.type);
        const decayFactor = Math.pow(SCORING_CONFIG.DECAY_RATE, dayOffset);
        return sum + baseConf * decayFactor;
      }, 0);
      executionConfidence = Math.round(totalConf / strategy.actions.length);
    }

    // Counterfactual Snapshot and Classification
    const minimumBalanceDelta = strategyMinimumBalance - baselineMinimumBalance;
    const deficitDaysDelta = strategyDeficitDays - baselineDeficitDays;
    const coverageRatioDelta = minCoverageRatio - baselineCoverageRatio;
    const criticalObligationsProtectedDelta = strategyProtectedCount - baselineProtectedCount;

    let effectiveness: "DEFICIT_ELIMINATED" | "DEFICIT_ELIMINATED_WITH_DEFERRED_OBLIGATION" | "DEFICIT_REDUCED" | "OBLIGATION_RISK_ELIMINATED" | "LIQUIDITY_IMPROVED" | "NO_MATERIAL_IMPROVEMENT" | "WORSE_THAN_BASELINE" | "INVALID" = "NO_MATERIAL_IMPROVEMENT";

    const isWorseThanBaseline =
      strategyMinimumBalance < baselineMinimumBalance ||
      strategyDeficitDays > baselineDeficitDays ||
      strategyProtectedCount < baselineProtectedCount;

    const deferredList = strategy.deferredObligations || [];
    const hasDeferred = deferredList.length > 0;

    if (isWorseThanBaseline) {
      effectiveness = "WORSE_THAN_BASELINE";
      disqualifications.push("Strategy results in worse cash flow or obligation protection than doing nothing");
    } else if (baselineMinimumBalance < 0 && strategyMinimumBalance >= 0) {
      effectiveness = hasDeferred ? "DEFICIT_ELIMINATED_WITH_DEFERRED_OBLIGATION" : "DEFICIT_ELIMINATED";
    } else if (baselineMinimumBalance < 0 && strategyMinimumBalance < 0 && strategyMinimumBalance > baselineMinimumBalance) {
      effectiveness = "DEFICIT_REDUCED";
    } else if (baselineProtectedCount < baselineCriticalCount && strategyProtectedCount === baselineCriticalCount && strategyMinimumBalance >= 0) {
      effectiveness = "OBLIGATION_RISK_ELIMINATED";
    } else if (strategyMinimumBalance > baselineMinimumBalance || minCoverageRatio > baselineCoverageRatio) {
      effectiveness = "LIQUIDITY_IMPROVED";
    } else {
      effectiveness = "NO_MATERIAL_IMPROVEMENT";
    }

    const deferredCount = deferredList.length;
    const deferredAmount = deferredList.reduce((sum, o) => sum + o.amount, 0);
    const latestDeferredDueDate = deferredList.length > 0 
      ? new Date(Math.max(...deferredList.map((o) => o.newDueDate.getTime()))).toISOString().split("T")[0]
      : null;

    const scoringDeferredObligations = {
      count: deferredCount,
      amount: deferredAmount,
      latestDueDate: latestDeferredDueDate,
      items: deferredList.map((o) => ({
        sourceId: o.sourceId,
        amount: o.amount,
        originalDueDate: o.originalDueDate.toISOString().split("T")[0],
        newDueDate: o.newDueDate.toISOString().split("T")[0],
        daysBeyondHorizon: o.daysBeyondHorizon,
      })),
    };

    // TIER I: Deficit Solved (Score mapped to [60, 100])
    if (isDeficitEliminated) {
      // Compute liquiditySafety dynamically based on minCoverageRatio
      let liquiditySafety = 100;
      if (minCoverageRatio < 1.0) {
        liquiditySafety = Math.round(75 + 25 * Math.max(0, minCoverageRatio));
      }
      
      const deficitElimination = 100;

      // Group I final weighted base score
      const groupIBaseScore = 
        0.40 * liquiditySafety +
        0.25 * criticalObligationProtection +
        0.20 * lowDisruption +
        0.15 * executionConfidence;

      const finalScore = isWorseThanBaseline ? 0 : Math.round(60 + 40 * ((groupIBaseScore - 55) / 45));

      strengths.push("Successfully eliminates projected cash flow deficit");
      
      let safetyStatus: ScoredStrategy["scoring"]["safetyStatus"] = "MEETS_SAFETY_BUFFER";
      if (!criticalObligationsProtected) {
        safetyStatus = "CRITICAL_OBLIGATION_RISK";
        disqualifications.push("Fails to protect upcoming critical/high priority obligations");
      } else if (minCoverageRatio < 1.0) {
        safetyStatus = "BELOW_SAFETY_BUFFER";
        tradeoffs.push("Projected balance falls below temporal required liquidity buffer");
      } else if (minCoverageRatio >= 1.5) {
        safetyStatus = "EXCEEDS_SAFETY_BUFFER";
        strengths.push("Maintains safe operational buffer above safety threshold");
      } else {
        strengths.push("Maintains safe operational buffer above safety threshold");
      }

      if (!hasReschedulePayout) {
        strengths.push("Protects critical vendor payment relationships");
      } else {
        tradeoffs.push("Reschedules critical vendor payout, affecting vendor relations");
      }
      if (disruptionPenalty > 0) {
        tradeoffs.push(`Incurs operational friction of ${disruptionPenalty} disruption points`);
      }

      return {
        ...strategy,
        score: isWorseThanBaseline ? 0 : Math.min(100, Math.max(60, finalScore)),
        recommended: false,
        scoring: {
          liquiditySafety,
          deficitElimination,
          criticalObligationProtection,
          lowDisruption,
          executionConfidence,
          finalScore,
          tier: "Tier I (Deficit Resolved)",
          strengths,
          tradeoffs,
          disqualifications,
          requiredBuffer: safetyThreshold,
          projectedMinimumBalance: minBalance,
          bufferCoverageRatio: parseFloat(minCoverageRatio.toFixed(2)),
          safetyStatus,
          criticalObligations: {
            count: criticalObligationsCount,
            amount: criticalObligationsAmount,
            protected: criticalObligationsProtected,
          },
          temporalRisk: {
            firstCriticalDate: firstCriticalDate,
            criticalAmount: criticalAmount,
          },
          requiredLiquidityByDay: requiredLiquidityByDay,
          counterfactual: {
            baselineMinimumBalance,
            strategyMinimumBalance,
            minimumBalanceDelta,
            baselineDeficitDays,
            strategyDeficitDays,
            deficitDaysDelta,
            baselineCoverageRatio: parseFloat(baselineCoverageRatio.toFixed(2)),
            strategyCoverageRatio: parseFloat(minCoverageRatio.toFixed(2)),
            coverageRatioDelta: parseFloat(coverageRatioDelta.toFixed(2)),
            baselineCriticalObligationsProtected: baselineProtectedCount,
            strategyCriticalObligationsProtected: strategyProtectedCount,
            criticalObligationsProtectedDelta,
            effectiveness,
          },
          deferredObligations: scoringDeferredObligations,
        },
      };
    }

    // TIER II: Deficit Persists (Score mapped to [0, 59])
    const liquiditySafety = 30;

    const currentDeficit = Math.abs(minBalance);
    const reductionFraction = baselineDeficit > 0 ? (baselineDeficit - currentDeficit) / baselineDeficit : 0;
    const deficitElimination = Math.max(0, Math.round(100 * reductionFraction));

    const deficitDays = strategy.forecast.filter((day) => day.closingBalance < 0).length;
    const durationScore = Math.max(0, Math.round(100 - 100 * (deficitDays / 14)));

    const groupIIBaseScore = 
      0.60 * deficitElimination +
      0.20 * durationScore +
      0.10 * lowDisruption +
      0.10 * executionConfidence;

    const finalScore = isWorseThanBaseline ? 0 : Math.round(59 * (groupIIBaseScore / 100));

    disqualifications.push("Fails to fully resolve projected insolvency within the 14-day window");
    if (deficitElimination > 0) {
      strengths.push(`Reduces projected insolvency deficit by ${Math.round(reductionFraction * 100)}%`);
    }
    tradeoffs.push(`Leaves business in deficit for ${deficitDays} days`);

    const safetyStatus = "DEFICIT" as const;

    return {
      ...strategy,
      score: isWorseThanBaseline ? 0 : Math.min(59, Math.max(0, finalScore)),
      recommended: false,
      scoring: {
        liquiditySafety,
        deficitElimination, // relative deficit reduction score
        criticalObligationProtection,
        lowDisruption,
        executionConfidence,
        finalScore,
        tier: "Tier II (Deficit Persists)",
        strengths,
        tradeoffs,
        disqualifications,
        requiredBuffer: safetyThreshold,
        projectedMinimumBalance: minBalance,
        bufferCoverageRatio: 0,
        safetyStatus,
        criticalObligations: {
          count: criticalObligationsCount,
          amount: criticalObligationsAmount,
          protected: false,
        },
        temporalRisk: {
          firstCriticalDate: firstCriticalDate,
          criticalAmount: criticalAmount,
        },
        requiredLiquidityByDay: requiredLiquidityByDay,
        counterfactual: {
          baselineMinimumBalance,
          strategyMinimumBalance,
          minimumBalanceDelta,
          baselineDeficitDays,
          strategyDeficitDays,
          deficitDaysDelta,
          baselineCoverageRatio: parseFloat(baselineCoverageRatio.toFixed(2)),
          strategyCoverageRatio: parseFloat(minCoverageRatio.toFixed(2)),
          coverageRatioDelta: parseFloat(coverageRatioDelta.toFixed(2)),
          baselineCriticalObligationsProtected: baselineProtectedCount,
          strategyCriticalObligationsProtected: strategyProtectedCount,
          criticalObligationsProtectedDelta,
          effectiveness,
        },
        deferredObligations: scoringDeferredObligations,
      },
    };
  });

  /**
   * Whether this plan actually leaves the business above its safety floor.
   *
   * Tier and safety are two different questions and the scoring keeps them
   * apart on purpose: Tier I means the deficit is resolved — solvent — while
   * safetyStatus says whether the floor the business set for itself is met.
   * A plan can be Tier I and BELOW_SAFETY_BUFFER, and that combination is not
   * a contradiction.
   *
   * It became one at the point of RECOMMENDATION. Ranking on score alone put a
   * plan reaching Rs 2,60,000 (score 90) above the only plan reaching the
   * Rs 4,28,571 floor (score 75), because the safe plan carried three actions
   * and a deferred obligation and was penalised for the disruption. So the
   * engine recommended, and the operator approved and executed, a plan the very
   * next screen correctly described as Rs 1,68,571 short.
   *
   * Disruption is the right thing to weigh between plans that both get you
   * home. It is not a reason to prefer one that does not.
   *
   * MEASURED AGAINST THE FLOOR THE PRODUCT REPORTS
   *
   * Deliberately `minimumBalance >= safetyThreshold` and not `safetyStatus`.
   * The two are different floors: safetyStatus compares each day against the
   * TEMPORAL required liquidity for that day, which is stricter and is a better
   * diagnostic, while safetyThreshold is the single figure every screen shows
   * as "safe minimum to hold" and the one describeSafetyProgress subtracts to
   * say how short you are.
   *
   * Ranking against the temporal measure while reporting the flat one would
   * rebuild the same mismatch in a subtler place: a plan that clears the floor
   * the operator is shown would still be ranked behind one that does not,
   * because of a threshold nothing on screen mentions. safetyStatus keeps its
   * meaning and is left untouched.
   */
  const clearsSafetyFloor = (s: ScoredStrategy) =>
    s.runway.minimumBalance >= safetyThreshold;

  // Sort and assign rank/recommendation with strict deterministic tie-breaking:
  // 1. Reaches the safety floor
  // 2. Higher final score
  // 3. Higher minimum balance
  // 4. Fewer deficit days
  // 5. Lower disruption penalty
  // 6. Strategy Name alphabetical order (stable fallback)
  const sorted = [...scored].sort((a, b) => {
    const aClears = clearsSafetyFloor(a);
    const bClears = clearsSafetyFloor(b);
    if (aClears !== bClears) return aClears ? -1 : 1;

    if (b.score !== a.score) return b.score - a.score;
    if (b.runway.minimumBalance !== a.runway.minimumBalance) return b.runway.minimumBalance - a.runway.minimumBalance;
    
    const aDefDays = a.forecast.filter((d) => d.closingBalance < 0).length;
    const bDefDays = b.forecast.filter((d) => d.closingBalance < 0).length;
    if (aDefDays !== bDefDays) return aDefDays - bDefDays;

    const aDisrupt = a.actions.reduce((sum, act) => sum + getActionDisruptionPenalty(act.type), 0);
    const bDisrupt = b.actions.reduce((sum, act) => sum + getActionDisruptionPenalty(act.type), 0);
    if (aDisrupt !== bDisrupt) return aDisrupt - bDisrupt;

    return a.name.localeCompare(b.name);
  });

  return sorted.map((s, idx) => {
    const isRecommended = idx === 0;
    
    return {
      ...s,
      recommended: isRecommended,
      scoring: {
        ...s.scoring,
        rank: idx + 1,
      },
    };
  });
}
