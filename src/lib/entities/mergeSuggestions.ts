import type { Counterparty } from "../../../generated/prisma/client";
import { resolveCounterpartyName, type ResolveOptions } from "./resolver";
import type { CounterpartyClient } from "./store";

/**
 * Near-duplicate counterparties for a human to confirm.
 *
 * `brain:sync` computes suggestions while backfilling and prints a COUNT, then
 * discards them. Nothing is persisted, so a reviewer has no way to see what was
 * suggested. This derives the same suggestions on demand, which is what an API
 * needs.
 *
 * Deriving rather than storing is deliberate. A suggestion is a function of the
 * current entity set, and a stored one goes stale the moment a merge happens —
 * a reviewer would be offered a merge into an entity that no longer survives.
 * Recomputing costs a pairwise scan bounded by counterparty count, which is the
 * same bound the backfill already accepts (C-6).
 *
 * Nothing here merges anything. Every pair is a question.
 */

export interface MergeSuggestion {
  /** The entity proposed to be absorbed. Chosen deterministically, see below. */
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  /** Token overlap in [0,1]. A suggestion strength, NOT a probability. */
  similarity: number;
  type: string;
  /** Why this pair is being shown, in the reviewer's language. */
  evidence: string[];
}

/**
 * Which of the pair should be absorbed.
 *
 * The OLDER row survives, because it is the one existing financial history is
 * most likely already attached to. Ties break on id so the same entity set
 * always produces the same proposal — a suggestion list that reshuffles between
 * page loads cannot be reviewed.
 */
function orderPair(a: Counterparty, b: Counterparty): [Counterparty, Counterparty] {
  const aTime = a.createdAt?.getTime?.() ?? 0;
  const bTime = b.createdAt?.getTime?.() ?? 0;
  if (aTime !== bTime) return aTime > bTime ? [a, b] : [b, a];
  return a.id > b.id ? [a, b] : [b, a];
}

export interface FindMergeSuggestionsOptions extends ResolveOptions {
  /** Cap the returned list. The scan itself is unbounded by design. */
  limit?: number;
}

export async function findMergeSuggestions(
  client: CounterpartyClient,
  tenantId: string,
  options: FindMergeSuggestionsOptions = {}
): Promise<MergeSuggestion[]> {
  if (!tenantId) throw new Error("findMergeSuggestions requires a tenantId.");

  // Merged-away rows are kept forever, but they are not candidates: proposing a
  // merge into a superseded identity would attach history to a dead entity.
  const counterparties = await client.counterparty.findMany({
    where: { businessId: tenantId, mergedIntoId: null },
  });

  const byId = new Map(counterparties.map((c) => [c.id, c]));
  const seenPairs = new Set<string>();
  const suggestions: MergeSuggestion[] = [];

  for (const candidate of counterparties) {
    // Resolve this name against everything EXCEPT itself, or it matches itself
    // exactly and no near-match is ever surfaced.
    const others = counterparties.filter(
      (c) => c.id !== candidate.id && c.type === candidate.type
    );
    if (others.length === 0) continue;

    const decision = resolveCounterpartyName(
      candidate.displayName,
      others.map((c) => ({
        id: c.id,
        displayName: c.displayName,
        normalizedName: c.normalizedName,
        type: c.type,
      })),
      [],
      options
    );

    for (const match of decision.candidates) {
      const other = byId.get(match.id);
      if (!other) continue;

      const [source, target] = orderPair(candidate, other);

      // A pair is one question regardless of which side surfaced it.
      const key = `${source.id}|${target.id}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);

      suggestions.push({
        sourceId: source.id,
        sourceName: source.displayName,
        targetId: target.id,
        targetName: target.displayName,
        similarity: match.similarity,
        type: String(candidate.type),
        evidence: [
          `Normalised names overlap by ${Math.round(match.similarity * 100)}%.`,
          `"${source.displayName}" normalises to "${source.normalizedName}".`,
          `"${target.displayName}" normalises to "${target.normalizedName}".`,
          "Names only — no GSTIN, PAN or bank identifier was available to confirm this (C-2).",
        ],
      });
    }
  }

  // Strongest first, then by id, so the order is stable across calls.
  suggestions.sort(
    (a, b) => b.similarity - a.similarity || a.sourceId.localeCompare(b.sourceId)
  );

  return typeof options.limit === "number" ? suggestions.slice(0, options.limit) : suggestions;
}
