import { reconcileObservations, needsAttention, type ReconciliationOutcome } from "./reconcile";
import { groupObservations, type ReconciliationRunClient } from "./reconciliationRun";

/**
 * Cross-source disagreements a human needs to look at (spec §7).
 *
 * The reconciler has always produced CONFLICT, MISSING, EXPIRED and DUPLICATE
 * states, and `brain:sync` has always counted them. What has never existed is
 * any way to SEE them: the count told an operator that two sources disagree
 * about some amount somewhere, and stopped there.
 *
 * Derived on demand rather than stored, for the same reason merge suggestions
 * are. A conflict is a function of the current claims and evidence; a stored
 * one goes stale the moment a new observation arrives, and an operator would be
 * asked to adjudicate a disagreement that had already resolved itself.
 *
 * Nothing here resolves anything. §14 and §41 are explicit that a material
 * source conflict is a human decision, and the whole value of this list is that
 * it refuses to pick a side.
 */

export interface OpenConflict {
  subjectType: string;
  subjectId: string;
  state: ReconciliationOutcome["state"];
  /** The question these observations were judged against. */
  question: string;
  /** Largest disagreement in paise, or null when the issue is not an amount. */
  amountDelta: number | null;
  /** Where the weight of evidence points, or null when genuinely disputed. */
  agreedAmount: number | null;
  reason: string;
  contradictions: ReconciliationOutcome["contradictions"];
  /** What each source actually said, so the operator can judge for themselves. */
  observations: Array<{
    sourceType: string;
    sourceRecordId: string;
    amount: number | null;
    claimType: string;
    observedAt: string;
  }>;
}

/**
 * Severity ordering for review.
 *
 * CONFLICT first: two sources actively disagree about money that exists.
 * MISSING next: something was expected and no authoritative source ever saw it.
 * EXPIRED and DUPLICATE are real but less urgent — one is an aged miss, the
 * other a bookkeeping artifact.
 */
const SEVERITY: Record<string, number> = {
  CONFLICT: 4,
  MISSING: 3,
  EXPIRED: 2,
  DUPLICATE: 1,
};

export interface FindOpenConflictsOptions {
  now?: Date;
  limit?: number;
}

export async function findOpenConflicts(
  client: ReconciliationRunClient,
  tenantId: string,
  options: FindOpenConflictsOptions = {}
): Promise<OpenConflict[]> {
  if (!tenantId) throw new Error("findOpenConflicts requires a tenantId.");

  const now = options.now ?? new Date();

  const claims = await client.claim.findMany({
    where: { businessId: tenantId, status: "ACTIVE" },
  });
  if (claims.length === 0) return [];

  const evidence = await client.evidence.findMany({
    where: { businessId: tenantId, claimId: { in: claims.map((c) => c.id) } },
  });

  const groups = groupObservations(claims, evidence);
  const open: OpenConflict[] = [];

  for (const group of groups) {
    const outcome = reconcileObservations(
      {
        subjectType: group.subjectType,
        subjectId: group.subjectId,
        observations: group.observations,
      },
      { now }
    );

    // The reconciler already owns the definition of "needs attention". Deciding
    // it again here would let the two drift apart.
    if (!needsAttention(outcome.state)) continue;

    open.push({
      subjectType: group.subjectType,
      subjectId: group.subjectId,
      state: outcome.state,
      question: String(outcome.question),
      amountDelta: outcome.amountDelta,
      agreedAmount: outcome.agreedAmount,
      reason: outcome.reason,
      contradictions: outcome.contradictions,
      observations: group.observations.map((o) => ({
        sourceType: o.sourceType,
        sourceRecordId: o.sourceRecordId,
        amount: o.amount,
        claimType: String(o.claimType),
        observedAt: o.observedAt.toISOString(),
      })),
    });
  }

  // Most severe first, then largest disagreement, then subject id so the same
  // data always produces the same order. A list that reshuffles between loads
  // cannot be worked through.
  open.sort(
    (a, b) =>
      (SEVERITY[b.state] ?? 0) - (SEVERITY[a.state] ?? 0) ||
      (b.amountDelta ?? 0) - (a.amountDelta ?? 0) ||
      a.subjectId.localeCompare(b.subjectId)
  );

  return typeof options.limit === "number" ? open.slice(0, options.limit) : open;
}
