import { normalizeEntityName, nameSimilarity } from "./normalize";

/**
 * Phase 4 - the pure entity-resolution decision (spec §8, §50-D).
 *
 * Given a raw name from some source and the counterparties a tenant already
 * has, decide whether this is an existing entity, a new one, or something a
 * human has to adjudicate. No I/O, so every branch is directly testable.
 *
 * The governing rule is asymmetric risk. Creating a duplicate entity is
 * recoverable - a user merges them later and history is preserved. Merging two
 * DIFFERENT companies is not: one customer's payment behaviour silently
 * poisons another's forecast, and nothing in the system will ever flag it.
 * So automatic matching is exact-only; everything fuzzy becomes a suggestion.
 */

export type ResolutionMethod =
  /** A previously recorded spelling of a known entity. Safe to apply. */
  | "ALIAS"
  /** Normalised names are identical. Safe to apply. */
  | "EXACT"
  /** One plausible near-match. NOT applied - needs human confirmation. */
  | "CANDIDATE"
  /** Several near-matches, none clearly best. NOT applied (spec §64). */
  | "AMBIGUOUS"
  /** No plausible match; this is a new entity. */
  | "NEW"
  /** The name carries no resolvable content (blank/punctuation only). */
  | "UNRESOLVABLE";

export interface KnownCounterparty {
  id: string;
  displayName: string;
  normalizedName: string;
}

export interface KnownAlias {
  counterpartyId: string;
  normalizedName: string;
}

export interface MatchCandidate {
  id: string;
  displayName: string;
  normalizedName: string;
  /** Token-overlap score in [0,1]. A suggestion strength, not a probability. */
  similarity: number;
}

export interface ResolutionDecision {
  method: ResolutionMethod;
  /**
   * The entity to use. Populated ONLY for ALIAS and EXACT - the two methods
   * that are safe to apply without a human. Null for every fuzzy outcome, so a
   * caller cannot accidentally treat a suggestion as a match.
   */
  matchedId: string | null;
  /** Ranked near-matches for a human to confirm. Never auto-applied. */
  candidates: MatchCandidate[];
  /** Canonical key for this raw name; "" when unresolvable. */
  normalizedName: string;
  /** Confidence in the AUTOMATIC decision: 1 for exact identity, else 0. */
  confidence: number;
}

export interface ResolveOptions {
  /** Minimum similarity to be worth showing a human. */
  candidateThreshold?: number;
  /** If the top two candidates are within this margin, the match is ambiguous. */
  ambiguityMargin?: number;
}

/** Half the tokens shared - low enough to surface a real duplicate, high enough not to spam. */
const DEFAULT_CANDIDATE_THRESHOLD = 0.5;
/** "Retail Chain A" vs "Retail Chain B" score identically; neither may win. */
const DEFAULT_AMBIGUITY_MARGIN = 0.1;

/**
 * Resolve one raw name against a tenant's known entities.
 *
 * `known` and `aliases` MUST already be scoped to one tenant and one
 * counterparty type by the caller - this function has no way to check that, and
 * passing another tenant's rows would resolve across tenants (spec §47).
 * `known` must also exclude entities that were merged away, so a resolution
 * never returns a superseded identity.
 */
export function resolveCounterpartyName(
  rawName: string,
  known: KnownCounterparty[],
  aliases: KnownAlias[] = [],
  options: ResolveOptions = {}
): ResolutionDecision {
  const candidateThreshold = options.candidateThreshold ?? DEFAULT_CANDIDATE_THRESHOLD;
  const ambiguityMargin = options.ambiguityMargin ?? DEFAULT_AMBIGUITY_MARGIN;

  const normalizedName = normalizeEntityName(rawName);

  if (normalizedName === "") {
    return { method: "UNRESOLVABLE", matchedId: null, candidates: [], normalizedName: "", confidence: 0 };
  }

  // 1. A spelling we have already been told about (including user-confirmed
  //    merges) wins outright - it is recorded knowledge, not a guess.
  const alias = aliases.find((a) => a.normalizedName === normalizedName);
  if (alias) {
    return {
      method: "ALIAS",
      matchedId: alias.counterpartyId,
      candidates: [],
      normalizedName,
      confidence: 1,
    };
  }

  // 2. Identical canonical form. Only notational differences were collapsed.
  const exact = known.find((k) => k.normalizedName === normalizedName);
  if (exact) {
    return { method: "EXACT", matchedId: exact.id, candidates: [], normalizedName, confidence: 1 };
  }

  // 3. Everything below here is a SUGGESTION. matchedId stays null.
  const candidates = known
    .map((k) => ({
      id: k.id,
      displayName: k.displayName,
      normalizedName: k.normalizedName,
      similarity: nameSimilarity(normalizedName, k.normalizedName),
    }))
    .filter((c) => c.similarity >= candidateThreshold)
    // Deterministic order: strongest first, then by id so ties never reorder
    // between runs (a flapping suggestion list is its own kind of bug).
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));

  if (candidates.length === 0) {
    return { method: "NEW", matchedId: null, candidates: [], normalizedName, confidence: 0 };
  }

  if (candidates.length > 1 && candidates[0].similarity - candidates[1].similarity < ambiguityMargin) {
    return { method: "AMBIGUOUS", matchedId: null, candidates, normalizedName, confidence: 0 };
  }

  return { method: "CANDIDATE", matchedId: null, candidates, normalizedName, confidence: 0 };
}

/** True for the two methods that may be applied without human confirmation. */
export function isAutomaticMatch(method: ResolutionMethod): boolean {
  return method === "ALIAS" || method === "EXACT";
}
