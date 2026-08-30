import { describe, it, expect, vi } from "vitest";
import { findOpenConflicts } from "../openConflicts";

/**
 * Listing cross-source disagreements.
 *
 * The reconciler decides what a conflict IS; that is tested where it lives.
 * What matters here is the listing's own behaviour, and the property that
 * carries the most weight is a negative one: it must not resolve anything.
 * §14 and §41 put a material source conflict with a human, and a list that
 * quietly picked a winner would be worse than no list.
 */

const claim = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "cl_1",
  businessId: "biz-A",
  claimType: "CONTRACTUAL",
  subjectType: "INVOICE",
  subjectId: "inv-1",
  amount: 500_000,
  effectiveAt: new Date("2026-09-10"),
  status: "ACTIVE",
  ...over,
});

const evidence = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "ev_1",
  claimId: "cl_1",
  businessId: "biz-A",
  sourceType: "ERP",
  sourceRecordId: "erp-1",
  evidenceType: "STATEMENT",
  observedAt: new Date("2026-09-01"),
  effectiveAt: new Date("2026-09-10"),
  reliabilityScore: 0.9,
  freshnessScore: 0.9,
  specificityScore: 0.9,
  historicalAccuracyScore: null,
  consistencyScore: null,
  derivedConfidence: 0.9,
  ...over,
});

function clientWith(claims: unknown[], ev: unknown[]) {
  return {
    claim: {
      findMany: vi.fn(async ({ where }: { where: { businessId: string } }) =>
        (claims as { businessId: string }[]).filter((c) => c.businessId === where.businessId)
      ),
    },
    evidence: {
      findMany: vi.fn(async ({ where }: { where: { businessId: string } }) =>
        (ev as { businessId: string }[]).filter((e) => e.businessId === where.businessId)
      ),
    },
  } as never;
}

describe("Scoping and safety", () => {
  it("refuses to run without a tenant", async () => {
    // An unscoped read here would list one business's disputed amounts to
    // another.
    await expect(findOpenConflicts(clientWith([], []), "")).rejects.toThrow(/tenantId/i);
  });

  it("returns nothing when there are no claims", async () => {
    await expect(findOpenConflicts(clientWith([], []), "biz-A")).resolves.toEqual([]);
  });

  it("never reads another tenant's claims", async () => {
    const client = clientWith([claim({ businessId: "biz-B" })], [evidence({ businessId: "biz-B" })]);
    await expect(findOpenConflicts(client, "biz-A")).resolves.toEqual([]);
  });
});

describe("Surfacing a genuine disagreement", () => {
  /** ERP says ₹5,00,000; the bank says ₹4,80,000 for the same invoice. */
  const disagreeing = () => {
    const claims = [
      claim({ id: "cl_erp", amount: 500_000 }),
      claim({ id: "cl_bank", claimType: "ACTUAL", amount: 480_000 }),
    ];
    const ev = [
      evidence({ id: "ev_erp", claimId: "cl_erp", sourceType: "ERP", sourceRecordId: "erp-1" }),
      evidence({
        id: "ev_bank",
        claimId: "cl_bank",
        sourceType: "BANK",
        sourceRecordId: "bank-1",
        evidenceType: "SETTLEMENT",
      }),
    ];
    return clientWith(claims, ev);
  };

  it("reports the subject the sources disagree about, as a CONFLICT", async () => {
    const found = await findOpenConflicts(disagreeing(), "biz-A");

    expect(found.length).toBeGreaterThan(0);
    expect(found[0].subjectId).toBe("inv-1");
    expect(found[0].subjectType).toBe("INVOICE");

    // Pinned explicitly. Asserting only that "something was listed" would pass
    // on a weaker state like UNMATCHED and prove far less than it looks.
    expect(found[0].state).toBe("CONFLICT");
    expect(found[0].amountDelta).toBe(20_000);
  });

  it("shows what each source actually said", async () => {
    const found = await findOpenConflicts(disagreeing(), "biz-A");
    const sources = found[0].observations.map((o) => o.sourceType).sort();

    // The operator has to be able to judge for themselves; a verdict without
    // the underlying statements is just another opinion to trust.
    expect(sources).toEqual(["BANK", "ERP"]);
    expect(found[0].observations.map((o) => o.amount).sort()).toEqual([480_000, 500_000]);
  });

  it("does not pick a winner", async () => {
    const found = await findOpenConflicts(disagreeing(), "biz-A");
    const c = found[0];

    // The listing may report where evidence points, but it must never mark the
    // disagreement settled or mutate anything.
    expect(c.state).not.toBe("RECONCILED");
    expect(c.state).not.toBe("VERIFIED");
    expect(c.reason).toBeTruthy();
  });

  it("carries a reason that can be shown to a person", async () => {
    const found = await findOpenConflicts(disagreeing(), "biz-A");

    expect(typeof found[0].reason).toBe("string");
    expect(found[0].reason.length).toBeGreaterThan(10);
  });
});

describe("Ordering and limits", () => {
  it("is deterministic across repeated calls", async () => {
    const build = () =>
      clientWith(
        [
          claim({ id: "c1", subjectId: "inv-1", amount: 500_000 }),
          claim({ id: "c2", subjectId: "inv-1", claimType: "ACTUAL", amount: 100_000 }),
          claim({ id: "c3", subjectId: "inv-2", amount: 900_000 }),
          claim({ id: "c4", subjectId: "inv-2", claimType: "ACTUAL", amount: 200_000 }),
        ],
        [
          evidence({ id: "e1", claimId: "c1", sourceType: "ERP", sourceRecordId: "erp-1" }),
          evidence({ id: "e2", claimId: "c2", sourceType: "BANK", sourceRecordId: "bank-1" }),
          evidence({ id: "e3", claimId: "c3", sourceType: "ERP", sourceRecordId: "erp-2" }),
          evidence({ id: "e4", claimId: "c4", sourceType: "BANK", sourceRecordId: "bank-2" }),
        ]
      );

    const a = await findOpenConflicts(build(), "biz-A");
    const b = await findOpenConflicts(build(), "biz-A");

    // A list that reshuffles between page loads cannot be worked through.
    expect(a.map((c) => c.subjectId)).toEqual(b.map((c) => c.subjectId));
  });

  it("honours a limit", async () => {
    const client = clientWith(
      [
        claim({ id: "c1", subjectId: "inv-1", amount: 500_000 }),
        claim({ id: "c2", subjectId: "inv-1", claimType: "ACTUAL", amount: 100_000 }),
        claim({ id: "c3", subjectId: "inv-2", amount: 900_000 }),
        claim({ id: "c4", subjectId: "inv-2", claimType: "ACTUAL", amount: 200_000 }),
      ],
      [
        evidence({ id: "e1", claimId: "c1", sourceType: "ERP", sourceRecordId: "erp-1" }),
        evidence({ id: "e2", claimId: "c2", sourceType: "BANK", sourceRecordId: "bank-1" }),
        evidence({ id: "e3", claimId: "c3", sourceType: "ERP", sourceRecordId: "erp-2" }),
        evidence({ id: "e4", claimId: "c4", sourceType: "BANK", sourceRecordId: "bank-2" }),
      ]
    );

    const limited = await findOpenConflicts(client, "biz-A", { limit: 1 });
    expect(limited.length).toBeLessThanOrEqual(1);
  });
});

describe("Agreement is not listed", () => {
  it("omits a subject whose sources agree", async () => {
    const client = clientWith(
      [
        claim({ id: "c1", subjectId: "inv-9", amount: 500_000 }),
        claim({ id: "c2", subjectId: "inv-9", claimType: "ACTUAL", amount: 500_000 }),
      ],
      [
        evidence({ id: "e1", claimId: "c1", sourceType: "ERP", sourceRecordId: "erp-9" }),
        evidence({
          id: "e2",
          claimId: "c2",
          sourceType: "BANK",
          sourceRecordId: "bank-9",
          evidenceType: "SETTLEMENT",
        }),
      ]
    );

    const found = await findOpenConflicts(client, "biz-A");

    // Listing agreements as conflicts would train operators to ignore the list,
    // which is the failure mode that matters most for a review queue.
    expect(found.filter((c) => c.subjectId === "inv-9" && c.state === "CONFLICT")).toHaveLength(0);
  });
});
