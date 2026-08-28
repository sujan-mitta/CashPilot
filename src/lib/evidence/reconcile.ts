import { ClaimType } from "../../../generated/prisma/client";
import {
  sourceAuthority,
  isAuthoritativeFor,
  questionForClaimType,
  type FinancialQuestion,
} from "./precedence";

/**
 * Phase 5 - cross-source reconciliation of INBOUND evidence (spec §14-17).
 *
 * Not to be confused with `execution/providerReconciliation.ts` and
 * `execution/ledgerReconciliation.ts`, which reconcile the outcome of an action
 * we took. This module reconciles what different sources are TELLING us about
 * the same money, before any decision is made on it.
 *
 * Two jobs:
 *
 *   1. A state machine (§15) over a group of observations about one subject:
 *      UNMATCHED -> CANDIDATE_MATCH -> MATCHED -> VERIFIED -> RECONCILED, with
 *      CONFLICT / DUPLICATE / MISSING / EXPIRED / UNKNOWN as exits.
 *
 *   2. A cross-source consistency score per observation, which is the missing
 *      input `computeConfidence` has been carrying as `null` since Phase 3.
 *      Until now every predictive claim was capped at UNKNOWN_PREDICTION_CAP
 *      because nothing could corroborate it; a corroborated observation can now
 *      exceed that cap, and a contradicted one drops below where it started.
 *
 * The governing rule (§14, §64): material disagreement is never silently
 * resolved. Two sources that disagree on an amount produce CONFLICT and a
 * reported delta - not an average, not the "more reliable" one's number.
 */

export type ReconciliationState =
  /** Only one source has said anything. Nothing to cross-check against. */
  | "UNMATCHED"
  /** Several sources are talking about this, but not comparably (no amounts). */
  | "CANDIDATE_MATCH"
  /** Two or more sources agree on the amount. */
  | "MATCHED"
  /** Agreed, AND a source authoritative for this question observed it. */
  | "VERIFIED"
  /** Verified with no outstanding contradiction. The terminal good state. */
  | "RECONCILED"
  /** Sources materially disagree. Never resolved automatically. */
  | "CONFLICT"
  /** The same source record was presented more than once. */
  | "DUPLICATE"
  /** An expectation came due and no authoritative source ever observed it. */
  | "MISSING"
  /** A missed expectation that has aged past its expiry policy. */
  | "EXPIRED"
  /** Not enough information to say anything. */
  | "UNKNOWN";

export type ContradictionType =
  | "AMOUNT_CONFLICT"
  | "EXPECTED_EVENT_MISSED"
  | "DUPLICATE_OBSERVATION";

export interface Contradiction {
  type: ContradictionType;
  /** Plain-language, safe to show a user. Never contains raw payloads. */
  detail: string;
  /** Source types involved, for the audit trail. */
  sources: string[];
}

/** One thing one source said about one subject. */
export interface SourceObservation {
  /** "BANK" | "ERP" | "RAZORPAY" | "EMAIL" | "USER" | "HISTORICAL" | ... */
  sourceType: string;
  /** Stable id at the source. Half of the duplicate identity. */
  sourceRecordId: string;
  /** Paise. Null for an observation that carries no amount. */
  amount: number | null;
  /** What kind of assertion this is - a fact, a promise, a prediction. */
  claimType: ClaimType;
  observedAt: Date;
  /** When the money is/was expected to move. */
  effectiveAt?: Date | null;
}

export interface ReconciliationInput {
  subjectType: string;
  subjectId: string;
  observations: SourceObservation[];
}

export interface ConsistencyScore {
  sourceType: string;
  sourceRecordId: string;
  /**
   * Weighted cross-source agreement in [0,1], or null when nothing comparable
   * exists to check against. Null means "unknown", never "no agreement" - the
   * distinction matters, because confidence treats them very differently.
   */
  consistencyScore: number | null;
}

export interface ReconciliationOutcome {
  state: ReconciliationState;
  /** The question these observations were judged against (§16). */
  question: FinancialQuestion;
  /** Largest disagreement in paise between comparable amounts; null if none. */
  amountDelta: number | null;
  /** The amount the weight of evidence points to, or null when disputed. */
  agreedAmount: number | null;
  contradictions: Contradiction[];
  consistency: ConsistencyScore[];
  /** Why this state was reached. Safe to surface to a user (§58). */
  reason: string;
}

export interface ReconcileOptions {
  /**
   * Paise of difference tolerated before two amounts are called a conflict.
   *
   * Defaults to ZERO, deliberately. Spec §14/§41 treat ₹5,00,000 vs ₹4,98,750
   * as a MISMATCH, not a rounding artifact - money that does not add up is a
   * fact about the world, and a tolerance is a policy decision that belongs to
   * whoever is accountable for it, not a default buried in a library.
   */
  amountToleranceMinor?: number;
  /** Now, for deciding whether an expectation has come due. */
  now?: Date;
  /**
   * Days after which a missed expectation becomes EXPIRED rather than MISSING.
   * Omitted by default: an expiry horizon is a policy, and inventing one would
   * silently drop obligations off the books.
   */
  expiryDays?: number;
}

/** Claim types that assert money actually moved. */
const OBSERVED_CLAIMS: ReadonlySet<ClaimType> = new Set<ClaimType>(["ACTUAL", "RECONCILED"]);

/** Claim types that assert money is *going* to move. */
const EXPECTATION_CLAIMS: ReadonlySet<ClaimType> = new Set<ClaimType>([
  "CONTRACTUAL",
  "CONFIRMED",
  "EXPECTED",
  "PREDICTED",
]);

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Reconcile everything several sources have said about one financial subject.
 *
 * Pure and deterministic: same observations in, same outcome out, regardless of
 * the order they arrive in. Callers must pass observations for ONE subject and
 * ONE tenant; this function has no way to check either.
 */
export function reconcileObservations(
  input: ReconciliationInput,
  options: ReconcileOptions = {}
): ReconciliationOutcome {
  const now = options.now ?? new Date();
  const tolerance = Math.abs(options.amountToleranceMinor ?? 0);
  const observations = input.observations;

  // The question is set by the strongest kind of claim present: if any source
  // says the money moved, this group is fundamentally about MONEY_ARRIVED.
  const question = dominantQuestion(observations);

  if (observations.length === 0) {
    return outcome("UNKNOWN", question, {
      reason: "No observations for this subject.",
    });
  }

  const contradictions: Contradiction[] = [];

  // --- DUPLICATE -----------------------------------------------------------
  // The same source record presented twice is a pipeline fault, not evidence of
  // two payments. It must be surfaced before anything is counted, or a repeated
  // delivery would look like corroboration.
  const duplicates = findDuplicates(observations);
  if (duplicates.length > 0) {
    for (const d of duplicates) {
      contradictions.push({
        type: "DUPLICATE_OBSERVATION",
        detail: `Source record ${d.sourceRecordId} from ${d.sourceType} was presented ${d.count} times.`,
        sources: [d.sourceType],
      });
    }
    return outcome("DUPLICATE", question, {
      contradictions,
      reason: "The same source record appears more than once; deduplicate before reconciling.",
      consistency: unknownConsistency(observations),
    });
  }

  const withAmounts = observations.filter((o) => typeof o.amount === "number");
  const consistency = computeConsistency(observations, question, tolerance);

  // --- MISSING / EXPIRED ---------------------------------------------------
  // An expectation that came due with nothing observed is the §17 case: not a
  // contradiction between sources, but between a source and reality.
  const dueExpectations = observations.filter(
    (o) =>
      EXPECTATION_CLAIMS.has(o.claimType) &&
      o.effectiveAt instanceof Date &&
      o.effectiveAt.getTime() <= now.getTime()
  );
  const observed = observations.filter((o) => OBSERVED_CLAIMS.has(o.claimType));

  if (dueExpectations.length > 0 && observed.length === 0) {
    const overdueBy = Math.max(
      ...dueExpectations.map((o) => now.getTime() - (o.effectiveAt as Date).getTime())
    );
    const overdueDays = Math.floor(overdueBy / MS_PER_DAY);

    contradictions.push({
      type: "EXPECTED_EVENT_MISSED",
      detail:
        `Expected on ${(dueExpectations[0].effectiveAt as Date).toISOString().slice(0, 10)}, ` +
        `${overdueDays} day(s) ago; no source has observed it.`,
      sources: [...new Set(dueExpectations.map((o) => o.sourceType))],
    });

    const expired = options.expiryDays !== undefined && overdueDays >= options.expiryDays;
    return outcome(expired ? "EXPIRED" : "MISSING", question, {
      contradictions,
      consistency,
      reason: expired
        ? `Expectation is ${overdueDays} day(s) overdue, past the ${options.expiryDays}-day expiry.`
        : `Expectation is ${overdueDays} day(s) overdue and still unobserved.`,
    });
  }

  // --- CONFLICT ------------------------------------------------------------
  // Comparable amounts that do not agree. Reported, never reconciled away.
  const amounts = withAmounts.map((o) => o.amount as number);
  const spread = amounts.length > 1 ? Math.max(...amounts) - Math.min(...amounts) : 0;

  if (amounts.length > 1 && spread > tolerance) {
    const byAmount = new Map<number, string[]>();
    for (const o of withAmounts) {
      const list = byAmount.get(o.amount as number) ?? [];
      list.push(o.sourceType);
      byAmount.set(o.amount as number, list);
    }
    contradictions.push({
      type: "AMOUNT_CONFLICT",
      detail:
        `Sources disagree by ${spread} paise: ` +
        [...byAmount.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([amt, srcs]) => `${srcs.sort().join("/")} reports ${amt}`)
          .join("; "),
      sources: [...new Set(withAmounts.map((o) => o.sourceType))].sort(),
    });

    return outcome("CONFLICT", question, {
      amountDelta: spread,
      agreedAmount: null,
      contradictions,
      consistency,
      reason: "Sources report materially different amounts; this needs a human.",
    });
  }

  // --- UNMATCHED / CANDIDATE_MATCH ----------------------------------------
  if (observations.length === 1) {
    return outcome("UNMATCHED", question, {
      agreedAmount: withAmounts.length === 1 ? (withAmounts[0].amount as number) : null,
      consistency,
      reason: `Only ${observations[0].sourceType} has reported on this; nothing to corroborate against.`,
    });
  }

  if (amounts.length < 2) {
    return outcome("CANDIDATE_MATCH", question, {
      agreedAmount: amounts.length === 1 ? amounts[0] : null,
      consistency,
      reason: "Several sources refer to this subject but not enough carry a comparable amount.",
    });
  }

  // --- MATCHED / VERIFIED / RECONCILED ------------------------------------
  const agreedAmount = amounts[0];

  // Verification requires a source that can settle THIS question, and it must
  // actually have observed the event - an ERP row asserting an invoice exists
  // does not verify that money arrived, however authoritative the ERP is about
  // invoices.
  const verifier = observations.find(
    (o) => isAuthoritativeFor(question, o.sourceType) && claimSettles(question, o.claimType)
  );

  if (!verifier) {
    return outcome("MATCHED", question, {
      agreedAmount,
      amountDelta: spread,
      consistency,
      reason: "Sources agree on the amount, but none of them can settle this question.",
    });
  }

  if (contradictions.length > 0) {
    return outcome("VERIFIED", question, {
      agreedAmount,
      amountDelta: spread,
      contradictions,
      consistency,
      reason: `${verifier.sourceType} confirms the amount, but an open discrepancy remains.`,
    });
  }

  return outcome("RECONCILED", question, {
    agreedAmount,
    amountDelta: spread,
    consistency,
    reason: `${verifier.sourceType} confirms ${agreedAmount} paise and every source agrees.`,
  });
}

/**
 * The question this group is really about.
 *
 * Precedence between QUESTIONS (unlike between sources) is legitimate: once any
 * source says the money moved, "did it move?" is the question that matters, and
 * timing predictions become subordinate to it.
 */
function dominantQuestion(observations: SourceObservation[]): FinancialQuestion {
  if (observations.length === 0) return "MONEY_ARRIVED";
  const questions = new Set(observations.map((o) => questionForClaimType(o.claimType)));
  if (questions.has("MONEY_ARRIVED")) return "MONEY_ARRIVED";
  if (questions.has("OBLIGATION_EXISTS")) return "OBLIGATION_EXISTS";
  if (questions.has("COUNTERPARTY_STATED")) return "COUNTERPARTY_STATED";
  return "LIKELY_TIMING";
}

/** Whether a claim of this type can settle this question, not merely inform it. */
function claimSettles(question: FinancialQuestion, claimType: ClaimType): boolean {
  switch (question) {
    case "MONEY_ARRIVED":
      return OBSERVED_CLAIMS.has(claimType);
    case "OBLIGATION_EXISTS":
      return claimType === "CONTRACTUAL" || claimType === "ACTUAL" || claimType === "RECONCILED";
    case "COUNTERPARTY_STATED":
      return claimType === "CONFIRMED";
    case "LIKELY_TIMING":
      // Nothing settles the future.
      return false;
  }
}

function findDuplicates(
  observations: SourceObservation[]
): Array<{ sourceType: string; sourceRecordId: string; count: number }> {
  const counts = new Map<string, { sourceType: string; sourceRecordId: string; count: number }>();
  for (const o of observations) {
    const key = `${o.sourceType}::${o.sourceRecordId}`;
    const entry = counts.get(key) ?? {
      sourceType: o.sourceType,
      sourceRecordId: o.sourceRecordId,
      count: 0,
    };
    entry.count++;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .filter((e) => e.count > 1)
    .sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId));
}

/**
 * Cross-source agreement per observation, weighted by how much each OTHER
 * source's opinion counts for this question.
 *
 * An observation corroborated by a source that actually knows (the bank, on
 * whether money arrived) scores high; one contradicted by that source scores
 * low. Being agreed with by a source that has no standing on the question moves
 * the needle very little - which is exactly the §16 behaviour a flat "number of
 * agreeing sources" count would get wrong.
 *
 * Returns null - not 0 - when there is nothing comparable to check against.
 */
function computeConsistency(
  observations: SourceObservation[],
  question: FinancialQuestion,
  tolerance: number
): ConsistencyScore[] {
  return observations.map((self) => {
    if (typeof self.amount !== "number") {
      return { sourceType: self.sourceType, sourceRecordId: self.sourceRecordId, consistencyScore: null };
    }

    const others = observations.filter(
      (o) => o !== self && typeof o.amount === "number"
    );
    if (others.length === 0) {
      return { sourceType: self.sourceType, sourceRecordId: self.sourceRecordId, consistencyScore: null };
    }

    let agreeing = 0;
    let total = 0;
    for (const other of others) {
      const weight = sourceAuthority(question, other.sourceType);
      total += weight;
      if (Math.abs((other.amount as number) - self.amount) <= tolerance) agreeing += weight;
    }

    return {
      sourceType: self.sourceType,
      sourceRecordId: self.sourceRecordId,
      consistencyScore: total === 0 ? null : agreeing / total,
    };
  });
}

function unknownConsistency(observations: SourceObservation[]): ConsistencyScore[] {
  return observations.map((o) => ({
    sourceType: o.sourceType,
    sourceRecordId: o.sourceRecordId,
    consistencyScore: null,
  }));
}

function outcome(
  state: ReconciliationState,
  question: FinancialQuestion,
  parts: Partial<Omit<ReconciliationOutcome, "state" | "question">> & { reason: string }
): ReconciliationOutcome {
  return {
    state,
    question,
    amountDelta: parts.amountDelta ?? null,
    agreedAmount: parts.agreedAmount ?? null,
    contradictions: parts.contradictions ?? [],
    consistency: parts.consistency ?? [],
    reason: parts.reason,
  };
}

/** States in which no material discrepancy is outstanding. */
export function isSettled(state: ReconciliationState): boolean {
  return state === "RECONCILED";
}

/** States a human has to look at. */
export function needsAttention(state: ReconciliationState): boolean {
  return state === "CONFLICT" || state === "MISSING" || state === "EXPIRED" || state === "DUPLICATE";
}
