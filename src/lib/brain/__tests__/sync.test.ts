import { describe, it, expect, vi } from "vitest";
import { syncFinancialBrain, type BrainSyncClient } from "../sync";

/**
 * The orchestrator that finally runs Phases 1-10 over a tenant's ledger.
 *
 * These tests care about three things:
 *   - the stages run in the order that makes each one useful to the next
 *   - every read and write is tenant-scoped
 *   - re-running changes nothing (every stage is idempotent)
 */

const TENANT_A = "biz_A";
const TENANT_B = "biz_B";
const NOW = new Date("2026-09-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (d: number) => new Date(NOW.getTime() + d * DAY);

type Row = Record<string, unknown>;

function p2002(): Error & { code: string } {
  const e = new Error("Unique constraint failed") as Error & { code: string };
  e.code = "P2002";
  return e;
}

/**
 * An in-memory world covering every table the sync touches. Filters on each key
 * the real queries filter on - a mock that ignored businessId would make the
 * isolation tests pass vacuously.
 */
function makeWorld() {
  const calls: string[] = [];
  const invoices: Row[] = [
    {
      id: "inv_1",
      businessId: TENANT_A,
      customerName: "Retail Chain A",
      amount: 300000_00,
      dueDate: at(-5),
      status: "OVERDUE",
      counterpartyId: null,
    },
    {
      id: "inv_2",
      businessId: TENANT_A,
      customerName: "RETAIL CHAIN A LTD",
      amount: 100000_00,
      dueDate: at(4),
      status: "PENDING",
      counterpartyId: null,
    },
    {
      id: "inv_9",
      businessId: TENANT_B,
      customerName: "Someone Else",
      amount: 900000_00,
      dueDate: at(3),
      status: "PENDING",
      counterpartyId: null,
    },
  ];
  const transactions: Row[] = [
    {
      id: "t_1",
      businessId: TENANT_A,
      amount: 200000_00,
      type: "INFLOW",
      status: "PENDING",
      description: null,
      expectedDate: at(3),
    },
  ];
  const payouts: Row[] = [
    {
      id: "p_1",
      businessId: TENANT_A,
      vendor: "Packaging Co",
      amount: 150000_00,
      scheduledDate: at(6),
      criticality: "LOW",
      status: "SCHEDULED",
      counterpartyId: null,
    },
  ];
  const counterparties: Row[] = [];
  const aliases: Row[] = [];
  const claims: Row[] = [];
  const evidence: Row[] = [];
  const states: Row[] = [];
  let seq = 0;

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      const actual = row[k];
      if (v === null) return actual === null || actual === undefined;
      if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
        const o = v as Record<string, unknown>;
        if ("not" in o) return o.not === null ? actual !== null : actual !== o.not;
        if ("gte" in o) return (actual as Date) >= (o.gte as Date);
        return true;
      }
      return actual === v;
    });

  const table = (rows: Row[], name: string) => ({
    findMany: vi.fn(async ({ where }: { where?: Row } = {}) => {
      calls.push(`${name}.findMany`);
      return rows.filter((r) => matches(r, where ?? {})).map((r) => ({ ...r }));
    }),
    findFirst: vi.fn(async ({ where }: { where: Row }) => {
      const r = rows.find((x) => matches(x, where));
      return r ? { ...r } : null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hits = rows.filter((r) => matches(r, where));
      hits.forEach((r) => Object.assign(r, data));
      return { count: hits.length };
    }),
  });

  const client = {
    calls,
    invoiceRows: invoices,
    counterpartyRows: counterparties,
    claimRows: claims,
    evidenceRows: evidence,
    stateRows: states,

    business: {
      findUnique: vi.fn(async ({ where }: { where: Row }) =>
        where.id === TENANT_A
          ? { id: TENANT_A, name: "Acme", currentCash: 1000000_00 }
          : where.id === TENANT_B
          ? { id: TENANT_B, name: "Other", currentCash: 500000_00 }
          : null
      ),
    },
    invoice: table(invoices, "invoice"),
    transaction: table(transactions, "transaction"),
    payout: table(payouts, "payout"),

    counterparty: {
      ...table(counterparties, "counterparty"),
      findUnique: vi.fn(async ({ where }: { where: Record<string, Row> }) => {
        const k = where.businessId_type_normalizedName;
        const r = counterparties.find(
          (c) =>
            c.businessId === k.businessId &&
            c.type === k.type &&
            c.normalizedName === k.normalizedName
        );
        return r ? { ...r } : null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        calls.push("counterparty.create");
        const clash = counterparties.find(
          (c) =>
            c.businessId === data.businessId &&
            c.type === data.type &&
            c.normalizedName === data.normalizedName
        );
        if (clash) throw p2002();
        const row = { id: `cp_${++seq}`, mergedIntoId: null, mergedAt: null, ...data };
        counterparties.push(row);
        return { ...row };
      }),
    },
    counterpartyAlias: {
      ...table(aliases, "alias"),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const clash = aliases.find(
          (a) =>
            a.businessId === data.businessId &&
            a.type === data.type &&
            a.normalizedName === data.normalizedName
        );
        if (clash) throw p2002();
        const row = { id: `al_${++seq}`, ...data };
        aliases.push(row);
        return { ...row };
      }),
    },

    claim: {
      ...table(claims, "claim"),
      create: vi.fn(async ({ data }: { data: Row }) => {
        calls.push("claim.create");
        const clash = claims.find(
          (c) =>
            c.businessId === data.businessId &&
            c.subjectType === data.subjectType &&
            c.subjectId === data.subjectId &&
            c.claimType === data.claimType
        );
        if (clash) throw p2002();
        const row = { id: `cl_${++seq}`, status: "ACTIVE", confidence: 0, ...data };
        claims.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        let row: Row | undefined;
        if (where.id) row = claims.find((c) => c.id === where.id);
        else {
          const k = where.businessId_subjectType_subjectId_claimType as Row;
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
        return { ...row };
      }),
    },
    evidence: {
      ...table(evidence, "evidence"),
      create: vi.fn(async ({ data }: { data: Row }) => {
        calls.push("evidence.create");
        const clash = evidence.find(
          (e) =>
            e.businessId === data.businessId &&
            e.claimId === data.claimId &&
            e.sourceType === data.sourceType &&
            e.sourceRecordId === data.sourceRecordId &&
            e.evidenceType === data.evidenceType
        );
        if (clash) throw p2002();
        const row = { id: `ev_${++seq}`, ...data };
        evidence.push(row);
        return { ...row };
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, Row> }) => {
        const k = where.businessId_claimId_sourceType_sourceRecordId_evidenceType;
        const r = evidence.find(
          (e) =>
            e.businessId === k.businessId &&
            e.claimId === k.claimId &&
            e.sourceType === k.sourceType &&
            e.sourceRecordId === k.sourceRecordId &&
            e.evidenceType === k.evidenceType
        );
        return r ? { ...r } : null;
      }),
    },

    financialState: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
        const hits = states.filter((s) => matches(s, where));
        if (orderBy?.stateVersion === "desc") {
          hits.sort((a, b) => (b.stateVersion as number) - (a.stateVersion as number));
        }
        return hits[0] ? { ...hits[0] } : null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        calls.push("financialState.create");
        const clash = states.find(
          (s) => s.businessId === data.businessId && s.stateVersion === data.stateVersion
        );
        if (clash) throw p2002();
        const row = { id: `fs_${++seq}`, ...data };
        states.push(row);
        return { ...row };
      }),
    },
  };

  return client;
}

const asClient = (w: ReturnType<typeof makeWorld>) => w as unknown as BrainSyncClient;

describe("syncFinancialBrain", () => {
  it("runs every stage and reports what it did", async () => {
    const w = makeWorld();
    const r = await syncFinancialBrain(asClient(w), TENANT_A, { now: NOW });

    // Two invoices, one notational variant of the other -> ONE customer.
    expect(r.entities!.created).toBe(2); // 1 customer + 1 supplier
    expect(r.entities!.customersLinked).toBe(2);
    expect(r.entities!.suppliersLinked).toBe(1);

    expect(r.claims!.claimsCreated).toBe(4); // 2 invoices + 1 txn + 1 payout
    expect(r.reconciliation).not.toBeNull();
    expect(r.state!.stateVersion).toBe(1);
    expect(r.state!.created).toBe(true);
  });

  it("resolves notational variants of one customer to a single entity", async () => {
    const w = makeWorld();
    await syncFinancialBrain(asClient(w), TENANT_A, { now: NOW });

    const customers = w.counterpartyRows.filter((c) => c.type === "CUSTOMER");
    expect(customers).toHaveLength(1);
    expect(w.invoiceRows[0].counterpartyId).toBe(w.invoiceRows[1].counterpartyId);
  });

  it("runs the stages in an order where each feeds the next", async () => {
    const w = makeWorld();
    await syncFinancialBrain(asClient(w), TENANT_A, { now: NOW });

    const first = (name: string) => w.calls.indexOf(name);
    // Entities before claims, claims before state.
    expect(first("counterparty.create")).toBeLessThan(first("claim.create"));
    expect(first("claim.create")).toBeLessThan(first("financialState.create"));
  });

  it("carries the reconciliation rollup into the materialised state", async () => {
    const w = makeWorld();
    const r = await syncFinancialBrain(asClient(w), TENANT_A, { now: NOW });

    const stored = w.stateRows[0];
    expect(stored.reconciliation).toEqual({
      total: r.reconciliation!.total,
      reconciled: r.reconciliation!.reconciled,
      conflicts: r.reconciliation!.conflicts,
      missing: r.reconciliation!.missing,
      unknown: r.reconciliation!.unknown,
    });
  });

  it("is idempotent — a second run creates nothing new", async () => {
    const w = makeWorld();
    await syncFinancialBrain(asClient(w), TENANT_A, { now: NOW });

    const counterparties = w.counterpartyRows.length;
    const claims = w.claimRows.length;
    const evidence = w.evidenceRows.length;
    const states = w.stateRows.length;

    const second = await syncFinancialBrain(asClient(w), TENANT_A, { now: NOW });

    expect(w.counterpartyRows).toHaveLength(counterparties);
    expect(w.claimRows).toHaveLength(claims);
    expect(w.evidenceRows).toHaveLength(evidence);
    // The state did not change, so no new version was minted.
    expect(w.stateRows).toHaveLength(states);
    expect(second.state!.unchanged).toBe(true);
    expect(second.entities!.created).toBe(0);
    expect(second.claims!.claimsCreated).toBe(0);
  });

  it("never touches another tenant's rows (spec §47)", async () => {
    const w = makeWorld();
    await syncFinancialBrain(asClient(w), TENANT_A, { now: NOW });

    // Tenant B's invoice is untouched and produced no entity.
    const other = w.invoiceRows.find((i) => i.id === "inv_9")!;
    expect(other.counterpartyId).toBeNull();
    expect(w.counterpartyRows.every((c) => c.businessId === TENANT_A)).toBe(true);
    expect(w.claimRows.every((c) => c.businessId === TENANT_A)).toBe(true);
    expect(w.stateRows.every((s) => s.businessId === TENANT_A)).toBe(true);
  });

  it("versions each tenant's state independently", async () => {
    const w = makeWorld();
    await syncFinancialBrain(asClient(w), TENANT_A, { now: NOW });
    const b = await syncFinancialBrain(asClient(w), TENANT_B, { now: NOW });
    expect(b.state!.stateVersion).toBe(1);
  });

  it("honours per-stage skips", async () => {
    const w = makeWorld();
    const r = await syncFinancialBrain(asClient(w), TENANT_A, {
      now: NOW,
      skipEntities: true,
      skipClaims: true,
      skipReconciliation: true,
    });

    expect(r.entities).toBeNull();
    expect(r.claims).toBeNull();
    expect(r.reconciliation).toBeNull();
    expect(w.counterpartyRows).toHaveLength(0);
    // State still materialises, just with no reconciliation rollup.
    expect(r.state!.stateVersion).toBe(1);
  });

  it("writes no evidence rescoring in a dry run", async () => {
    const w = makeWorld();
    const r = await syncFinancialBrain(asClient(w), TENANT_A, {
      now: NOW,
      dryRunReconciliation: true,
    });
    expect(r.evidenceRescored).toBe(0);
    expect(r.reconciliation).not.toBeNull();
  });

  it("refuses an unknown tenant rather than syncing nothing quietly", async () => {
    const w = makeWorld();
    await expect(syncFinancialBrain(asClient(w), "nope", { now: NOW })).rejects.toThrow(
      /No business/
    );
  });

  it("requires a tenant", async () => {
    const w = makeWorld();
    await expect(syncFinancialBrain(asClient(w), "")).rejects.toThrow(/tenantId/);
  });
});
