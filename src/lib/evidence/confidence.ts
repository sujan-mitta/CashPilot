/**
 * Phase 2 - PROVISIONAL evidence confidence.
 *
 * The real multi-dimensional confidence model is Phase 3 (spec §10-12): source
 * reliability, freshness, specificity, historical accuracy and cross-source
 * consistency, each tracked separately and combined by a justified formula.
 *
 * Phase 2 needs *something* to store so the pipeline is exercisable, but must
 * not manufacture precision (spec §11, §64). So it computes only the two
 * components it can derive honestly today - source reliability and freshness -
 * leaves the predictive components null, and sets the aggregate to reliability
 * alone. Phase 3 replaces `provisionalConfidence` wholesale.
 *
 * Critically (spec §12): these are SOURCE reliabilities - how much we trust that
 * the source correctly reports what it observed - NOT prediction confidence. A
 * bank reliably reports that money moved; it says nothing about whether a future
 * payment will arrive on time.
 */

/** Source reliability for *reporting an observation*, in [0,1]. Not prediction. */
const SOURCE_RELIABILITY: Record<string, number> = {
  BANK: 0.98, // actual cash movement
  RAZORPAY: 0.95, // provider-side payment/settlement events
  ERP: 0.9, // invoice/bill existence, contractual terms
  INVOICE: 0.85, // extracted invoice document fields
  USER: 0.8, // explicit user-confirmed expectation
  HISTORICAL: 0.6, // behavioural model (depends on sample size - refined in P9)
  EMAIL: 0.5, // customer/supplier stated intention
};

const DEFAULT_RELIABILITY = 0.5;

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
  const score = Math.pow(0.5, ageDays / halfLifeDays);
  return Math.min(1, Math.max(0, score));
}

export interface ProvisionalConfidence {
  reliabilityScore: number;
  freshnessScore: number;
  /** Aggregate in [0,1]. Provisional: equals reliability until Phase 3. */
  derivedConfidence: number;
}

/**
 * Provisional confidence for one piece of evidence. Phase 3 will combine the
 * components (and add specificity / historical accuracy / consistency); today
 * the aggregate is reliability alone so we never pretend to more certainty than
 * a single honestly-known dimension supports.
 */
export function provisionalConfidence(
  sourceType: string,
  observedAt: Date,
  now: Date = new Date()
): ProvisionalConfidence {
  const reliability = sourceReliability(sourceType);
  const freshness = freshnessScore(observedAt, now);
  return {
    reliabilityScore: reliability,
    freshnessScore: freshness,
    derivedConfidence: reliability,
  };
}

/**
 * Aggregate a claim's confidence from its evidence. Provisional (spec §14, §5
 * cross-source resolution is Phase 5): the strongest supporting evidence wins,
 * which is a defensible floor - a claim is at least as trustworthy as its best
 * evidence - without inventing a fusion formula. Returns 0 for no evidence.
 */
export function aggregateClaimConfidence(evidenceConfidences: number[]): number {
  if (evidenceConfidences.length === 0) return 0;
  return Math.max(...evidenceConfidences);
}
