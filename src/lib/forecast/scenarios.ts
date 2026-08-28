import { buildForecast, calculateRunway, type ForecastDay, type DailyMovement } from "@/lib/engine/forecast";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import type { ForecastEvent } from "./forecastEvent";

/**
 * Phase 10 - scenario forecasting (spec §28, §29).
 *
 * Three futures from one set of forecast events, built from the uncertainty
 * band Phase 9 attaches to each event.
 *
 * ## Deterministic brackets, not a probability model
 *
 * Spec §28 permits a probabilistic model but demands its assumptions be
 * explicit and validated against historical data. We have neither a fitted
 * distribution nor the history to validate one, so this does something simpler
 * and defensible instead: it brackets the outcomes by taking each event at the
 * ends of its OWN observed range.
 *
 *   CONSERVATIVE - money in as late as it plausibly comes, money out as early
 *   BASE         - everything on its expected date
 *   OPTIMISTIC   - money in as early as it plausibly comes, money out as late
 *
 * The band comes from measured payment behaviour, so the spread is an
 * observation about this customer rather than a guessed confidence interval.
 * Nothing here invents a percentile.
 *
 * ## The trap this module deliberately avoids
 *
 * When no behaviour exists, all three scenarios collapse onto the contractual
 * dates and the spread is zero. It is tempting to read zero spread as high
 * confidence. It is the opposite: a zero band means we have NO information
 * about timing and are assuming the contractual date - the one assumption we
 * know is usually wrong. A degenerate scenario set is therefore reported as LOW
 * confidence, never HIGH (§29, §64).
 */

export type ScenarioName = "OPTIMISTIC" | "BASE" | "CONSERVATIVE";

export interface ScenarioForecast {
  scenario: ScenarioName;
  days: ForecastDay[];
  /** Balance at the end of the horizon. */
  closingBalance: number;
  /** Lowest projected balance across the horizon - what actually matters. */
  minimumBalance: number;
  /** 1-based day of the minimum. */
  minimumBalanceDay: number;
  /** First day below the liquidity requirement, or null. */
  firstDayBelowSafety: number | null;
}

export type ForecastConfidenceLevel = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface ForecastConfidence {
  /** The headline a user sees (§29). */
  level: ForecastConfidenceLevel;
  /** Forecast events considered. */
  eventsTotal: number;
  /** Events whose timing came from measured behaviour rather than assumption. */
  eventsWithMeasuredTiming: number;
  /** Widest band on any single event, in days. */
  widestBandDays: number;
  /** Spread between the optimistic and conservative minimum, in paise. */
  outcomeSpread: number;
  /** Plain-language drivers, safe to show a user (§58). */
  reasons: string[];
}

export interface ScenarioSet {
  optimistic: ScenarioForecast;
  base: ScenarioForecast;
  conservative: ScenarioForecast;
  /**
   * True when all three scenarios coincide - no uncertainty is modelled at all.
   * This is a statement about our ignorance, not about the future being certain.
   */
  degenerate: boolean;
  confidence: ForecastConfidence;
}

export interface ScenarioOptions {
  horizonDays?: number;
  startDate?: Date;
  /** Liquidity requirement, for the below-safety day. */
  requiredBuffer?: number;
}

/**
 * Place an event at the end of its band that is WORST for cash: inflows as late
 * as they come, outflows as early as they go.
 */
function conservativeDate(e: ForecastEvent): Date {
  return e.kind === "INFLOW" ? e.latestDate : e.earliestDate;
}

/** The mirror image: inflows early, outflows late. */
function optimisticDate(e: ForecastEvent): Date {
  return e.kind === "INFLOW" ? e.earliestDate : e.latestDate;
}

function toMovements(events: ForecastEvent[], dateFor: (e: ForecastEvent) => Date): DailyMovement[] {
  return events.map((e) => ({
    date: dateFor(e),
    inflows: e.kind === "INFLOW" ? e.amount : 0,
    outflows: e.kind === "OUTFLOW" ? e.amount : 0,
    description: e.description || undefined,
    transactionId: e.id,
  }));
}

function runScenario(
  scenario: ScenarioName,
  currentCash: number,
  events: ForecastEvent[],
  dateFor: (e: ForecastEvent) => Date,
  horizonDays: number,
  startDate: Date,
  requiredBuffer: number
): ScenarioForecast {
  const days = buildForecast(currentCash, toMovements(events, dateFor), horizonDays, startDate);
  const runway = calculateRunway(days, requiredBuffer);

  return {
    scenario,
    days,
    closingBalance: days[days.length - 1]?.closingBalance ?? currentCash,
    minimumBalance: runway.minimumBalance,
    minimumBalanceDay: runway.minimumBalanceDay,
    firstDayBelowSafety: runway.firstDayBelowSafety,
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Two forecasts describe the same future only if every day matches. */
function sameDayPath(a: ForecastDay[], b: ForecastDay[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (day, i) =>
      day.closingBalance === b[i].closingBalance &&
      day.expectedInflows === b[i].expectedInflows &&
      day.expectedOutflows === b[i].expectedOutflows
  );
}

/** Band width of one event, in days. */
function bandDays(e: ForecastEvent): number {
  return Math.abs(e.latestDate.getTime() - e.earliestDate.getTime()) / MS_PER_DAY;
}

/**
 * Build all three scenarios from one set of forecast events.
 *
 * Deterministic: the same events always produce the same three futures.
 */
export function buildScenarios(
  currentCash: number,
  events: ForecastEvent[],
  options: ScenarioOptions = {}
): ScenarioSet {
  const horizonDays = options.horizonDays ?? FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS;
  const startDate = options.startDate ?? new Date();
  const requiredBuffer = options.requiredBuffer ?? FINANCIAL_CONFIG.SAFETY_THRESHOLD;

  const base = runScenario(
    "BASE",
    currentCash,
    events,
    (e) => e.expectedDate,
    horizonDays,
    startDate,
    requiredBuffer
  );
  const optimistic = runScenario(
    "OPTIMISTIC",
    currentCash,
    events,
    optimisticDate,
    horizonDays,
    startDate,
    requiredBuffer
  );
  const conservative = runScenario(
    "CONSERVATIVE",
    currentCash,
    events,
    conservativeDate,
    horizonDays,
    startDate,
    requiredBuffer
  );

  // Compare the full day-by-day path, not just the minimum and the close.
  // Those two coincide for any set of pure inflows - the balance never dips, so
  // the minimum is always the opening balance - which would have reported a
  // forecast with real timing uncertainty as having none, and then handed it
  // the LOW-confidence "nothing is measured" reason. The scenarios are
  // degenerate only if they actually describe the same fortnight.
  const degenerate =
    sameDayPath(optimistic.days, base.days) && sameDayPath(conservative.days, base.days);

  return {
    optimistic,
    base,
    conservative,
    degenerate,
    confidence: deriveForecastConfidence(events, optimistic, conservative, degenerate),
  };
}

/** A band wider than this makes the picture genuinely uncertain. */
const WIDE_BAND_DAYS = 6;
/** Share of events needing measured timing before confidence can be HIGH. */
const HIGH_COVERAGE = 0.8;
const MEDIUM_COVERAGE = 0.4;

/**
 * Derive the headline confidence (spec §29).
 *
 * Rises with how much of the forecast rests on measured behaviour and falls as
 * the plausible outcome spread widens. Crucially, an ENTIRELY unmeasured
 * forecast is LOW - not HIGH - however tidy its single line looks.
 */
function deriveForecastConfidence(
  events: ForecastEvent[],
  optimistic: ScenarioForecast,
  conservative: ScenarioForecast,
  degenerate: boolean
): ForecastConfidence {
  const eventsTotal = events.length;
  // A measured event is one whose timing came from evidence, which is exactly
  // what a non-empty timingBasis guarantees (Phase 9).
  const measured = events.filter((e) => e.timingBasis.length > 0);
  const widestBandDays = events.reduce((max, e) => Math.max(max, bandDays(e)), 0);
  const outcomeSpread = Math.abs(optimistic.minimumBalance - conservative.minimumBalance);
  const reasons: string[] = [];

  if (eventsTotal === 0) {
    return {
      level: "UNKNOWN",
      eventsTotal: 0,
      eventsWithMeasuredTiming: 0,
      widestBandDays: 0,
      outcomeSpread: 0,
      reasons: ["No expected movements in the horizon."],
    };
  }

  const coverage = measured.length / eventsTotal;

  if (degenerate) {
    // The important inversion: no spread means no knowledge, not certainty.
    return {
      level: "LOW",
      eventsTotal,
      eventsWithMeasuredTiming: measured.length,
      widestBandDays,
      outcomeSpread,
      reasons: [
        "Every date is the contractual one; no payment history has been measured, so timing risk is unquantified.",
      ],
    };
  }

  let level: ForecastConfidenceLevel;
  if (coverage >= HIGH_COVERAGE && widestBandDays <= WIDE_BAND_DAYS) {
    level = "HIGH";
    reasons.push(
      `${measured.length} of ${eventsTotal} expected movements are timed from measured payment behaviour.`
    );
  } else if (coverage >= MEDIUM_COVERAGE) {
    level = "MEDIUM";
    reasons.push(
      `${measured.length} of ${eventsTotal} expected movements are timed from measured behaviour; the rest assume contractual dates.`
    );
  } else {
    level = "LOW";
    reasons.push(
      `Only ${measured.length} of ${eventsTotal} expected movements are timed from measured behaviour.`
    );
  }

  if (widestBandDays > WIDE_BAND_DAYS) {
    reasons.push(
      `Payment timing varies by up to ${Math.round(widestBandDays)} days for at least one counterparty.`
    );
  }

  return {
    level,
    eventsTotal,
    eventsWithMeasuredTiming: measured.length,
    widestBandDays,
    outcomeSpread,
    reasons,
  };
}
