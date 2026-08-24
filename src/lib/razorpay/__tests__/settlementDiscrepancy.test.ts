import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { recordSettlementDiscrepancy } from "../settlement";

/**
 * F1 regression: a duplicate settlement is PREVENTED by compare-and-set, but it
 * used to return silently. Prevention without a record means nobody can tell
 * "this never happened" apart from "we caught it". These pin the record.
 */
describe("F1 - settlement discrepancy surfacing", () => {
  const store = { events: [] as any[] };

  const client = {
    decision: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.strategyId === "strat-1"
          ? { id: "dec-1", businessId: where.businessId, status: "RECONCILED" }
          : null
      ),
    },
    decisionEvent: {
      create: vi.fn(async ({ data }: any) => {
        store.events.push(data);
        return data;
      }),
    },
  };

  const base = {
    kind: "INVOICE_ALREADY_PAID" as const,
    paymentLinkId: "plink_x",
    businessId: "biz-A",
    targetId: "inv-1",
    strategyId: "strat-1",
  };

  beforeEach(() => {
    store.events.length = 0;
    vi.clearAllMocks();
  });

  it("appends a DecisionEvent recording the duplicate attempt", async () => {
    await recordSettlementDiscrepancy(client as any, base);

    expect(store.events).toHaveLength(1);
    const e = store.events[0];
    expect(e.decisionId).toBe("dec-1");
    expect(e.businessId).toBe("biz-A");
    expect(e.eventType).toBe("RECONCILIATION_MISMATCH");
    expect(e.metadata.discrepancy).toBe("INVOICE_ALREADY_PAID");
    expect(e.metadata.paymentLinkId).toBe("plink_x");
  });

  it("records an OBSERVATION, not a state transition", async () => {
    await recordSettlementDiscrepancy(client as any, base);
    const e = store.events[0];
    // from === to: the decision's status is untouched by observing a duplicate.
    expect(e.fromStatus).toBe("RECONCILED");
    expect(e.toStatus).toBe("RECONCILED");
    expect(e.actorType).toBe("SYSTEM");
  });

  it("handles the recovery variant", async () => {
    await recordSettlementDiscrepancy(client as any, {
      ...base,
      kind: "RECOVERY_ALREADY_RECOVERED",
      targetId: "rec-1",
    });
    expect(store.events[0].metadata.discrepancy).toBe("RECOVERY_ALREADY_RECOVERED");
  });

  it("is silent when no decision exists for the strategy", async () => {
    await recordSettlementDiscrepancy(client as any, { ...base, strategyId: "unknown-strat" });
    expect(store.events).toHaveLength(0);
  });

  it("is silent when the strategy is unknown", async () => {
    await recordSettlementDiscrepancy(client as any, { ...base, strategyId: null });
    expect(store.events).toHaveLength(0);
    expect(client.decision.findFirst).not.toHaveBeenCalled();
  });

  it("NEVER throws into the settlement path, even if the event write fails", async () => {
    const failing = {
      decision: { findFirst: vi.fn(async () => ({ id: "d", businessId: "b", status: "RECONCILED" })) },
      decisionEvent: {
        create: vi.fn(async () => {
          throw new Error("event store unavailable");
        }),
      },
    };
    // Observability must never be able to break the thing it observes.
    await expect(recordSettlementDiscrepancy(failing as any, base)).resolves.toBeUndefined();
  });

  it("mutates no financial state - it only reads and appends an event", async () => {
    await recordSettlementDiscrepancy(client as any, base);
    // The fake exposes no money-moving methods; assert none were reached for.
    expect((client as any).business).toBeUndefined();
    expect((client as any).invoice).toBeUndefined();
    expect(client.decisionEvent.create).toHaveBeenCalledTimes(1);
  });
});
