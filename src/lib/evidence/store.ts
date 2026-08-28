import { Prisma, Claim, Evidence, ClaimType } from "../../../generated/prisma/client";
import { logger } from "@/lib/observability";
import { computeConfidence, aggregateClaimConfidence } from "./confidence";

/**
 * Phase 2 - idempotent writers for the Claim/Evidence layer.
 *
 * A Claim is re-resolvable (its assertion/confidence may be updated as evidence
 * accumulates), so it is upserted on its (subject, claimType) identity. Evidence
 * is append-only (spec §46): the same observation is never duplicated, but new
 * observations for the same claim ARE added rather than overwriting the old.
 *
 * No production code calls these yet (Phase 2 is additive). Nothing here stores
 * secrets; `assertion`/`metadata` are structured, already-sanitised data.
 */

export interface ClaimDescriptor {
  claimType: ClaimType;
  subjectType: string;
  subjectId: string;
  assertion: Prisma.InputJsonValue;
  amount?: number | null;
  currency?: string;
  effectiveAt?: Date | null;
  status?: string;
}

export interface EvidenceDescriptor {
  sourceType: string;
  sourceRecordId: string;
  evidenceType: string;
  observedAt: Date;
  effectiveAt?: Date | null;
  financialEventId?: string | null;
  metadata?: Prisma.InputJsonValue;
  /** The observation carries an exact monetary amount (raises specificity). */
  hasExactAmount?: boolean;
  /** The observation carries an exact date, not a vague window. */
  hasExactDate?: boolean;
  /** Source's historical prediction accuracy in [0,1], or null if unknown (P9). */
  historicalAccuracyScore?: number | null;
  /** Cross-source agreement in [0,1], or null if unknown (P5). */
  consistencyScore?: number | null;
}

export type ClaimClient = Pick<Prisma.TransactionClient, "claim">;
export type EvidenceClient = Pick<Prisma.TransactionClient, "evidence">;
export type ClaimEvidenceClient = ClaimClient & EvidenceClient;

const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export interface UpsertClaimResult {
  claim: Claim;
  created: boolean;
}

/**
 * Idempotently create or update a claim on its (businessId, subjectType,
 * subjectId, claimType) identity. Re-ingesting the same subject updates the
 * mutable fields (assertion/amount/effectiveAt/status) in place rather than
 * creating a duplicate. Race-safe: a concurrent insert is resolved by updating.
 */
export async function upsertClaim(
  client: ClaimClient,
  tenantId: string,
  input: ClaimDescriptor
): Promise<UpsertClaimResult> {
  if (!tenantId) throw new Error("upsertClaim requires a tenantId.");
  if (!input.subjectType || !input.subjectId) {
    throw new Error("upsertClaim requires subjectType and subjectId.");
  }

  const whereUnique = {
    businessId_subjectType_subjectId_claimType: {
      businessId: tenantId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      claimType: input.claimType,
    },
  };
  const mutable = {
    assertion: input.assertion,
    amount: input.amount ?? null,
    currency: input.currency ?? "INR",
    effectiveAt: input.effectiveAt ?? null,
    status: input.status ?? "ACTIVE",
  };

  try {
    const claim = await client.claim.create({
      data: {
        businessId: tenantId,
        claimType: input.claimType,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        ...mutable,
      },
    });
    logger.info("CLAIM_CREATED", {
      businessId: tenantId,
      claimId: claim.id,
      claimType: input.claimType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
    });
    return { claim, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const claim = await client.claim.update({ where: whereUnique, data: mutable });
    return { claim, created: false };
  }
}

export interface RecordEvidenceResult {
  evidence: Evidence;
  created: boolean;
}

/**
 * Append one piece of evidence to a claim, idempotent on (businessId, claimId,
 * sourceType, sourceRecordId, evidenceType). Re-recording the same observation
 * resolves to the existing row; a genuinely new observation is added.
 *
 * The full multi-dimensional, claim-aware confidence (Phase 3) is computed here,
 * which is why the claim's type is required: the same bank observation is a fact
 * for an ACTUAL claim but a prediction for an EXPECTED one, and those get very
 * different confidence.
 */
export async function recordEvidence(
  client: EvidenceClient,
  tenantId: string,
  claimId: string,
  claimType: ClaimType,
  input: EvidenceDescriptor,
  now: Date = new Date()
): Promise<RecordEvidenceResult> {
  if (!tenantId) throw new Error("recordEvidence requires a tenantId.");
  if (!claimId) throw new Error("recordEvidence requires a claimId.");
  if (!input.sourceType || !input.sourceRecordId || !input.evidenceType) {
    throw new Error("recordEvidence requires sourceType, sourceRecordId and evidenceType.");
  }

  const c = computeConfidence({
    sourceType: input.sourceType,
    claimType,
    observedAt: input.observedAt,
    now,
    specificity: { hasExactAmount: input.hasExactAmount, hasExactDate: input.hasExactDate },
    historicalAccuracyScore: input.historicalAccuracyScore ?? null,
    consistencyScore: input.consistencyScore ?? null,
  });

  try {
    const evidence = await client.evidence.create({
      data: {
        businessId: tenantId,
        claimId,
        sourceType: input.sourceType,
        sourceRecordId: input.sourceRecordId,
        financialEventId: input.financialEventId ?? null,
        evidenceType: input.evidenceType,
        observedAt: input.observedAt,
        effectiveAt: input.effectiveAt ?? null,
        reliabilityScore: c.reliabilityScore,
        freshnessScore: c.freshnessScore,
        specificityScore: c.specificityScore,
        historicalAccuracyScore: c.historicalAccuracyScore,
        consistencyScore: c.consistencyScore,
        derivedConfidence: c.derivedConfidence,
        metadata: input.metadata,
      },
    });
    logger.info("EVIDENCE_CREATED", {
      businessId: tenantId,
      claimId,
      evidenceId: evidence.id,
      sourceType: input.sourceType,
      evidenceType: input.evidenceType,
    });
    return { evidence, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await client.evidence.findUnique({
      where: {
        businessId_claimId_sourceType_sourceRecordId_evidenceType: {
          businessId: tenantId,
          claimId,
          sourceType: input.sourceType,
          sourceRecordId: input.sourceRecordId,
          evidenceType: input.evidenceType,
        },
      },
    });
    if (!existing) throw err;
    return { evidence: existing, created: false };
  }
}

export interface ClaimWithEvidenceResult {
  claim: Claim;
  claimCreated: boolean;
  evidence: Evidence[];
  evidenceCreated: number;
}

/**
 * Record a claim together with its supporting evidence, then set the claim's
 * confidence to the aggregate of that evidence. This is the unit a source-ingest
 * produces: one claim, one or more evidence. Each evidence is scored against the
 * claim's type, so a prediction and a fact are weighted differently.
 */
export async function recordClaimWithEvidence(
  client: ClaimEvidenceClient,
  tenantId: string,
  claim: ClaimDescriptor,
  evidence: EvidenceDescriptor[],
  now: Date = new Date()
): Promise<ClaimWithEvidenceResult> {
  const { claim: stored, created: claimCreated } = await upsertClaim(client, tenantId, claim);

  const evidenceRows: Evidence[] = [];
  let evidenceCreated = 0;
  for (const e of evidence) {
    const { evidence: row, created } = await recordEvidence(client, tenantId, stored.id, claim.claimType, e, now);
    evidenceRows.push(row);
    if (created) evidenceCreated++;
  }

  const confidence = aggregateClaimConfidence(
    evidenceRows.map((e) => e.derivedConfidence ?? 0)
  );
  const updated = await client.claim.update({
    where: { id: stored.id },
    data: { confidence },
  });

  return { claim: updated, claimCreated, evidence: evidenceRows, evidenceCreated };
}
