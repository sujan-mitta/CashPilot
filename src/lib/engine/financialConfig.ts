/**
 * Single source of truth for every business-rule constant in CashPilot.
 *
 * Phase 14 requirement: no business-rule number may be defined in more than one
 * place. Modules that previously held private copies (forecast.ts, riskDetector.ts,
 * scorer.ts) now re-export from here.
 *
 * All monetary values are in PAISE (1 rupee = 100 paise, 1 lakh = 10,000,000 paise).
 */
export interface FinancialConfig {
  SAFETY_THRESHOLD: number;
  SAFETY_BUFFER_COVERAGE_DAYS: number;
  SAFETY_BUFFER_MIN_FLOOR: number;
  FORECAST_HORIZON_DAYS: number;
  RESCHEDULE_DELAY_DAYS: number;
  HISTORICAL_LOOKBACK_DAYS: number;
  BEHAVIOR_HISTORY_LOOKBACK_DAYS: number;
  DECISION_TTL_HOURS: number;
  OUTCOME_WINDOW_DAYS: number;
  OUTCOME_VARIANCE_THRESHOLD: number;
  EXECUTION_DRIFT_THRESHOLD: number;
  FRESHNESS_MATERIALITY_RATIO: number;
  FRESHNESS_BUFFER_DRIFT_THRESHOLD: number;
  FRESHNESS_DUE_DATE_TOLERANCE_DAYS: number;
  INTENT_DISPATCH_TIMEOUT_MS: number;
  PROVIDER_LIST_SETTLING_MS: number;
  PROVIDER_NOT_FOUND_COOLING_MS: number;
  SCORING_CONFIG_VERSION: string;
  LIQUIDITY_CONFIG_VERSION: string;
  OUTCOME_RULES_VERSION: string;
  MIN_PERFORMANCE_SAMPLE_SIZE: number;
  DECISION_PAGE_SIZE_DEFAULT: number;
  DECISION_PAGE_SIZE_MAX: number;
  DECAY_RATE: number;
  RESCHEDULE_PENALTY: number;
  COLLECTIONS_DISRUPTION: number;
  PAUSE_EXPENSE_DISRUPTION: number;
  RESCHEDULE_PAYOUT_DISRUPTION: number;
  RECOVER_FAILED_PAYMENTS_CONFIDENCE: number;
  PRIORITIZE_COLLECTIONS_CONFIDENCE: number;
  PAUSE_EXPENSE_CONFIDENCE: number;
  RESCHEDULE_PAYOUT_CONFIDENCE: number;
  OUTLIER_MULTIPLE: number;
  ENGINE_VERSION: string;
}

export const FINANCIAL_CONFIG: FinancialConfig = {
  /**
   * Default operational safety threshold used when a business-specific adaptive
   * buffer cannot be computed. ₹2.5L in paise.
   */
  SAFETY_THRESHOLD: 25000000,

  /** Days of average daily outflow the adaptive safety buffer aims to cover. */
  SAFETY_BUFFER_COVERAGE_DAYS: 3,

  /**
   * Absolute minimum safety buffer (₹50,000 in paise). Prevents a micro business
   * with near-zero outflow history from being told a zero buffer is safe.
   */
  SAFETY_BUFFER_MIN_FLOOR: 5000000,

  /** Forecast/simulation horizon in days. */
  FORECAST_HORIZON_DAYS: 14,

  /**
   * How far a rescheduled vendor payout is pushed out, in days from today.
   *
   * There used to be THREE numbers for this one fact: the executor moved the
   * payout to FORECAST_HORIZON_DAYS + 6 (day 20), the simulation defaulted to
   * day 15, and the approval screen told the operator "day 15" in prose. So the
   * human approval gate displayed a date the system would not honour - the
   * worst place in the product for a figure to be wrong.
   *
   * Deliberately beyond FORECAST_HORIZON_DAYS: the point of the action is to
   * move the obligation out of the pressure window. That it lands OUTSIDE the
   * forecast is exactly why the decision also carries
   * `outcomeMeasurementHorizonDays`, so measurement still sees it come due.
   */
  RESCHEDULE_DELAY_DAYS: 20,

  /** Days of history used to compute the outflow run-rate. */
  HISTORICAL_LOOKBACK_DAYS: 30,

  /**
   * How far back payment-behaviour history is read, in days (Phase 9).
   *
   * Deliberately NOT HISTORICAL_LOOKBACK_DAYS, which is 30 days because it
   * measures an outflow run-rate. Payment behaviour needs a year: a customer
   * invoiced monthly produces one observation a month, so a 30-day window would
   * never reach the five payments the model requires before it will act.
   */
  BEHAVIOR_HISTORY_LOOKBACK_DAYS: 365,

  /**
   * How long a recommendation stays executable on age alone (spec §32).
   *
   * Seven days, chosen against the 14-day forecast horizon: a plan built to
   * protect a fortnight has spent half of it before it expires. Content and
   * state changes already block sooner than this in any active ledger; the TTL
   * only catches the case where nothing OBSERVED changed for a week, which is
   * itself a reason to distrust the inputs rather than the arithmetic.
   */
  DECISION_TTL_HOURS: 168,

  /**
   * Outcome measurement window in days. Deliberately equal to the forecast
   * horizon: we only claim to have measured what we predicted.
   */
  OUTCOME_WINDOW_DAYS: 14,

  /**
   * Fraction of starting cash by which actual minimum balance may deviate from
   * prediction before the outcome is flagged HIGH_VARIANCE_OUTCOME.
   */
  OUTCOME_VARIANCE_THRESHOLD: 0.2,

  /**
   * Fraction by which live cash may drift from the simulation baseline before
   * execution is refused as materially outdated.
   */
  EXECUTION_DRIFT_THRESHOLD: 0.05,

  /**
   * A change is material when it is at least this fraction of the larger of
   * starting cash and the required buffer. Scale-relative, so the same rule
   * works for a corner shop and a large distributor.
   */
  FRESHNESS_MATERIALITY_RATIO: 0.05,

  /** Fractional move in the adaptive buffer that counts as material. */
  FRESHNESS_BUFFER_DRIFT_THRESHOLD: 0.1,

  /** Obligation date shift, in days, that counts as material. */
  FRESHNESS_DUE_DATE_TOLERANCE_DAYS: 1,

  /**
   * How long an ExecutionIntent may sit in DISPATCHING before it is presumed
   * abandoned by a dead process and swept to UNKNOWN.
   */
  INTENT_DISPATCH_TIMEOUT_MS: 120000,

  /**
   * How long a provider operation must have existed before its ABSENCE from the
   * provider's list endpoint may be treated as proof it never happened.
   *
   * VERIFIED_LIVE (Phase 18): Razorpay's `paymentLink.all` is eventually
   * consistent. A link created at t+0 was visible to `fetch(id)` at +1.0s but
   * was NOT in `all()` at +1.8s, appearing only at +6.0s. Concluding NOT_FOUND
   * inside that window marks a live payment link as never-created and unlocks a
   * retry - which is how a customer gets two payment links for one debt.
   *
   * Set to 60s: ten times the largest lag observed, and still far below the
   * dispatch timeout, so it costs nothing in the normal path.
   */
  PROVIDER_LIST_SETTLING_MS: 60000,

  /**
   * How long after an operation was recorded a NOT_FOUND may be concluded at
   * all, once the settling period above has passed.
   *
   * Was hard-coded inline at 24h with no stated reasoning (C-9). Lifted here so
   * the two timing bounds are read together and can be tuned from evidence
   * rather than edited in the middle of a branch.
   *
   * The two are doing different jobs. PROVIDER_LIST_SETTLING_MS covers the
   * MEASURED eventual-consistency lag of the list endpoint (~6s observed, 60s
   * chosen as margin). This one is not a measurement at all: it is how long we
   * decline to convert "we cannot see it" into "it never happened" for an
   * operation whose provider outcome was never confirmed. Twenty-four hours is
   * deliberately far beyond any plausible provider lag, because the cost is
   * asymmetric — a delayed NOT_FOUND holds up one retry, while a premature one
   * unlocks a second payment link for a debt the customer may already have paid.
   *
   * Do not reduce this without evidence about the provider's real behaviour.
   * The 60s above is backed by a live measurement; this is not, and shortening
   * it trades a bounded delay for an unbounded double-charge risk.
   */
  PROVIDER_NOT_FOUND_COOLING_MS: 24 * 60 * 60 * 1000,

  /**
   * Minimum number of MEASURED decisions before a per-strategy performance
   * aggregate may be presented as statistically meaningful.
   * PRINCIPLE 12: small sample != reliable performance statistic.
   */
  MIN_PERFORMANCE_SAMPLE_SIZE: 5,

  /** Maximum decisions returned by a single history page. */
  DECISION_PAGE_SIZE_DEFAULT: 25,
  DECISION_PAGE_SIZE_MAX: 100,

  /** Daily confidence decay applied per day of delay before an action lands. */
  DECAY_RATE: 0.96,

  /** Protection points deducted for postponing a vendor payout. */
  RESCHEDULE_PENALTY: 40,

  /** Operational disruption values (higher is worse operational friction). */
  COLLECTIONS_DISRUPTION: 10,
  PAUSE_EXPENSE_DISRUPTION: 20,
  RESCHEDULE_PAYOUT_DISRUPTION: 30,

  /** Base per-action execution confidence values. */
  RECOVER_FAILED_PAYMENTS_CONFIDENCE: 70,
  PRIORITIZE_COLLECTIONS_CONFIDENCE: 65,
  PAUSE_EXPENSE_CONFIDENCE: 95,
  RESCHEDULE_PAYOUT_CONFIDENCE: 80,

  /**
   * A historical outflow larger than this multiple of the computed daily
   * run-rate is reported as an outlier that skews the buffer.
   */
  OUTLIER_MULTIPLE: 3,

  /** Engine version stamped onto new decisions. Historical decisions keep theirs. */
  ENGINE_VERSION: "15.0.0",

  /**
   * Configuration identities stamped onto a decision (PART 27), so a historical
   * decision can answer which rules produced it without consulting today's config.
   * Bump the relevant one whenever its rules change.
   */
  SCORING_CONFIG_VERSION: "15.0.0",
  LIQUIDITY_CONFIG_VERSION: "15.0.0",
  OUTCOME_RULES_VERSION: "15.0.0",
};

/**
 * Largest magnitude a single monetary field may hold before we refuse to treat
 * it as a real figure. 2^53 paise is far beyond any real balance sheet, and
 * staying under Number.MAX_SAFE_INTEGER keeps integer arithmetic exact.
 */
const MAX_SAFE_PAISE = Number.MAX_SAFE_INTEGER;

/**
 * Returns true only for a finite, non-NaN number inside the safe integer range.
 * PRINCIPLE: missing or corrupt financial data must never be silently coerced
 * to zero, because zero is itself a meaningful (and reassuring) balance.
 */
export function isUsableAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_SAFE_PAISE
  );
}

/**
 * Divides two monetary quantities, returning null rather than NaN/Infinity when
 * the ratio is undefined. Callers must decide how to present "unavailable".
 */
export function safeRatio(numerator: unknown, denominator: unknown): number | null {
  if (!isUsableAmount(numerator) || !isUsableAmount(denominator)) return null;
  if (denominator === 0) return null;
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) ? ratio : null;
}
