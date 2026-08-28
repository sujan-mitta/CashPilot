import { describe, it, expect, beforeEach } from "vitest";
import { makeMockClient, asClient } from "./mockClaimEvidenceClient";
import { upsertClaim, recordEvidence, recordClaimWithEvidence } from "../store";
import type { ClaimDescriptor, EvidenceDescriptor } from "../store";

const OBSERVED = new Date("2026-09-01T00:00:00.000Z");

const CLAIM: ClaimDescriptor = {
  claimType: "CONTRACTUAL",
  subjectType: "INVOICE",
  subjectId: "inv-1",
  amount: 500000,
  effectiveAt: new Date("2026-09-05T00:00:00.000Z"),
  assertion: { dueDate: "2026-09-05", amount: 500000 },
};

const EVIDENCE: EvidenceDescriptor = {
  sourceType: "ERP",
  sourceRecordId: "inv-1",
  evidenceType: "ERP_INVOICE",
  observedAt: OBSERVED,
};

describe("upsertClaim - idempotency", () => {
  let mock: ReturnType<typeof makeMockClient>;
  beforeEach(() => {
    mock = makeMockClient();
  });

  it("creates on first call", async () => {
    const { claim, created } = await upsertClaim(asClient(mock), "biz-A", CLAIM);
    expect(created).toBe(true);
    expect(claim.subjectId).toBe("inv-1");
    expect(mock.claimRows).toHaveLength(1);
  });

  it("updates in place on a second call (no duplicate)", async () => {
    const first = await upsertClaim(asClient(mock), "biz-A", CLAIM);
    const second = await upsertClaim(asClient(mock), "biz-A", {
      ...CLAIM,
      assertion: { dueDate: "2026-09-05", amount: 500000, status: "OVERDUE" },
    });
    expect(second.created).toBe(false);
    expect(second.claim.id).toBe(first.claim.id);
    expect(mock.claimRows).toHaveLength(1);
  });

  it("distinguishes claim types on the same subject", async () => {
    await upsertClaim(asClient(mock), "biz-A", CLAIM);
    await upsertClaim(asClient(mock), "biz-A", { ...CLAIM, claimType: "ACTUAL" });
    expect(mock.claimRows).toHaveLength(2);
  });

  it("rejects a missing tenant or subject", async () => {
    await expect(upsertClaim(asClient(mock), "", CLAIM)).rejects.toThrow(/tenantId/);
    await expect(
      upsertClaim(asClient(mock), "biz-A", { ...CLAIM, subjectId: "" })
    ).rejects.toThrow(/subjectType and subjectId/);
  });
});

describe("recordEvidence - append-only idempotency (spec §46)", () => {
  let mock: ReturnType<typeof makeMockClient>;
  let claimId: string;
  beforeEach(async () => {
    mock = makeMockClient();
    const { claim } = await upsertClaim(asClient(mock), "biz-A", CLAIM);
    claimId = claim.id;
  });

  it("records evidence with the full confidence components", async () => {
    const { evidence, created } = await recordEvidence(asClient(mock), "biz-A", claimId, "CONTRACTUAL", EVIDENCE, OBSERVED);
    expect(created).toBe(true);
    expect(evidence.reliabilityScore).toBeGreaterThan(0);
    expect(evidence.freshnessScore).toBe(1);
    expect(evidence.specificityScore).toBeGreaterThan(0);
    // A factual claim with partial specificity: positive, and no higher than
    // the source reliability.
    expect(evidence.derivedConfidence).toBeGreaterThan(0);
    expect(evidence.derivedConfidence ?? 0).toBeLessThanOrEqual(evidence.reliabilityScore ?? 1);
  });

  it("does not duplicate the same observation (2x, 10x)", async () => {
    for (let i = 0; i < 10; i++) {
      await recordEvidence(asClient(mock), "biz-A", claimId, "CONTRACTUAL", EVIDENCE, OBSERVED);
    }
    expect(mock.evidenceRows).toHaveLength(1);
  });

  it("ADDS a genuinely new observation for the same claim (does not overwrite)", async () => {
    await recordEvidence(asClient(mock), "biz-A", claimId, "CONTRACTUAL", EVIDENCE, OBSERVED);
    // A customer email arrives - new source/evidenceType - preserving the old.
    await recordEvidence(asClient(mock), "biz-A", claimId, "CONTRACTUAL", {
      sourceType: "EMAIL",
      sourceRecordId: "email-42",
      evidenceType: "CUSTOMER_COMMUNICATION",
      observedAt: new Date("2026-09-02T00:00:00.000Z"),
    }, OBSERVED);
    expect(mock.evidenceRows).toHaveLength(2);
  });

  it("re-throws a non-duplicate error", async () => {
    mock.evidence.create.mockImplementationOnce(async () => {
      const e = new Error("db down") as Error & { code: string };
      e.code = "P1001";
      throw e;
    });
    await expect(recordEvidence(asClient(mock), "biz-A", claimId, "CONTRACTUAL", EVIDENCE, OBSERVED)).rejects.toThrow("db down");
  });
});

describe("recordClaimWithEvidence - aggregate + isolation", () => {
  let mock: ReturnType<typeof makeMockClient>;
  beforeEach(() => {
    mock = makeMockClient();
  });

  it("sets claim confidence to the strongest evidence", async () => {
    const res = await recordClaimWithEvidence(
      asClient(mock),
      "biz-A",
      CLAIM,
      [
        { sourceType: "EMAIL", sourceRecordId: "e1", evidenceType: "COMMS", observedAt: OBSERVED },
        { sourceType: "BANK", sourceRecordId: "b1", evidenceType: "BANK_TRANSACTION", observedAt: OBSERVED },
      ],
      OBSERVED
    );
    // The claim takes the strongest supporting evidence; BANK outscores EMAIL.
    const derived = res.evidence.map((e) => e.derivedConfidence ?? 0);
    expect(res.claim.confidence).toBeCloseTo(Math.max(...derived), 5);
    const bank = res.evidence.find((e) => e.sourceType === "BANK");
    const email = res.evidence.find((e) => e.sourceType === "EMAIL");
    expect(bank?.derivedConfidence ?? 0).toBeGreaterThan(email?.derivedConfidence ?? 0);
    expect(res.evidence).toHaveLength(2);
    expect(res.evidenceCreated).toBe(2);
  });

  it("is fully idempotent when re-run (same claim, same evidence)", async () => {
    await recordClaimWithEvidence(asClient(mock), "biz-A", CLAIM, [EVIDENCE], OBSERVED);
    const again = await recordClaimWithEvidence(asClient(mock), "biz-A", CLAIM, [EVIDENCE], OBSERVED);
    expect(again.claimCreated).toBe(false);
    expect(again.evidenceCreated).toBe(0);
    expect(mock.claimRows).toHaveLength(1);
    expect(mock.evidenceRows).toHaveLength(1);
  });

  it("keeps tenants isolated: same subject id under two tenants -> two claims", async () => {
    await recordClaimWithEvidence(asClient(mock), "biz-A", CLAIM, [EVIDENCE], OBSERVED);
    await recordClaimWithEvidence(asClient(mock), "biz-B", CLAIM, [EVIDENCE], OBSERVED);
    expect(mock.claimRows).toHaveLength(2);
    expect(mock.evidenceRows).toHaveLength(2);
    expect(mock.claimRows.map((c) => c.businessId).sort()).toEqual(["biz-A", "biz-B"]);
  });
});
