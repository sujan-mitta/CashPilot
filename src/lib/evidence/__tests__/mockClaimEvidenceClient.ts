import { vi } from "vitest";
import type { ClaimEvidenceClient } from "../store";

function p2002(): Error & { code: string } {
  const e = new Error("Unique constraint failed") as Error & { code: string };
  e.code = "P2002";
  return e;
}

/**
 * In-memory Claim/Evidence client that models exactly the two invariants the
 * writers rely on: the Claim (subject, claimType) unique and the Evidence
 * (claim, source, evidenceType) unique. Not a full Prisma client - just enough
 * to exercise idempotency and tenant scoping honestly.
 */
export function makeMockClient() {
  const claims: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  let cseq = 0;
  let eseq = 0;

  const client = {
    claimRows: claims,
    evidenceRows: evidence,
    claim: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const clash = claims.find(
          (c) =>
            c.businessId === data.businessId &&
            c.subjectType === data.subjectType &&
            c.subjectId === data.subjectId &&
            c.claimType === data.claimType
        );
        if (clash) throw p2002();
        const row = {
          id: `claim_${++cseq}`,
          confidence: 0,
          currency: "INR",
          status: "ACTIVE",
          amount: null,
          effectiveAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        claims.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let row: Record<string, unknown> | undefined;
        if (where.id) {
          row = claims.find((c) => c.id === where.id);
        } else {
          const k = where.businessId_subjectType_subjectId_claimType as Record<string, unknown>;
          row = claims.find(
            (c) =>
              c.businessId === k.businessId &&
              c.subjectType === k.subjectType &&
              c.subjectId === k.subjectId &&
              c.claimType === k.claimType
          );
        }
        if (!row) throw new Error("claim.update: not found");
        Object.assign(row, data);
        row.updatedAt = new Date();
        return row;
      }),
    },
    evidence: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const clash = evidence.find(
          (e) =>
            e.businessId === data.businessId &&
            e.claimId === data.claimId &&
            e.sourceType === data.sourceType &&
            e.sourceRecordId === data.sourceRecordId &&
            e.evidenceType === data.evidenceType
        );
        if (clash) throw p2002();
        const row = { id: `ev_${++eseq}`, createdAt: new Date(), ...data };
        evidence.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, Record<string, unknown>> }) => {
        const k = where.businessId_claimId_sourceType_sourceRecordId_evidenceType;
        return (
          evidence.find(
            (e) =>
              e.businessId === k.businessId &&
              e.claimId === k.claimId &&
              e.sourceType === k.sourceType &&
              e.sourceRecordId === k.sourceRecordId &&
              e.evidenceType === k.evidenceType
          ) ?? null
        );
      }),
    },
  };

  return client;
}

export function asClient(mock: ReturnType<typeof makeMockClient>): ClaimEvidenceClient {
  return mock as unknown as ClaimEvidenceClient;
}
