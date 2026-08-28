import { Prisma, ClaimType } from "../../../generated/prisma/client";
import { logger } from "@/lib/observability";
import { combineConfidence } from "./confidence";
import {
  reconcileObservations,
  type ReconciliationOutcome,
  type SourceObservation,
  type ReconcileOptions,
} from "./reconcile";
import type { ReconciliationSummary } from "@/lib/state/financialState";

/**
 * Phase 6 - run cross-source reconciliation over STORED claims and evidence,
 * and feed the result back where it belongs.
 *
 * Phase 5 built the reconciler as a pure function taking observations as
 * arguments. This is the half that was missing: assembling those observations
 * from the database, and writing the resulting `consistencyScore` back onto the
 * Evidence rows so the Phase 3 confidence formula can finally use it.
 *
 * On mutating evidence: `Evidence` is append-only about OBSERVATIONS - what a
 * source said, when, about what. This never touches any of those fields. It
 * updates only `consistencyScore` and `derivedConfidence`, which are DERIVED
 * values that were written as a best effort at ingest time and are re-derived
 * here from better information. Re-deriving a derived value is not rewriting
 * history (spec §46).
 */

export type ReconciliationRunClient = Pick<Prisma.TransactionClient, "claim" | "evidence">;

/** The Claim fields reconciliation needs. */
export interface StoredClaim {
  id: string;
  claimType: ClaimType;
  subjectType: string;
  subjectId: string;
  amount: number | null;
  effectiveAt: Date | null;
}

/** The Evidence fields reconciliation needs. */
export interface StoredEvidence {
  id: string;
  claimId: string;
  sourceType: string;
  sourceRecordId: string;
  evidenceType: string;
  observedAt: Date;
  effectiveAt: Date | null;
  reliabilityScore: number | null;
  freshnessScore: number | null;
  specificityScore: number | null;
  historicalAccuracyScore: number | null;
  consistencyScore: number | null;
  derivedConfidence: number | null;
}

/** One subject's observations, plus the evidence rows each came from. */
export interface ObservationGroup {
  subjectType: string;
  subjectId: string;
  observations: SourceObservation[];
  /** `${sourceType}::${sourceRecordId}` -> the evidence rows behind it. */
  evidenceBySource: Map<string, StoredEvidence[]>;
}

/**
 * How definitive a claim is. Used only to pick which claim's type represents a
 * source record that supports several claims about one subject - the most
 * definitive assertion that record makes is the one that counts.
 */
const CLAIM_DEFINITENESS: Record<ClaimType, number> = {
  RECONCILED: 8,
  ACTUAL: 7,
  CONFIRMED: 6,
  CONTRACTUAL: 5,
  EXPECTED: 4,
  PREDICTED: 3,
  UNCERTAIN: 2,
  CONTRADICTED: 1,
  EXPIRED: 0,
};

function observationKey(sourceType: string, sourceRecordId: string): string {
  return `${sourceType}::${sourceRecordId}`;
}

/**
 * Assemble observation groups from stored claims and evidence.
 *
 * Grouped by SUBJECT, not by claim: the whole point is to put the ERP's
 * contractual assertion and the bank's settlement about invoice X side by side.
 *
 * One source record supporting several claims about the same subject is still
 * ONE observation, so those are collapsed - keeping the most definitive claim
 * type - rather than being passed through as duplicates of each other. The
 * reconciler's DUPLICATE state therefore does not fire here (the store's unique
 * constraints already prevent true duplicates); it remains a guard for callers
 * that assemble groups from a raw feed.
 *
 * Pure: no I/O, so grouping is directly testable.
 */
export function groupObservations(
  claims: StoredClaim[],
  evidence: StoredEvidence[]
): ObservationGroup[] {
  const claimsById = new Map(claims.map((c) => [c.id, c]));
  const groups = new Map<string, ObservationGroup>();

  // Deterministic ordering in, deterministic groups out.
  const ordered = [...evidence].sort(
    (a, b) =>
      a.sourceType.localeCompare(b.sourceType) ||
      a.sourceRecordId.localeCompare(b.sourceRecordId) ||
      a.id.localeCompare(b.id)
  );

  for (const row of ordered) {
    const claim = claimsById.get(row.claimId);
    if (!claim) continue; // Evidence for a claim we did not load; skip silently.

    const groupKey = `${claim.subjectType}::${claim.subjectId}`;
    const group =
      groups.get(groupKey) ??
      ({
        subjectType: claim.subjectType,
        subjectId: claim.subjectId,
        observations: [],
        evidenceBySource: new Map<string, StoredEvidence[]>(),
      } satisfies ObservationGroup);
    groups.set(groupKey, group);

    const key = observationKey(row.sourceType, row.sourceRecordId);
    const behind = group.evidenceBySource.get(key) ?? [];
    behind.push(row);
    group.evidenceBySource.set(key, behind);

    const existing = group.observations.find(
      (o) => observationKey(o.sourceType, o.sourceRecordId) === key
    );

    if (!existing) {
      group.observations.push({
        sourceType: row.sourceType,
        sourceRecordId: row.sourceRecordId,
        amount: claim.amount,
        claimType: claim.claimType,
        observedAt: row.observedAt,
        effectiveAt: row.effectiveAt ?? claim.effectiveAt,
      });
      continue;
    }

    // Same source record, another claim about the same subject: keep whichever
    // assertion is more definitive.
    if (CLAIM_DEFINITENESS[claim.claimType] > CLAIM_DEFINITENESS[existing.claimType]) {
      existing.claimType = claim.claimType;
      existing.amount = claim.amount;
      existing.effectiveAt = row.effectiveAt ?? claim.effectiveAt;
    }
  }

  return [...groups.values()].sort(
    (a, b) =>
      a.subjectType.localeCompare(b.subjectType) || a.subjectId.localeCompare(b.subjectId)
  );
}

export interface ReconciliationRunResult {
  summary: ReconciliationSummary;
  outcomes: Array<{ subjectType: string; subjectId: string; outcome: ReconciliationOutcome }>;
  /** Evidence rows whose derived scores changed. */
  evidenceUpdated: number;
}

export interface ReconciliationRunOptions extends ReconcileOptions {
  /** Skip writing consistency scores back; compute and report only. */
  dryRun?: boolean;
}

/**
 * Reconcile every subject a tenant has evidence for, and re-derive the
 * confidence of the evidence involved.
 *
 * Tenant-scoped at every query and every write (spec §47). Safe to re-run: it
 * is a pure recomputation, and an unchanged score is not written.
 */
export async function runReconciliation(
  client: ReconciliationRunClient,
  tenantId: string,
  options: ReconciliationRunOptions = {}
): Promise<ReconciliationRunResult> {
  if (!tenantId) throw new Error("runReconciliation requires a tenantId.");

  const [claims, evidence] = await Promise.all([
    client.claim.findMany({
      where: { businessId: tenantId, status: "ACTIVE" },
      select: {
        id: true,
        claimType: true,
        subjectType: true,
        subjectId: true,
        amount: true,
        effectiveAt: true,
      },
    }),
    client.evidence.findMany({
      where: { businessId: tenantId },
      select: {
        id: true,
        claimId: true,
        sourceType: true,
        sourceRecordId: true,
        evidenceType: true,
        observedAt: true,
        effectiveAt: true,
        reliabilityScore: true,
        freshnessScore: true,
        specificityScore: true,
        historicalAccuracyScore: true,
        consistencyScore: true,
        derivedConfidence: true,
      },
    }),
  ]);

  const groups = groupObservations(claims as StoredClaim[], evidence as StoredEvidence[]);
  const claimsById = new Map(claims.map((c) => [c.id, c as StoredClaim]));

  const summary: ReconciliationSummary = {
    total: groups.length,
    reconciled: 0,
    conflicts: 0,
    missing: 0,
    unknown: 0,
  };
  const outcomes: ReconciliationRunResult["outcomes"] = [];
  let evidenceUpdated = 0;

  for (const group of groups) {
    const outcome = reconcileObservations(
      {
        subjectType: group.subjectType,
        subjectId: group.subjectId,
        observations: group.observations,
      },
      options
    );
    outcomes.push({ subjectType: group.subjectType, subjectId: group.subjectId, outcome });

    switch (outcome.state) {
      case "RECONCILED":
        summary.reconciled++;
        break;
      case "CONFLICT":
        summary.conflicts++;
        break;
      case "MISSING":
      case "EXPIRED":
        summary.missing++;
        break;
      case "UNKNOWN":
        summary.unknown++;
        break;
      default:
        break;
    }

    if (options.dryRun) continue;

    for (const score of outcome.consistency) {
      const rows = group.evidenceBySource.get(observationKey(score.sourceType, score.sourceRecordId));
      if (!rows) continue;

      for (const row of rows) {
        if (row.consistencyScore === score.consistencyScore) continue;

        const claim = claimsById.get(row.claimId);
        if (!claim) continue;

        // Re-derive through the SAME formula ingest used, with the dimension
        // that was unknown then now supplied.
        const recomputed = combineConfidence({
          claimType: claim.claimType,
          reliabilityScore: row.reliabilityScore ?? 0,
          freshnessScore: row.freshnessScore ?? 0,
          specificityScore: row.specificityScore ?? 0,
          historicalAccuracyScore: row.historicalAccuracyScore,
          consistencyScore: score.consistencyScore,
        });

        // updateMany with businessId in the filter, never update-by-id: a row
        // id on its own is not authorisation to write.
        await client.evidence.updateMany({
          where: { id: row.id, businessId: tenantId },
          data: {
            consistencyScore: score.consistencyScore,
            derivedConfidence: recomputed.derivedConfidence,
          },
        });
        evidenceUpdated++;
      }
    }
  }

  logger.info("RECONCILIATION_COMPLETED", {
    businessId: tenantId,
    subjects: summary.total,
    reconciled: summary.reconciled,
    conflicts: summary.conflicts,
    missing: summary.missing,
    evidenceUpdated,
  });

  return { summary, outcomes, evidenceUpdated };
}
