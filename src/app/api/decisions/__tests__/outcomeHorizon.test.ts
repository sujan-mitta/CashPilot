import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE OUTCOME MEASUREMENT HORIZON
 *
 * GET /api/decisions/[id] proactively measures a decision once its window
 * closes, and computed that window as:
 *
 *     decision.createdAt + 14 * 24 * 60 * 60 * 1000
 *
 * `Decision.outcomeMeasurementHorizonDays` exists precisely BECAUSE 14 is not
 * always right: a strategy that defers an obligation past the forecast window
 * needs a longer window to observe it, and /api/strategies computes and stores
 * exactly that per decision.
 *
 * The literal threw it away, so a payout deliberately moved to day 20 was
 * measured on day 14 - before it came due. The one case the field was added
 * for was the one case it did not cover.
 */

const world = vi.hoisted(() => ({
  decision: null as any,
  measured: [] as string[],
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { decision: { findFirst: vi.fn(async () => world.decision) } },
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "u-1",
    name: "Op",
    email: "op@a.test",
    businessId: "biz-1",
    businessName: "Acme",
  })),
}));

vi.mock("@/lib/engine/outcomeMeasurer", () => ({
  measureDecisionOutcome: vi.fn(async (id: string) => {
    world.measured.push(id);
    return { id, status: "OUTCOME_MEASURED" };
  }),
}));

import { GET } from "../[id]/route";

const DAY = 86_400_000;
const ctx = { params: Promise.resolve({ id: "dec-1" }) };
const req = new Request("http://localhost/api/decisions/dec-1");

const decisionAgedDays = (days: number, horizonDays: number | null) => ({
  id: "dec-1",
  businessId: "biz-1",
  status: "EXECUTED",
  createdAt: new Date(Date.now() - days * DAY),
  outcomeMeasurementHorizonDays: horizonDays,
  strategy: { agentActions: [] },
});

beforeEach(() => {
  vi.clearAllMocks();
  world.measured = [];
});

describe("proactive measurement honours the decision's OWN horizon", () => {
  it("THE BUG: a deferred obligation is NOT measured before it comes due", async () => {
    // Deferred to day 20, so measuring on day 15 would report on an obligation
    // that has not happened yet.
    world.decision = decisionAgedDays(15, 20);
    await GET(req as any, ctx as any);
    expect(world.measured).toEqual([]);
  });

  it("...and IS measured once its own longer window closes", async () => {
    world.decision = decisionAgedDays(21, 20);
    await GET(req as any, ctx as any);
    expect(world.measured).toEqual(["dec-1"]);
  });

  it("an ordinary 14-day decision still measures at 14 days", async () => {
    world.decision = decisionAgedDays(15, 14);
    await GET(req as any, ctx as any);
    expect(world.measured).toEqual(["dec-1"]);
  });

  it("an ordinary decision is not measured early", async () => {
    world.decision = decisionAgedDays(13, 14);
    await GET(req as any, ctx as any);
    expect(world.measured).toEqual([]);
  });

  it("exactly at the boundary counts as closed", async () => {
    world.decision = {
      ...decisionAgedDays(0, 14),
      createdAt: new Date(Date.now() - 14 * DAY),
    };
    await GET(req as any, ctx as any);
    expect(world.measured).toEqual(["dec-1"]);
  });

  it("falls back to the configured window when the horizon is missing or nonsensical", async () => {
    // Legacy rows predate the field; 0 or a negative would otherwise measure
    // every decision immediately on creation.
    for (const horizon of [null, 0, -5]) {
      world.measured = [];
      world.decision = decisionAgedDays(13, horizon as any);
      await GET(req as any, ctx as any);
      expect(world.measured, `horizon: ${horizon}`).toEqual([]);

      world.measured = [];
      world.decision = decisionAgedDays(15, horizon as any);
      await GET(req as any, ctx as any);
      expect(world.measured, `horizon: ${horizon}`).toEqual(["dec-1"]);
    }
  });

  it("an already-measured decision is never re-measured", async () => {
    world.decision = { ...decisionAgedDays(30, 14), status: "OUTCOME_MEASURED" };
    await GET(req as any, ctx as any);
    expect(world.measured).toEqual([]);
  });

  it("stays tenant-scoped", async () => {
    const { prisma } = await import("@/lib/prisma");
    world.decision = decisionAgedDays(1, 14);
    await GET(req as any, ctx as any);
    expect(vi.mocked(prisma.decision.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "dec-1", businessId: "biz-1" } })
    );
  });

  it("a missing decision is a 404, not a 500", async () => {
    world.decision = null;
    expect((await GET(req as any, ctx as any)).status).toBe(404);
  });
});
