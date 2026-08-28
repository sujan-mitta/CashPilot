import { vi } from "vitest";
import type { CounterpartyBackfillClient, CounterpartyMergeClient } from "../store";

function p2002(): Error & { code: string } {
  const e = new Error("Unique constraint failed") as Error & { code: string };
  e.code = "P2002";
  return e;
}

type Row = Record<string, unknown>;

/**
 * In-memory stand-in for the counterparty tables.
 *
 * It models exactly the guarantees the store relies on and nothing more: the
 * two unique constraints, and `where` clauses that filter on every key the real
 * queries filter on. That last part matters more than it looks - a mock that
 * ignores `businessId` in its `where` would make every tenant-isolation test
 * pass vacuously, which is the failure mode those tests exist to catch.
 */
export function makeMockCounterpartyClient() {
  const counterparties: Row[] = [];
  const aliases: Row[] = [];
  const invoices: Row[] = [];
  const payouts: Row[] = [];
  let cseq = 0;
  let aseq = 0;

  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([k, v]) => {
      // `mergedIntoId: null` must mean "is null", not "key absent".
      if (v === null) return row[k] === null || row[k] === undefined;
      return row[k] === v;
    });
  }

  const client = {
    counterpartyRows: counterparties,
    aliasRows: aliases,
    invoiceRows: invoices,
    payoutRows: payouts,

    counterparty: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        counterparties.filter((c) => matches(c, where)).map((c) => ({ ...c }))
      ),
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const row = counterparties.find((c) => matches(c, where));
        return row ? { ...row } : null;
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, Row> }) => {
        const k = where.businessId_type_normalizedName;
        const row = counterparties.find(
          (c) =>
            c.businessId === k.businessId &&
            c.type === k.type &&
            c.normalizedName === k.normalizedName
        );
        return row ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const clash = counterparties.find(
          (c) =>
            c.businessId === data.businessId &&
            c.type === data.type &&
            c.normalizedName === data.normalizedName
        );
        if (clash) throw p2002();
        const row: Row = {
          id: `cp_${++cseq}`,
          mergedIntoId: null,
          mergedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        counterparties.push(row);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hits = counterparties.filter((c) => matches(c, where));
        hits.forEach((c) => Object.assign(c, data, { updatedAt: new Date() }));
        return { count: hits.length };
      }),
    },

    counterpartyAlias: {
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        aliases.filter((a) => matches(a, where)).map((a) => ({ ...a }))
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const clash = aliases.find(
          (a) =>
            a.businessId === data.businessId &&
            a.type === data.type &&
            a.normalizedName === data.normalizedName
        );
        if (clash) throw p2002();
        const row: Row = { id: `al_${++aseq}`, createdAt: new Date(), ...data };
        aliases.push(row);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hits = aliases.filter((a) => matches(a, where));
        hits.forEach((a) => Object.assign(a, data));
        return { count: hits.length };
      }),
    },

    invoice: {
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hits = invoices.filter((i) => matches(i, where));
        hits.forEach((i) => Object.assign(i, data));
        return { count: hits.length };
      }),
    },

    payout: {
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hits = payouts.filter((p) => matches(p, where));
        hits.forEach((p) => Object.assign(p, data));
        return { count: hits.length };
      }),
    },
  };

  return client;
}

export type MockCounterpartyClient = ReturnType<typeof makeMockCounterpartyClient>;

export function asClient(
  mock: MockCounterpartyClient
): CounterpartyBackfillClient & CounterpartyMergeClient {
  return mock as unknown as CounterpartyBackfillClient & CounterpartyMergeClient;
}
