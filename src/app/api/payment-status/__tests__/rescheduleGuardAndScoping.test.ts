import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/payment-status — three defects.
 *
 *  1. The RESCHEDULE_PAYOUT discrepancy check ran at EVERY stage. An action
 *     still PENDING or APPROVED has, by definition, not moved its payout yet,
 *     so `status !== RESCHEDULED` was trivially true and polling ANY unrelated
 *     payment link stamped RECONCILIATION_MISMATCH onto every pending
 *     reschedule in the tenant.
 *
 *  2. It wrote that status with a raw `update`, bypassing
 *     validateActionTransition - the only mutation in the codebase that did -
 *     so it could also drag terminal actions backwards.
 *
 *  3. The catch block's recovery lookup had no tenant filter, so it answered
 *     "paid" for any tenant's payment link that matched a guessed id.
 */

const world = vi.hoisted(() => ({
  action: null as any,
  payout: null as any,
  recoveries: [] as any[],
  recoveryQueries: [] as any[],
  updateManyCalls: [] as any[],
  throwOnBusinessLookup: false,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: {
      findUnique: vi.fn(async () => {
        if (world.throwOnBusinessLookup) throw new Error("Access Denied: internal guard text");
        return { id: "biz-A", currentCash: 0 };
      }),
    },
    agentAction: {
      findFirst: vi.fn(async () => world.action),
      findUnique: vi.fn(async () => world.action),
      update: vi.fn(),
      updateMany: vi.fn(async ({ where, data }: any) => {
        world.updateManyCalls.push({ where, data });
        if (world.action && world.action.status === where.status) {
          world.action.status = data.status;
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    payout: { findFirst: vi.fn(async () => world.payout) },
    paymentRecovery: {
      findFirst: vi.fn(async (query: any) => {
        world.recoveryQueries.push(query);
        return (
          world.recoveries.find(
            (r) =>
              r.paymentLinkId === query.where.paymentLinkId &&
              (!query.where.transaction?.businessId ||
                r.businessId === query.where.transaction.businessId)
          ) ?? null
        );
      }),
    },
    invoice: { findFirst: vi.fn(async () => null) },
    decision: { findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async (cb: any) => cb({})),
  },
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({
    userId: "u-A",
    name: "Op",
    email: "op@a.test",
    businessId: "biz-A",
    businessName: "A",
  })),
}));

vi.mock("@/lib/razorpay/settlement", () => ({
  settlePayment: vi.fn(async () => "created"),
  reconcileDecisionForStrategy: vi.fn(async () => {}),
}));

import { GET } from "../route";

const get = (qs: string) => GET(new Request(`http://localhost/api/payment-status?${qs}`));

const rescheduleAction = (status: string) => ({
  id: "act-resched",
  strategyId: "strat-1",
  actionType: "RESCHEDULE_PAYOUT",
  status,
  targetPayoutId: "payout-1",
  amount: 500_000,
  result: "plink_A",
  auditLog: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RAZORPAY_KEY_ID", "placeholder");
  vi.stubEnv("RAZORPAY_KEY_SECRET", "placeholder");
  vi.stubEnv("NODE_ENV", "test");
  world.payout = { id: "payout-1", businessId: "biz-A", status: "SCHEDULED" };
  world.recoveries = [];
  world.recoveryQueries = [];
  world.updateManyCalls = [];
  world.throwOnBusinessLookup = false;
});

describe("the reschedule discrepancy check only applies after execution", () => {
  it("THE BUG: a PENDING reschedule is left alone, not marked as a mismatch", async () => {
    world.action = rescheduleAction("PENDING");
    const res = await get("paymentLinkId=plink_A");
    expect(res.status).toBe(200);
    expect(world.action.status).toBe("PENDING");
  });

  it("THE BUG: an APPROVED reschedule is left alone", async () => {
    // Nothing has run yet, so a SCHEDULED payout is correct, not a discrepancy.
    world.action = rescheduleAction("APPROVED");
    await get("paymentLinkId=plink_A");
    expect(world.action.status).toBe("APPROVED");
  });

  it("an EXECUTING reschedule whose payout never moved IS a mismatch", async () => {
    world.action = rescheduleAction("EXECUTING");
    await get("paymentLinkId=plink_A");
    expect(world.action.status).toBe("RECONCILIATION_MISMATCH");
  });

  it("it reaches the mismatch through RECONCILING, as the state machine requires", async () => {
    // The machine has no direct EXECUTING -> RECONCILIATION_MISMATCH edge. The
    // old raw `update` simply ignored that.
    world.action = rescheduleAction("EXECUTING");
    await get("paymentLinkId=plink_A");
    const statuses = world.updateManyCalls.map((c) => c.data.status);
    expect(statuses).toEqual(["RECONCILING", "RECONCILIATION_MISMATCH"]);
  });

  it("uses a compare-and-set, so a concurrent settlement is not overwritten", async () => {
    world.action = rescheduleAction("EXECUTING");
    await get("paymentLinkId=plink_A");
    expect(world.updateManyCalls[0].where).toMatchObject({ id: "act-resched", status: "EXECUTING" });
  });

  it("a payout that DID move is not flagged at all", async () => {
    world.action = rescheduleAction("EXECUTING");
    world.payout = { id: "payout-1", businessId: "biz-A", status: "RESCHEDULED" };
    await get("paymentLinkId=plink_A");
    expect(world.action.status).toBe("EXECUTING");
    expect(world.updateManyCalls).toHaveLength(0);
  });

  it("a REJECTED action is never dragged out of its terminal state", async () => {
    world.action = rescheduleAction("REJECTED");
    await get("paymentLinkId=plink_A");
    expect(world.action.status).toBe("REJECTED");
  });

  it("an action with no target payout is skipped rather than matched by luck", async () => {
    world.action = { ...rescheduleAction("EXECUTING"), targetPayoutId: null };
    await get("paymentLinkId=plink_A");
    expect(world.action.status).toBe("EXECUTING");
  });
});

describe("tenant scoping in the failure path", () => {
  it("THE BUG: the catch-block recovery lookup is scoped to the caller's tenant", async () => {
    // A foreign tenant's link must not answer "paid" for a guessed id.
    world.action = rescheduleAction("EXECUTING");
    world.throwOnBusinessLookup = true;
    world.recoveries = [
      { paymentLinkId: "plink_FOREIGN", businessId: "biz-B", status: "RECOVERED" },
    ];

    const res = await get("paymentLinkId=plink_FOREIGN");
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.status).not.toBe("paid");
    // Every recovery lookup that ran carried a tenant filter.
    for (const q of world.recoveryQueries) {
      expect(q.where.transaction?.businessId).toBeDefined();
    }
  });

  it("never returns the internal guard text or a foreign tenant id", async () => {
    world.action = rescheduleAction("EXECUTING");
    world.throwOnBusinessLookup = true;
    const body = JSON.stringify(await (await get("paymentLinkId=plink_FOREIGN")).json());
    expect(body).not.toContain("Access Denied");
    expect(body).not.toContain("biz-B");
  });
});
