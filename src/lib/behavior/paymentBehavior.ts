/**
 * Phase 9 - customer/supplier payment-behaviour intelligence (spec §25-27).
 *
 * The question this answers: an invoice is contractually due Sep 5 - when is
 * the money actually going to arrive? The existing forecast assumes "Sep 5",
 * which is the one thing we know is usually wrong.
 *
 * Three rules govern everything here.
 *
 * 1. **Sample size is explicit and named.** Spec §25 calls out that a bare
 *    `sampleSize` field is ambiguous, so nothing here is called that:
 *    `paymentHistorySampleSize` counts settled payments, `recentSampleSize`
 *    counts those inside the recency window, `forecastObservationCount` counts
 *    prediction/actual pairs. A test asserts no field is named `sampleSize`.
 *
 * 2. **Too little history means no opinion.** Below MIN_PAYMENTS_FOR_OPINION
 *    every metric is null and the verdict is INSUFFICIENT. Two payments do not
 *    establish a pattern, and a forecast that shifted a real invoice on that
 *    basis would be manufacturing certainty (§64).
 *
 * 3. **Recent behaviour outweighs old behaviour, but never erases it** (§26).
 *    A customer who was four days late for a year and has paid the last five on
 *    time is treated as mostly-reformed, not as certainly-reformed.
 */

/** One settled payment: what was owed when, and when it actually arrived. */
export interface PaymentObservation {
  /** Stable id of the invoice or obligation. */
  id: string;
  /** Paise. Kept for amount-weighted analysis in a later phase. */
  amount: number;
  /** The contractual date. */
  dueDate: Date;
  /** When the money actually arrived. */
  paidDate: Date;
}

/** One past prediction and how it turned out (spec §27). */
export interface PredictionObservation {
  predictedDate: Date;
  actualDate: Date;
}

export type BehaviorSufficiency =
  /** Enough history to shift a forecast. */
  | "SUFFICIENT"
  /** Some history - reportable, but not enough to move money on. */
  | "SPARSE"
  /** Not enough to say anything at all. */
  | "INSUFFICIENT";

export type BehaviorConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface PaymentBehavior {
  /** Settled payments observed. Never called `sampleSize` (§25). */
  paymentHistorySampleSize: number;
  /** Of those, how many fall inside the recency window. */
  recentSampleSize: number;

  /** Fraction paid on or before the due date, or null when unknown. */
  onTimeRate: number | null;
  recentOnTimeRate: number | null;

  /** Delay in days; negative means early. Null when unknown. */
  averageDelayDays: number | null;
  medianDelayDays: number | null;
  delayVarianceDays: number | null;
  delayStdDevDays: number | null;
  recentAverageDelayDays: number | null;

  /**
   * Recent mean minus older mean, in days. Positive = deteriorating, negative =
   * improving. Null when there is not enough history on both sides to compare.
   */
  delayTrendDays: number | null;

  /** How consistent the behaviour is, in [0,1]. Null when unknown. */
  behaviorStability: number | null;

  /**
   * The delay the forecast should actually apply, blending recent and overall
   * behaviour. Null unless SUFFICIENT - a forecast must not shift on a guess.
   */
  expectedDelayDays: number | null;
  /** Plausible spread around the expectation, in days. Null unless SUFFICIENT. */
  delaySpreadDays: number | null;

  sufficiency: BehaviorSufficiency;
  confidence: BehaviorConfidence;
  /** Plain-language basis, safe to show a user (§58). Empty when no opinion. */
  basis: string[];
}

export interface BehaviorOptions {
  /** Now, for deciding which payments count as recent. */
  now?: Date;
  /** Days back that counts as "recent" behaviour. */
  recencyWindowDays?: number;
  /** Payments needed before any opinion is offered. */
  minPayments?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Below this, the model has no opinion at all. Three is not a lot, but it is
 * the point at which "always late" stops being indistinguishable from noise;
 * SUFFICIENT additionally requires stable behaviour.
 */
const MIN_PAYMENTS_FOR_OPINION = 3;

/** Enough history to be worth acting on. */
const MIN_PAYMENTS_FOR_SUFFICIENCY = 5;

const DEFAULT_RECENCY_WINDOW_DAYS = 90;

/**
 * How many recent payments it takes for recency to reach full weight, and how
 * much weight it can reach. Capped below 1 deliberately: a run of good recent
 * behaviour should dominate the picture without erasing a long bad history
 * (§26).
 */
const RECENT_WEIGHT_TARGET_COUNT = 5;
const MAX_RECENT_WEIGHT = 0.7;

/** Delay spread beyond which behaviour is considered unstable, in days. */
const STABILITY_REFERENCE_DAYS = 7;

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  // Sample variance (n-1): these are a sample of behaviour, not the population.
  return xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** The empty verdict: used whenever there is nothing honest to say. */
function noOpinion(
  paymentHistorySampleSize: number,
  recentSampleSize: number,
  partial: Partial<PaymentBehavior> = {}
): PaymentBehavior {
  return {
    paymentHistorySampleSize,
    recentSampleSize,
    onTimeRate: null,
    recentOnTimeRate: null,
    averageDelayDays: null,
    medianDelayDays: null,
    delayVarianceDays: null,
    delayStdDevDays: null,
    recentAverageDelayDays: null,
    delayTrendDays: null,
    behaviorStability: null,
    expectedDelayDays: null,
    delaySpreadDays: null,
    sufficiency: "INSUFFICIENT",
    confidence: "UNKNOWN",
    basis: [],
    ...partial,
  };
}

/**
 * Build the payment-behaviour profile for one counterparty.
 *
 * Pure and deterministic. Callers must pass observations for ONE counterparty;
 * this function has no way to check that.
 */
export function computePaymentBehavior(
  observations: PaymentObservation[],
  options: BehaviorOptions = {}
): PaymentBehavior {
  const now = options.now ?? new Date();
  const windowDays = options.recencyWindowDays ?? DEFAULT_RECENCY_WINDOW_DAYS;
  const minPayments = options.minPayments ?? MIN_PAYMENTS_FOR_OPINION;

  // Guard the inputs rather than trusting them: a malformed row must be
  // excluded, not silently arithmetic'd into the mean.
  const usable = observations.filter(
    (o) =>
      o.dueDate instanceof Date &&
      o.paidDate instanceof Date &&
      Number.isFinite(o.dueDate.getTime()) &&
      Number.isFinite(o.paidDate.getTime())
  );

  const recent = usable.filter((o) => daysBetween(o.paidDate, now) <= windowDays);

  if (usable.length < minPayments) {
    return noOpinion(usable.length, recent.length);
  }

  const delays = usable.map((o) => daysBetween(o.dueDate, o.paidDate));
  const recentDelays = recent.map((o) => daysBetween(o.dueDate, o.paidDate));

  const avg = mean(delays);
  const med = median(delays);
  const varDays = variance(delays);
  const stdDev = Math.sqrt(varDays);
  const onTimeRate = delays.filter((d) => d <= 0).length / delays.length;

  const recentAvg = recentDelays.length > 0 ? mean(recentDelays) : null;
  const recentOnTime =
    recentDelays.length > 0 ? recentDelays.filter((d) => d <= 0).length / recentDelays.length : null;

  // Trend needs history on BOTH sides of the window to mean anything.
  const older = usable.filter((o) => daysBetween(o.paidDate, now) > windowDays);
  const olderDelays = older.map((o) => daysBetween(o.dueDate, o.paidDate));
  const trend =
    recentDelays.length > 0 && olderDelays.length > 0
      ? mean(recentDelays) - mean(olderDelays)
      : null;

  // Stability falls as the spread of delays grows. A customer who is reliably
  // six days late is highly stable; one who ranges from -3 to +20 is not.
  const behaviorStability = clamp01(1 - stdDev / STABILITY_REFERENCE_DAYS);

  const sufficiency: BehaviorSufficiency =
    usable.length >= MIN_PAYMENTS_FOR_SUFFICIENCY ? "SUFFICIENT" : "SPARSE";

  const basis: string[] = [];
  let expectedDelayDays: number | null = null;
  let delaySpreadDays: number | null = null;

  if (sufficiency === "SUFFICIENT") {
    // Recency weighting (§26): recent behaviour dominates as it accumulates,
    // but is capped so a long history is never entirely discarded.
    const recentWeight =
      recentAvg === null
        ? 0
        : Math.min(1, recentDelays.length / RECENT_WEIGHT_TARGET_COUNT) * MAX_RECENT_WEIGHT;

    const blended = recentAvg === null ? avg : recentWeight * recentAvg + (1 - recentWeight) * avg;

    expectedDelayDays = round1(blended);
    delaySpreadDays = round1(stdDev);

    basis.push(
      `${usable.length} settled payments, averaging ${round1(avg)} day(s) ${
        avg >= 0 ? "late" : "early"
      }`
    );
    if (recentAvg !== null && recentDelays.length > 0) {
      basis.push(
        `${recentDelays.length} in the last ${windowDays} days averaging ${round1(
          recentAvg
        )} day(s), weighted ${Math.round(recentWeight * 100)}%`
      );
    }
    if (trend !== null && Math.abs(trend) >= 1) {
      basis.push(
        trend > 0
          ? `payment behaviour has deteriorated by ${round1(trend)} day(s)`
          : `payment behaviour has improved by ${round1(-trend)} day(s)`
      );
    }
  }

  return {
    paymentHistorySampleSize: usable.length,
    recentSampleSize: recent.length,
    onTimeRate,
    recentOnTimeRate: recentOnTime,
    averageDelayDays: round1(avg),
    medianDelayDays: round1(med),
    delayVarianceDays: round1(varDays),
    delayStdDevDays: round1(stdDev),
    recentAverageDelayDays: recentAvg === null ? null : round1(recentAvg),
    delayTrendDays: trend === null ? null : round1(trend),
    behaviorStability: round1(behaviorStability),
    expectedDelayDays,
    delaySpreadDays,
    sufficiency,
    confidence: deriveConfidence(usable.length, behaviorStability, sufficiency),
    basis,
  };
}

/**
 * Confidence in the behavioural opinion (spec §29).
 *
 * Rises with observations and with consistency; a large but erratic history is
 * not a confident one.
 */
function deriveConfidence(
  count: number,
  stability: number,
  sufficiency: BehaviorSufficiency
): BehaviorConfidence {
  if (sufficiency !== "SUFFICIENT") return "UNKNOWN";
  if (count >= 10 && stability >= 0.7) return "HIGH";
  if (count >= 5 && stability >= 0.4) return "MEDIUM";
  return "LOW";
}

export interface PredictionAccuracy {
  /** Prediction/actual pairs observed. Never called `sampleSize` (§25). */
  forecastObservationCount: number;
  /** Mean absolute error in days, or null when there is nothing to measure. */
  meanAbsoluteErrorDays: number | null;
  /** Mean signed error; positive means we predicted too early. */
  meanSignedErrorDays: number | null;
  /**
   * Accuracy in [0,1] for use as `historicalAccuracyScore` in the Phase 3
   * confidence model. Null when unmeasured - never 0, which would read as
   * "measured and terrible" rather than "not yet measured".
   */
  accuracyScore: number | null;
}

/** Error at which accuracy has fallen to 0.5. */
const ACCURACY_HALF_ERROR_DAYS = 3;

/** Predictions needed before an accuracy score is offered. */
const MIN_PREDICTIONS_FOR_ACCURACY = 3;

/**
 * Measure how accurate this counterparty's past forecasts were (spec §27).
 *
 * This is the second half of the Phase 3 confidence gap: `consistencyScore`
 * arrived with Phase 5 reconciliation, and `historicalAccuracyScore` is this.
 */
export function computePredictionAccuracy(
  observations: PredictionObservation[]
): PredictionAccuracy {
  const usable = observations.filter(
    (o) =>
      o.predictedDate instanceof Date &&
      o.actualDate instanceof Date &&
      Number.isFinite(o.predictedDate.getTime()) &&
      Number.isFinite(o.actualDate.getTime())
  );

  if (usable.length < MIN_PREDICTIONS_FOR_ACCURACY) {
    return {
      forecastObservationCount: usable.length,
      meanAbsoluteErrorDays: null,
      meanSignedErrorDays: null,
      accuracyScore: null,
    };
  }

  const errors = usable.map((o) => daysBetween(o.predictedDate, o.actualDate));
  const mae = mean(errors.map(Math.abs));

  return {
    forecastObservationCount: usable.length,
    meanAbsoluteErrorDays: round1(mae),
    meanSignedErrorDays: round1(mean(errors)),
    // Smooth decay: 0 days error -> 1.0, 3 days -> 0.5, 9 days -> 0.25.
    accuracyScore: clamp01(1 / (1 + mae / ACCURACY_HALF_ERROR_DAYS)),
  };
}
