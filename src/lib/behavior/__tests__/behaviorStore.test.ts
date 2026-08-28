import { describe, it, expect, vi } from "vitest";
import { loadPaymentBehavior, type BehaviorClient } from "../behaviorStore";
import { buildMovementsForBusiness } from "@/lib/forecast/movements";
import { transactionsToMovements, buildForecast } from "@/lib/engine/forecast";
import type { TransactionRecord } from "@/lib/db/records";

const TENANT_A = "biz_A";
const TENANT_B = "biz_B";
const NOW = new Date("2026-09-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (d: number) => new Date(NOW.getTime() + d * DAY);

type Row = Record<string, unknown>;

/** A settled invoice: due `delay` days before it was paid, `daysAgo` back. */
function paid(
  id: string,
  counterpartyId: string | null,
  delay: number,
  daysAgo: number,
  businessId = TENANT_A
): Row {
  const paidAt = at(-daysAgo);
  return {
    id,
    businessId,
    amount: 100_00,
    status: "PAID",
    dueDate: new Date(paidAt.getTime() - delay * DAY),
    paidAt,
    counterpartyId,
  };
}

function makeClient(invoices: Row[]) {
  const findMany = vi.fn(async ({ where, take }: { where: Row; take?: number }) => {
    const hits = invoices.filter((inv) => {
      if (inv.businessId !== where.businessId) return false;
      if (where.status && inv.status !== where.status) return false;
      const paidAtFilter = where.paidAt as { not?: null; gte?: Date } | undefined;
      if (paidAtFilter) {
        if (paidAtFilter.not === null && inv.paidAt === null) return false;
        if (paidAtFilter.gte && (inv.paidAt as Date) < paidAtFilter.gte) return false;
      }
      return true;
    });
    hits.sort((a, b) => (b.paidAt as Date).getTime() - (a.paidAt as Date).getTime());
    return take ? hits.slice(0, take) : hits;
  });

  return { invoice: { findMany }, findMany };
}

const asClient = (m: ReturnType<typeof makeClient>) => m as unknown as BehaviorClient;

/** `count` settled invoices for one counterparty, each `delay` days late. */
function history(counterpartyId: string, delay: number, count: number, businessId = TENANT_A) {
  return Array.from({ length: count }, (_, i) =>
    paid(`${counterpartyId}_inv_${i}`, counterpartyId, delay, 5 + i * 20, businessId)
  );
}

describe("loadPaymentBehavior", () => {
  it("builds a profile per counterparty", async () => {
    const mock = makeClient([...history("cp_1", 6, 6), ...history("cp_2", 0, 6)]);
    const r = await loadPaymentBehavior(asClient(mock), TENANT_A, { now: NOW });

    expect(r.byCounterparty.size).toBe(2);
    expect(r.byCounterparty.get("cp_1")!.expectedDelayDays).toBe(6);
    expect(r.byCounterparty.get("cp_2")!.expectedDelayDays).toBe(0);
    expect(r.observationsUsed).toBe(12);
  });

  it("returns an empty map rather than throwing when there is no history", async () => {
    const r = await loadPaymentBehavior(asClient(makeClient([])), TENANT_A, { now: NOW });
    expect(r.byCounterparty.size).toBe(0);
    expect(r.observationsUsed).toBe(0);
  });

  it("counts settled invoices that carry no counterparty link instead of guessing", async () => {
    // The B-4 gap made visible: history exists but cannot be attributed.
    const mock = makeClient([...history("cp_1", 6, 6), paid("orphan", null, 4, 10)]);
    const r = await loadPaymentBehavior(asClient(mock), TENANT_A, { now: NOW });

    expect(r.skippedUnlinked).toBe(1);
    expect(r.byCounterparty.size).toBe(1);
  });

  it("reports counterparties whose history is too thin to act on", async () => {
    const mock = makeClient([...history("cp_1", 6, 6), ...history("cp_2", 6, 2)]);
    const r = await loadPaymentBehavior(asClient(mock), TENANT_A, { now: NOW });

    expect(r.counterpartiesWithoutOpinion).toBe(1);
    expect(r.byCounterparty.get("cp_2")!.expectedDelayDays).toBeNull();
    // Still present in the map - a known-insufficient profile is information.
    expect(r.byCounterparty.has("cp_2")).toBe(true);
  });

  it("scopes the read to the tenant (spec §47)", async () => {
    const mock = makeClient([...history("cp_1", 6, 6), ...history("cp_9", 6, 6, TENANT_B)]);

    const a = await loadPaymentBehavior(asClient(mock), TENANT_A, { now: NOW });
    expect(a.byCounterparty.has("cp_9")).toBe(false);
    expect(mock.findMany.mock.calls[0][0].where.businessId).toBe(TENANT_A);

    const b = await loadPaymentBehavior(asClient(mock), TENANT_B, { now: NOW });
    expect(b.byCounterparty.has("cp_1")).toBe(false);
    expect(b.byCounterparty.has("cp_9")).toBe(true);
  });

  it("reads only settled invoices with a known arrival time", async () => {
    const mock = makeClient(history("cp_1", 6, 6));
    await loadPaymentBehavior(asClient(mock), TENANT_A, { now: NOW });

    const where = mock.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("PAID");
    expect((where.paidAt as { not: null }).not).toBeNull();
  });

  it("bounds the read by a lookback window and a row cap", async () => {
    const mock = makeClient(history("cp_1", 6, 6));
    await loadPaymentBehavior(asClient(mock), TENANT_A, { now: NOW, lookbackDays: 90, maxInvoices: 10 });

    const call = mock.findMany.mock.calls[0][0];
    expect(call.take).toBe(10);
    expect((call.where.paidAt as { gte: Date }).gte).toStrictEqual(at(-90));
  });

  it("excludes history older than the window", async () => {
    // Five recent payments, and five from two years ago that must not count.
    const recent = history("cp_1", 6, 5);
    const ancient = Array.from({ length: 5 }, (_, i) => paid(`old_${i}`, "cp_1", 30, 700 + i));
    const r = await loadPaymentBehavior(asClient(makeClient([...recent, ...ancient])), TENANT_A, {
      now: NOW,
    });

    expect(r.observationsUsed).toBe(5);
    expect(r.byCounterparty.get("cp_1")!.expectedDelayDays).toBe(6);
  });

  it("requires a tenant", async () => {
    await expect(loadPaymentBehavior(asClient(makeClient([])), "")).rejects.toThrow(/tenantId/);
  });
});

describe("buildMovementsForBusiness", () => {
  const transactions: TransactionRecord[] = [
    {
      id: "t1",
      amount: 500000_00,
      type: "INFLOW",
      status: "PENDING",
      expectedDate: at(3),
      description: null,
      counterpartyId: "cp_1",
    },
  ];

  const currentPath = () =>
    transactionsToMovements(
      transactions.map((t) => ({
        id: t.id,
        amount: t.amount,
        type: t.type as "INFLOW" | "OUTFLOW",
        status: t.status,
        expectedDate: new Date(t.expectedDate),
        description: t.description ?? null,
      }))
    );

  it("issues NO query when the pipeline is disabled", async () => {
    // Switching a call site over must not silently acquire a database read.
    const mock = makeClient(history("cp_1", 6, 6));
    const movements = await buildMovementsForBusiness(asClient(mock), TENANT_A, transactions, {
      useEventPipeline: false,
    });

    expect(mock.findMany).not.toHaveBeenCalled();
    expect(movements).toStrictEqual(currentPath());
  });

  it("is identical to the current path when nobody has enough history", async () => {
    const mock = makeClient(history("cp_1", 6, 2));
    const movements = await buildMovementsForBusiness(asClient(mock), TENANT_A, transactions, {
      useEventPipeline: true,
      now: NOW,
    });
    expect(movements).toStrictEqual(currentPath());
  });

  it("applies behaviour end to end once the history supports it", async () => {
    // The whole chain: settled invoices -> behaviour -> forecast event ->
    // movement -> a different forecast day.
    const mock = makeClient(history("cp_1", 6, 8));
    const movements = await buildMovementsForBusiness(asClient(mock), TENANT_A, transactions, {
      useEventPipeline: true,
      now: NOW,
    });

    expect(movements[0].date).toStrictEqual(at(9));

    const days = buildForecast(1000000_00, movements, 14, NOW);
    expect(days[2].expectedInflows).toBe(0);
    expect(days[8].expectedInflows).toBe(500000_00);
  });

  it("falls back to contractual dates when history cannot be read", async () => {
    // Behaviour is an enhancement. Losing it must not take the forecast down.
    const broken = {
      invoice: {
        findMany: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      },
    } as unknown as BehaviorClient;

    const movements = await buildMovementsForBusiness(broken, TENANT_A, transactions, {
      useEventPipeline: true,
      now: NOW,
    });
    expect(movements).toStrictEqual(currentPath());
  });

  it("does not apply one tenant's behaviour to another's forecast", async () => {
    const mock = makeClient(history("cp_1", 6, 8));
    const movements = await buildMovementsForBusiness(asClient(mock), TENANT_B, transactions, {
      useEventPipeline: true,
      now: NOW,
    });
    // Tenant B has no history for cp_1, so nothing shifts.
    expect(movements).toStrictEqual(currentPath());
  });
});
