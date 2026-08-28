import { ClaimType } from "../../../generated/prisma/client";

/**
 * Phase 3 - source-specific, multi-dimensional, claim-aware confidence
 * (spec §10-12).
 *
 * The core distinction the whole product depends on (spec §12): the reliability
 * of a SOURCE is not the confidence of a CLAIM. A bank reliably reports that
 * money moved, but a bank record of a *pending* inflow says little about whether
 * the future payment will land on time. So confidence is computed in two steps:
 *
 *   sourceConfidence  = reliability x freshness           (trust in the observation)
 *   derivedConfidence = sourceConfidence, modulated by...
 *       - specificity                          (how precise the observation is)
 *       - and, for PREDICTIVE claims only, historical accuracy + cross-source
 *         consistency                          (can we trust the prediction?)
 *
 * Dimensions we cannot compute honestly yet are carried as null rather than
 * invented (spec §11, §64): historical accuracy needs the behaviour model
 * (Phase 9) and consistency needs cross-source reconciliation (Phase 5). Until
 * those arrive, a prediction with no track record is capped conservatively
 * instead of being assumed reliable.
 */

/** Source reliability for *reporting an observation*, in [0,1]. Not prediction. */
const SOURCE_RELIABILITY: Record<string, number> = {
  BANK: 0.98, // actual cash movement
  RAZORPAY: 0.95, // provider-side payment/settlement events
  ERP: 0.9, // invoice/bill existence, contractual terms
  INVOICE: 0.85, // extracted invoice document fields
  USER: 0.8, // explicit user-confirmed expectation
  HISTORICAL: 0.6, // behavioural model (sharpened by sample size in P9)
  EMAIL: 0.5, // customer/supplier stated intention
};

const DEFAULT_RELIABILITY = 0.5;

/** Claim types that assert a KNOWN fact rather than a prediction (spec §13). */
const FACTUAL_CLAIMS: ReadonlySet<ClaimType> = new Set<ClaimType>([
  "ACTUAL",
  "CONFIRMED",
  "CONTRACTUAL",
  "RECONCILED",
  "CONTRADICTED",
  "EXPIRED",
]);

/** EXPECTED / PREDICTED / UNCERTAIN carry genuine prediction uncertainty. */
export function isPredictiveClaim(claimType: ClaimType): boolean {
  return !FACTUAL_CLAIMS.has(claimType);
}

/** Reliability of a source for reporting what it observed, in [0,1]. */
export function sourceReliability(sourceType: string): number {
  return SOURCE_RELIABILITY[sourceType.toUpperCase()] ?? DEFAULT_RELIABILITY;
}

/**
 * Freshness in [0,1] with a half-life decay: 1.0 at observation, 0.5 after one
 * half-life, approaching 0 for very stale evidence. Future observations (clock
 * skew) are clamped to 1.0.
 */
export function freshnessScore(observedAt: Date, now: Date, halfLifeDays = 7): number {
  const ageMs = now.getTime() - observedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return clamp01(Math.pow(0.5, ageDays / halfLifeDays));
}

/** Signals that make an observation more or less specific/precise. */
export interface SpecificitySignals {
  /** The observation carries an exact monetary amount. */
  hasExactAmount?: boolean;
  /** The observation carries an exact date, not a vague window. */
  hasExactDate?: boolean;
}

/**
 * Specificity in [0,1]: a bank line with an exact amount and date is fully
 * specific; a vague "we'll pay soon" is not. Base 0.4, +0.3 for an exact amount,
 * +0.3 for an exact date.
 */
export function specificityScore(signals: SpecificitySignals): number {
  let s = 0.4;
  if (signals.hasExactAmount) s += 0.3;
  if (signals.hasExactDate) s += 0.3;
  return clamp01(s);
}

export interface ConfidenceInput {
  sourceType: string;
  claimType: ClaimType;
  observedAt: Date;
  now?: Date;
  specificity?: SpecificitySignals;
  /** Source's historical prediction accuracy in [0,1], or null if unknown (P9). */
  historicalAccuracyScore?: number | null;
  /** Cross-source agreement in [0,1], or null if unknown (P5). */
  consistencyScore?: number | null;
}

export interface ConfidenceResult {
  reliabilityScore: number;
  freshnessScore: number;
  specificityScore: number;
  historicalAccuracyScore: number | null;
  consistencyScore: number | null;
  /** reliability x freshness - trust in the observation itself (§12). */
  sourceConfidence: number;
  /** Claim-appropriate confidence in [0,1]. */
  derivedConfidence: number;
  /** True if prediction uncertainty was applied. */
  isPrediction: boolean;
  /** Which predictive dimensions were available. */
  completeness: "FULL" | "PARTIAL" | "MINIMAL";
}

/** A prediction with no track record and no corroboration cannot exceed this. */
const UNKNOWN_PREDICTION_CAP = 0.6;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function geometricMean(xs: number[]): number {
  if (xs.length === 0) return 1;
  const product = xs.reduce((a, b) => a * b, 1);
  return Math.pow(product, 1 / xs.length);
}

/**
 * Compute the full, claim-aware confidence for one piece of evidence.
 *
 * Factual claims (a settled transaction, a contractual due date) are sharpened
 * by specificity but carry no prediction penalty - a fact is a fact. Predictive
 * claims are additionally modulated by whatever predictive signal exists
 * (specificity + historical accuracy + consistency); with none of the verifiable
 * signals present, the prediction is capped conservatively rather than trusted.
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const now = input.now ?? new Date();
  const reliability = sourceReliability(input.sourceType);
  const freshness = freshnessScore(input.observedAt, now);
  const specificity = specificityScore(input.specificity ?? {});
  const hist = input.historicalAccuracyScore ?? null;
  const cons = input.consistencyScore ?? null;

  const sourceConfidence = clamp01(reliability * freshness);
  const isPrediction = isPredictiveClaim(input.claimType);

  let derivedConfidence: number;
  if (!isPrediction) {
    // Known fact: specificity sharpens, but no prediction penalty (§12).
    derivedConfidence = clamp01(sourceConfidence * (0.7 + 0.3 * specificity));
  } else {
    const predictiveDims = [specificity];
    if (hist !== null) predictiveDims.push(hist);
    if (cons !== null) predictiveDims.push(cons);
    let predictionFactor = geometricMean(predictiveDims);
    if (hist === null && cons === null) {
      // No verifiable prediction signal beyond specificity: stay conservative.
      predictionFactor = Math.min(predictionFactor, UNKNOWN_PREDICTION_CAP);
    }
    derivedConfidence = clamp01(sourceConfidence * predictionFactor);
  }

  const knownPredictive = (hist !== null ? 1 : 0) + (cons !== null ? 1 : 0);
  const completeness = knownPredictive === 2 ? "FULL" : knownPredictive === 1 ? "PARTIAL" : "MINIMAL";

  return {
    reliabilityScore: reliability,
    freshnessScore: freshness,
    specificityScore: specificity,
    historicalAccuracyScore: hist,
    consistencyScore: cons,
    sourceConfidence,
    derivedConfidence,
    isPrediction,
    completeness,
  };
}

/**
 * Aggregate a claim's confidence from its evidence. The strongest supporting
 * evidence wins - a claim is at least as trustworthy as its best evidence -
 * which is a defensible floor without inventing a fusion formula. Cross-source
 * corroboration/contradiction is Phase 5. Returns 0 for no evidence.
 */
export function aggregateClaimConfidence(evidenceConfidences: number[]): number {
  if (evidenceConfidences.length === 0) return 0;
  return Math.max(...evidenceConfidences);
}
