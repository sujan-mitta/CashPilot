import { describe, it, expect, vi } from "vitest";
import { buildForecastContextForBusiness } from "../movements";
import { forecastEventsToMovements } from "../forecastEvent";
import { buildScenarios } from "../scenarios";
import { buildForecast, transactionsToMovements } from "@/lib/engine/forecast";
import type { BehaviorClient } from "@/lib/behavior/behaviorStore";
import type { TransactionRecord } from "@/lib/db/records";

/**
 * Phase 13 - the forecast context the API returns.
 *
 * The property these tests protect: the scenario band and the headline forecast
 * line must come from the SAME events. A BASE scenario that disagrees with the
 * number printed above it is worse than showing no scenario at all.
 */

const TENANT = "biz_A";
const NOW = new Date("2026-09-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (d: number) => new Date(NOW.getTime() + d * DAY);

function tx(over: Partial<TransactionRecord> & { id: string }): TransactionRecord {
  return {
    amount: 500000_00,
    type: "INFLOW",
    status: "PENDING",
    expectedDate: at(3),
    description: null,
    ...over,
  };
}

/** Settled invoices for cp_1, each `delay` days late. */
function settled(delay: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const paidAt = at(-(5 + i * 10));
    return {
      id: `inv_${i}`,
      businessId: TENANT,
      amount: 100_00,
      status: "PAID",
      dueDate: new Date(paidAt.getTime() - delay * DAY),
      paidAt,
      counterpartyId: "cp_1",
    };
  });
}

function makeClient(invoices: Record<string, unknown>[]) {
  const findMany = vi.fn(async () => invoices);
  return { client: { invoice: { findMany } } as unknown as BehaviorClient, findMany };
}

const CASH = 1000000_00;
const transactions = [
  tx({ id: "t1", counterpartyId: "cp_1" }),
  tx({ id: "t2", type: "OUTFLOW", expectedDate: at(6) }),
];

describe("buildForecastContextForBusiness", () => {
  it("returns movements that are exactly the events, bucketed", async () => {
    const { client } = makeClient(settled(6, 8));
    const ctx = await buildForecastContextForBusiness(client, TENANT, transactions, {
      useEventPipeline: true,
      now: NOW,
    });

    expect(ctx.movements).toStrictEqual(forecastEventsToMovements(ctx.events));
  });

  it("issues no query and applies no adjustment when the pipeline is off", async () => {
    const { client, findMany } = makeClient(settled(6, 8));
    const ctx = await buildForecastContextForBusiness(client, TENANT, transactions, {
      useEventPipeline: false,
      now: NOW,
    });

    expect(findMany).not.toHaveBeenCalled();
    expect(ctx.movements).toStrictEqual(
      transactionsToMovements(
        transactions.map((t) => ({
          id: t.id,
          amount: t.amount,
          type: t.type as "INFLOW" | "OUTFLOW",
          status: t.status,
          expectedDate: new Date(t.expectedDate),
          description: t.description ?? null,
        }))
      )
    );
    // Events still exist for the scenario view, just unadjusted.
    expect(ctx.events).toHaveLength(2);
    for (const e of ctx.events) expect(e.timingBasis).toEqual([]);
  });

  it("applies behaviour to both halves when enabled", async () => {
    const { client } = makeClient(settled(6, 8));
    const ctx = await buildForecastContextForBusiness(client, TENANT, transactions, {
      useEventPipeline: true,
      now: NOW,
    });

    const inflow = ctx.events.find((e) => e.id === "t1")!;
    expect(inflow.expectedDate).toStrictEqual(at(9));
    expect(ctx.movements.find((m) => m.transactionId === "t1")!.date).toStrictEqual(at(9));
  });

  it("degrades to contractual dates if history cannot be read", async () => {
    const broken = {
      invoice: {
        findMany: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      },
    } as unknown as BehaviorClient;

    const ctx = await buildForecastContextForBusiness(broken, TENANT, transactions, {
      useEventPipeline: true,
      now: NOW,
    });
    expect(ctx.events.every((e) => e.timingBasis.length === 0)).toBe(true);
  });
});

describe("the band always brackets the line it is drawn around", () => {
  async function contextAndForecast(enabled: boolean) {
    const { client } = makeClient(settled(6, 8));
    const ctx = await buildForecastContextForBusiness(client, TENANT, transactions, {
      useEventPipeline: enabled,
      now: NOW,
    });
    const days = buildForecast(CASH, ctx.movements, 14, NOW);
    const scenarios = buildScenarios(CASH, ctx.events, {
      horizonDays: 14,
      startDate: NOW,
      requiredBuffer: 700000_00,
    });
    return { days, scenarios };
  }

  it("BASE matches the headline forecast exactly, pipeline off", async () => {
    const { days, scenarios } = await contextAndForecast(false);
    expect(scenarios.base.days).toStrictEqual(days);
  });

  it("BASE matches the headline forecast exactly, pipeline on", async () => {
    // The case that would break if events and movements were built separately.
    const { days, scenarios } = await contextAndForecast(true);
    expect(scenarios.base.days).toStrictEqual(days);
  });

  it("brackets the headline minimum on both sides once behaviour is measured", async () => {
    const { days, scenarios } = await contextAndForecast(true);
    const headlineMin = Math.min(...days.map((d) => d.closingBalance));

    expect(scenarios.conservative.minimumBalance).toBeLessThanOrEqual(headlineMin);
    expect(scenarios.optimistic.minimumBalance).toBeGreaterThanOrEqual(headlineMin);
  });

  it("reports LOW confidence while nothing is measured", async () => {
    const { scenarios } = await contextAndForecast(false);
    expect(scenarios.degenerate).toBe(true);
    expect(scenarios.confidence.level).toBe("LOW");
  });
});
