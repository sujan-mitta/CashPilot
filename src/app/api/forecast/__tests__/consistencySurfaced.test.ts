import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The forecast route reports whether it agrees with the materialised state.
 *
 * B-7b. The check itself is unit-tested; what these cover is that the route
 * actually calls it and surfaces the verdict, and — more importantly — that the
 * failure path degrades honestly.
 *
 * The route wraps the check in try/catch so an unavailable state can never
 * delay or break the forecast the operator came for. That containment is
 * correct, and it is also exactly how a silent lie would get in: swallowing the
 * error and reporting AGREES would defeat the entire purpose. It must report
 * NOT_COMPARABLE and say why.
 */

const { world } = vi.hoisted(() => ({
  world: {
    stateRow: null as Record<string, unknown> | null,
    stateThrows: null as Error | null,
  },
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ businessId: "biz-A", userId: "u1" })),
}));

vi.mock("@/lib/prisma", () => {
  const empty = { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) };

  // The route short-circuits to NO_DATA with no transactions, which is before
  // the consistency check runs. One pending outflow is enough to reach a real
  // forecast.
  const transactions = [
    {
      id: "tx-1",
      businessId: "biz-A",
      amount: 200_000,
      type: "OUTFLOW",
      status: "PENDING",
      description: "Rent",
      date: new Date("2026-09-05"),
      expectedDate: new Date("2026-09-05"),
      createdAt: new Date("2026-09-01"),
    },
  ];

  return {
    prisma: {
      business: {
        findUnique: vi.fn(async () => ({ id: "biz-A", name: "Acme", currentCash: 10_000_000 })),
        findFirst: vi.fn(async () => ({ id: "biz-A", name: "Acme", currentCash: 10_000_000 })),
      },
      transaction: { ...empty, findMany: vi.fn(async () => transactions) },
      invoice: empty,
      payout: empty,
      financialState: {
        findFirst: vi.fn(async () => {
          if (world.stateThrows) throw world.stateThrows;
          return world.stateRow;
        }),
      },
    },
  };
});

import { GET } from "../route";

// This route's GET takes no arguments: the tenant comes from the session, not
// from the request, which is itself the tenant-isolation guarantee.
beforeEach(() => {
  vi.clearAllMocks();
  world.stateRow = null;
  world.stateThrows = null;
});

describe("Consistency verdict on the forecast response", () => {
  it("is present on every successful forecast", async () => {
    const body = await (await GET()).json();

    // A forecast without a verdict is a forecast nobody can tell has been
    // cross-checked or not.
    expect(body.consistency).toBeDefined();
    expect(body.consistency.verdict).toBeTypeOf("string");
    expect(body.consistency.summary).toBeTruthy();
  });

  it("reports NOT_COMPARABLE when no state has been materialised", async () => {
    const body = await (await GET()).json();

    // The ordinary case before any sync. Not a disagreement.
    expect(body.consistency.verdict).toBe("NOT_COMPARABLE");
    expect(body.consistency.stateVersion).toBeNull();
  });

  it("reports NOT_COMPARABLE — never AGREES — when the state cannot be read", async () => {
    world.stateThrows = new Error("connection terminated");

    const res = await GET();
    const body = await res.json();

    // The failure this test exists for. Swallowing the error and claiming
    // agreement would defeat the whole point of the check.
    expect(res.status).toBe(200);
    expect(body.consistency.verdict).toBe("NOT_COMPARABLE");
    expect(body.consistency.verdict).not.toBe("AGREES");
    expect(body.consistency.summary).toMatch(/could not be read/i);
  });

  it("still returns the forecast when the state is unavailable", async () => {
    world.stateThrows = new Error("connection terminated");

    const body = await (await GET()).json();

    // A degraded CHECK must never degrade the forecast. It is the figure the
    // operator actually came for.
    expect(body.status).toBe("SUCCESS");
    expect(body.forecast).toBeTruthy();
    expect(body.forecast.days.length).toBeGreaterThan(0);
  });

  it("compares against the state when one exists", async () => {
    world.stateRow = {
      stateVersion: 4,
      asOf: new Date("2026-09-01"),
      cashPosition: 10_000_000,
      receivables: 0,
      payables: 0,
      expectedInflows: 0,
      expectedOutflows: 0,
      activeCommitments: 0,
      requiredBuffer: 0,
      projectedMinimumBalance: 10_000_000,
      riskState: "OK",
      reconciliation: null,
      detail: {},
      evidenceRefs: [],
    };

    const body = await (await GET()).json();

    expect(body.consistency.stateVersion).toBe(4);
    expect(["AGREES", "DIVERGED"]).toContain(body.consistency.verdict);
  });

  it("flags a divergence rather than quietly preferring one side", async () => {
    world.stateRow = {
      stateVersion: 5,
      asOf: new Date("2026-09-01"),
      // Half the cash the ledger reports.
      cashPosition: 5_000_000,
      receivables: 0,
      payables: 0,
      expectedInflows: 0,
      expectedOutflows: 0,
      activeCommitments: 0,
      requiredBuffer: 0,
      projectedMinimumBalance: 10_000_000,
      riskState: "OK",
      reconciliation: null,
      detail: {},
      evidenceRefs: [],
    };

    const body = await (await GET()).json();

    expect(body.consistency.verdict).toBe("DIVERGED");
    expect(body.consistency.findings.length).toBeGreaterThan(0);
    // The forecast is still returned, unaltered. The check reports; it does not
    // correct.
    expect(body.business.currentCash).toBe(10_000_000);
  });
});
