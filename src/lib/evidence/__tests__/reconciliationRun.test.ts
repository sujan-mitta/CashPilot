import { describe, it, expect, vi } from "vitest";
import {
  groupObservations,
  runReconciliation,
  type ReconciliationRunClient,
  type StoredClaim,
  type StoredEvidence,
} from "../reconciliationRun";

const TENANT_A = "biz_A";
const TENANT_B = "biz_B";
const L5 = 500000_00;
const SEP5 = new Date("2026-09-05T00:00:00Z");
const SEP12 = new Date("2026-09-12T00:00:00Z");

function claim(over: Partial<StoredClaim> & { id: string }): StoredClaim {
  return {
    claimType: "CONTRACTUAL",
    subjectType: "INVOICE",
    subjectId: "inv_1",
    amount: L5,
    effectiveAt: SEP5,
    ...over,
  };
}

function evidence(over: Partial<StoredEvidence> & { id: string; claimId: string }): StoredEvidence {
  return {
    sourceType: "ERP",
    sourceRecordId: "erp_1",
    evidenceType: "ERP_INVOICE",
    observedAt: SEP5,
    effectiveAt: null,
    reliabilityScore: 0.9,
    freshnessScore: 1,
    specificityScore: 1,
    historicalAccuracyScore: null,
    consistencyScore: null,
    derivedConfidence: 0.54,
    ...over,
  };
}

describe("groupObservations", () => {
  it("puts different sources' claims about one subject into one group", () => {
    const claims = [
      claim({ id: "c1", claimType: "CONTRACTUAL" }),
      claim({ id: "c2", claimType: "ACTUAL" }),
    ];
    const ev = [
      evidence({ id: "e1", claimId: "c1", sourceType: "ERP", sourceRecordId: "erp_1" }),
      evidence({ id: "e2", claimId: "c2", sourceType: "BANK", sourceRecordId: "txn_1" }),
    ];

    const groups = groupObservations(claims, ev);

    expect(groups).toHaveLength(1);
    expect(groups[0].subjectId).toBe("inv_1");
    expect(groups[0].observations.map((o) => o.sourceType).sort()).toEqual(["BANK", "ERP"]);
  });

  it("keeps different subjects in different groups", () => {
    const claims = [claim({ id: "c1", subjectId: "inv_1" }), claim({ id: "c2", subjectId: "inv_2" })];
    const ev = [
      evidence({ id: "e1", claimId: "c1" }),
      evidence({ id: "e2", claimId: "c2", sourceRecordId: "erp_2" }),
    ];
    expect(groupObservations(claims, ev)).toHaveLength(2);
  });

  it("collapses one source record supporting several claims, keeping the definitive one", () => {
    // The ERP record is ONE observation, not two - it must not look like two
    // sources corroborating each other.
    const claims = [
      claim({ id: "c1", claimType: "EXPECTED" }),
      claim({ id: "c2", claimType: "ACTUAL" }),
    ];
    const ev = [
      evidence({ id: "e1", claimId: "c1", evidenceType: "ERP_INVOICE" }),
      evidence({ id: "e2", claimId: "c2", evidenceType: "ERP_SETTLEMENT" }),
    ];

    const groups = groupObservations(claims, ev);

    expect(groups[0].observations).toHaveLength(1);
    expect(groups[0].observations[0].claimType).toBe("ACTUAL");
    // Both rows remain reachable for the write-back.
    expect(groups[0].evidenceBySource.get("ERP::erp_1")).toHaveLength(2);
  });

  it("ignores evidence whose claim was not loaded", () => {
    const groups = groupObservations([], [evidence({ id: "e1", claimId: "missing" })]);
    expect(groups).toHaveLength(0);
  });

  it("is deterministic regardless of input order", () => {
    const claims = [claim({ id: "c1" }), claim({ id: "c2", claimType: "ACTUAL" })];
    const ev = [
      evidence({ id: "e1", claimId: "c1", sourceType: "ERP", sourceRecordId: "erp_1" }),
      evidence({ id: "e2", claimId: "c2", sourceType: "BANK", sourceRecordId: "txn_1" }),
    ];
    const a = groupObservations(claims, ev);
    const b = groupObservations([...claims].reverse(), [...ev].reverse());
    expect(a[0].observations.map((o) => o.sourceType)).toEqual(
      b[0].observations.map((o) => o.sourceType)
    );
  });
});

type Row = Record<string, unknown>;

function makeMock(claims: StoredClaim[], ev: StoredEvidence[]) {
  const evidenceRows: Row[] = ev.map((e) => ({ ...e, businessId: TENANT_A }));
  const claimRows: Row[] = claims.map((c) => ({ ...c, businessId: TENANT_A, status: "ACTIVE" }));

  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  return {
    claimRows,
    evidenceRows,
    claim: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        claimRows.filter((c) => matches(c, where)).map((c) => ({ ...c }))
      ),
    },
    evidence: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        evidenceRows.filter((e) => matches(e, where)).map((e) => ({ ...e }))
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hits = evidenceRows.filter((e) => matches(e, where));
        hits.forEach((e) => Object.assign(e, data));
        return { count: hits.length };
      }),
    },
  };
}

const asClient = (m: ReturnType<typeof makeMock>) => m as unknown as ReconciliationRunClient;

describe("runReconciliation", () => {
  it("reconciles an ERP invoice against a bank settlement and reports it", async () => {
    const claims = [
      claim({ id: "c1", claimType: "CONTRACTUAL" }),
      claim({ id: "c2", claimType: "ACTUAL" }),
    ];
    const ev = [
      evidence({ id: "e1", claimId: "c1", sourceType: "ERP", sourceRecordId: "erp_1" }),
      evidence({ id: "e2", claimId: "c2", sourceType: "BANK", sourceRecordId: "txn_1" }),
    ];
    const mock = makeMock(claims, ev);

    const r = await runReconciliation(asClient(mock), TENANT_A, { now: SEP12 });

    expect(r.summary).toEqual({ total: 1, reconciled: 1, conflicts: 0, missing: 0, unknown: 0 });
    expect(r.outcomes[0].outcome.state).toBe("RECONCILED");
  });

  it("counts a cross-source amount disagreement as a conflict", async () => {
    const claims = [
      claim({ id: "c1", claimType: "CONTRACTUAL", amount: L5 }),
      claim({ id: "c2", claimType: "ACTUAL", amount: 498750_00 }),
    ];
    const ev = [
      evidence({ id: "e1", claimId: "c1", sourceType: "ERP", sourceRecordId: "erp_1" }),
      evidence({ id: "e2", claimId: "c2", sourceType: "BANK", sourceRecordId: "txn_1" }),
    ];

    const r = await runReconciliation(asClient(makeMock(claims, ev)), TENANT_A, { now: SEP12 });

    expect(r.summary.conflicts).toBe(1);
    expect(r.summary.reconciled).toBe(0);
  });

  it("counts an overdue unobserved expectation as missing", async () => {
    const claims = [claim({ id: "c1", claimType: "CONTRACTUAL", effectiveAt: SEP5 })];
    const ev = [evidence({ id: "e1", claimId: "c1" })];

    const r = await runReconciliation(asClient(makeMock(claims, ev)), TENANT_A, { now: SEP12 });

    expect(r.summary.missing).toBe(1);
    expect(r.outcomes[0].outcome.contradictions[0].type).toBe("EXPECTED_EVENT_MISSED");
  });

  it("writes the consistency score back and re-derives confidence", async () => {
    // A prediction: uncorroborated it is capped at 0.6; corroborated it is not.
    const claims = [
      claim({ id: "c1", claimType: "EXPECTED", effectiveAt: null }),
      claim({ id: "c2", claimType: "EXPECTED", effectiveAt: null }),
    ];
    const ev = [
      evidence({ id: "e1", claimId: "c1", sourceType: "ERP", sourceRecordId: "erp_1" }),
      evidence({ id: "e2", claimId: "c2", sourceType: "BANK", sourceRecordId: "txn_1", reliabilityScore: 0.98 }),
    ];
    const mock = makeMock(claims, ev);

    const before = mock.evidenceRows.find((e) => e.id === "e1")!.derivedConfidence as number;
    const r = await runReconciliation(asClient(mock), TENANT_A, { now: SEP12 });

    const after = mock.evidenceRows.find((e) => e.id === "e1")!;
    expect(r.evidenceUpdated).toBe(2);
    expect(after.consistencyScore).toBe(1);
    // 0.9 x 1 x 0.6 (capped) -> 0.9 x 1 x sqrt(1 x 1)
    expect(after.derivedConfidence as number).toBeGreaterThan(before);
    expect(after.derivedConfidence as number).toBeCloseTo(0.9, 10);
  });

  it("lowers confidence for the source that disagrees", async () => {
    const claims = [
      claim({ id: "c1", claimType: "EXPECTED", amount: L5, effectiveAt: null }),
      claim({ id: "c2", claimType: "EXPECTED", amount: 1, effectiveAt: null }),
    ];
    const ev = [
      evidence({ id: "e1", claimId: "c1", sourceType: "ERP", sourceRecordId: "erp_1" }),
      evidence({ id: "e2", claimId: "c2", sourceType: "BANK", sourceRecordId: "txn_1" }),
    ];
    const mock = makeMock(claims, ev);

    await runReconciliation(asClient(mock), TENANT_A, { now: SEP12 });

    const erp = mock.evidenceRows.find((e) => e.id === "e1")!;
    expect(erp.consistencyScore).toBe(0);
    expect(erp.derivedConfidence).toBe(0);
  });

  it("never touches the observation fields, only the derived ones (spec §46)", async () => {
    const claims = [
      claim({ id: "c1", claimType: "EXPECTED", effectiveAt: null }),
      claim({ id: "c2", claimType: "EXPECTED", effectiveAt: null }),
    ];
    const ev = [
      evidence({ id: "e1", claimId: "c1", sourceType: "ERP", sourceRecordId: "erp_1" }),
      evidence({ id: "e2", claimId: "c2", sourceType: "BANK", sourceRecordId: "txn_1" }),
    ];
    const mock = makeMock(claims, ev);

    await runReconciliation(asClient(mock), TENANT_A, { now: SEP12 });

    for (const call of mock.evidence.updateMany.mock.calls) {
      expect(Object.keys(call[0].data).sort()).toEqual(["consistencyScore", "derivedConfidence"]);
    }
  });

  it("is a no-op on a second run once scores have settled", async () => {
    const claims = [
      claim({ id: "c1", claimType: "EXPECTED", effectiveAt: null }),
      claim({ id: "c2", claimType: "EXPECTED", effectiveAt: null }),
    ];
    const ev = [
      evidence({ id: "e1", claimId: "c1", sourceType: "ERP", sourceRecordId: "erp_1" }),
      evidence({ id: "e2", claimId: "c2", sourceType: "BANK", sourceRecordId: "txn_1" }),
    ];
    const mock = makeMock(claims, ev);

    const first = await runReconciliation(asClient(mock), TENANT_A, { now: SEP12 });
    const second = await runReconciliation(asClient(mock), TENANT_A, { now: SEP12 });

    expect(first.evidenceUpdated).toBe(2);
    expect(second.evidenceUpdated).toBe(0);
    expect(second.summary).toEqual(first.summary);
  });

  it("writes nothing in dryRun mode", async () => {
    const claims = [
      claim({ id: "c1", claimType: "EXPECTED", effectiveAt: null }),
      claim({ id: "c2", claimType: "EXPECTED", effectiveAt: null }),
    ];
    const ev = [
      evidence({ id: "e1", claimId: "c1", sourceType: "ERP", sourceRecordId: "erp_1" }),
      evidence({ id: "e2", claimId: "c2", sourceType: "BANK", sourceRecordId: "txn_1" }),
    ];
    const mock = makeMock(claims, ev);

    const r = await runReconciliation(asClient(mock), TENANT_A, { now: SEP12, dryRun: true });

    expect(r.summary.total).toBe(1);
    expect(r.evidenceUpdated).toBe(0);
    expect(mock.evidence.updateMany).not.toHaveBeenCalled();
  });

  it("returns an empty summary when the tenant has no evidence yet", async () => {
    const r = await runReconciliation(asClient(makeMock([], [])), TENANT_A, { now: SEP12 });
    expect(r.summary).toEqual({ total: 0, reconciled: 0, conflicts: 0, missing: 0, unknown: 0 });
  });

  it("scopes every read and every write to the tenant (spec §47)", async () => {
    const claims = [claim({ id: "c1" })];
    const ev = [evidence({ id: "e1", claimId: "c1" })];
    const mock = makeMock(claims, ev);

    await runReconciliation(asClient(mock), TENANT_A, { now: SEP12 });

    expect(mock.claim.findMany.mock.calls[0][0].where.businessId).toBe(TENANT_A);
    expect(mock.evidence.findMany.mock.calls[0][0].where.businessId).toBe(TENANT_A);
    for (const call of mock.evidence.updateMany.mock.calls) {
      expect(call[0].where.businessId).toBe(TENANT_A);
    }
  });

  it("reads nothing for a tenant with no rows of its own", async () => {
    const claims = [claim({ id: "c1" })];
    const ev = [evidence({ id: "e1", claimId: "c1" })];
    const r = await runReconciliation(asClient(makeMock(claims, ev)), TENANT_B, { now: SEP12 });
    expect(r.summary.total).toBe(0);
  });

  it("requires a tenant", async () => {
    await expect(runReconciliation(asClient(makeMock([], [])), "")).rejects.toThrow(/tenantId/);
  });
});
