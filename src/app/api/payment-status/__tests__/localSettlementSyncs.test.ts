import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The settlement path that actually runs on a developer's machine syncs too.
 *
 * WHY THIS TEST EXISTS
 *
 * The financial brain sync was wired into the Razorpay webhook, and that felt
 * like the settlement path. It is not the one anybody exercises locally:
 * Razorpay will not deliver a webhook to localhost, so the sandbox checkout
 * settles through /api/payment-status with trigger POLL instead.
 *
 * The result was a fix that looked complete and did nothing where it was most
 * needed. Every locally settled payment still skipped entity resolution, so
 * Transaction.counterpartyId stayed null and the behavioural forecast stayed
 * exactly as inert as before — which is precisely the symptom the sync was
 * added to cure.
 *
 * Settlement has more than one door. This pins the one a developer walks
 * through.
 */

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  settlePayment: vi.fn(),
  reconcileDecisionForStrategy: vi.fn(),
  syncAfterSettlement: vi.fn(),
  businessFindUnique: vi.fn(),
  actionFindFirst: vi.fn(),
  recoveryFindFirst: vi.fn(),
  invoiceFindFirst: vi.fn(),
  agentActionFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/razorpay/settlement", () => ({
  settlePayment: mocks.settlePayment,
  reconcileDecisionForStrategy: mocks.reconcileDecisionForStrategy,
}));
vi.mock("@/lib/brain/afterSettlement", () => ({ syncAfterSettlement: mocks.syncAfterSettlement }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { findUnique: mocks.businessFindUnique },
    agentAction: { findFirst: mocks.actionFindFirst, findUnique: mocks.agentActionFindUnique },
    paymentRecovery: { findFirst: mocks.recoveryFindFirst },
    invoice: { findFirst: mocks.invoiceFindFirst },
    payout: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/observability", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Never constructed in these cases — the key is a placeholder, which is the
// sandbox condition — but the import must resolve.
vi.mock("razorpay", () => ({ default: class {} }));

import { GET } from "../route";

const BUSINESS = "biz-1";
const LINK = "plink_sandbox_1";

// vi.stubEnv, not a hand-rolled save/restore: NODE_ENV is defined on
// process.env with a descriptor that rejects a plain reassignment.
afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.clearAllMocks();
  // The sandbox condition: placeholder credentials, so the route simulates
  // rather than calling Razorpay.
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_placeholder");
  vi.stubEnv("RAZORPAY_KEY_SECRET", "placeholder");
  vi.stubEnv("NODE_ENV", "development");

  mocks.getSession.mockResolvedValue({ businessId: BUSINESS, userId: "u1" });
  mocks.businessFindUnique.mockResolvedValue({ id: BUSINESS, currentCash: 100000000 });
  mocks.actionFindFirst.mockResolvedValue({
    id: "act-1",
    strategyId: "strat-1",
    actionType: "PRIORITIZE_COLLECTIONS",
    status: "EXECUTING",
    amount: 30000000,
    result: JSON.stringify({ links: [{ paymentLinkId: LINK, invoiceId: "inv-1" }] }),
  });
  mocks.recoveryFindFirst.mockResolvedValue(null);
  mocks.invoiceFindFirst.mockResolvedValue({ id: "inv-1", status: "OVERDUE" });
  mocks.agentActionFindUnique.mockResolvedValue({ id: "act-1", status: "EXECUTING" });
  mocks.settlePayment.mockResolvedValue("paid");
  mocks.reconcileDecisionForStrategy.mockResolvedValue(undefined);
  mocks.syncAfterSettlement.mockResolvedValue(undefined);
});

const poll = (simulate: boolean) =>
  GET(
    new Request(
      `https://app.test/api/payment-status?paymentLinkId=${LINK}&actionId=act-1${
        simulate ? "&simulatePaid=true" : ""
      }`
    ) as never
  );

describe("A sandbox settlement folds into the brain", () => {
  it("syncs the business after the payment settles", async () => {
    await poll(true);

    expect(mocks.settlePayment).toHaveBeenCalled();
    expect(mocks.syncAfterSettlement).toHaveBeenCalledWith(
      BUSINESS,
      expect.objectContaining({ trigger: "POLL" })
    );
  });

  it("syncs only after the money is recorded, never before", async () => {
    await poll(true);

    const settledAt = mocks.settlePayment.mock.invocationCallOrder[0];
    const syncedAt = mocks.syncAfterSettlement.mock.invocationCallOrder[0];
    expect(syncedAt).toBeGreaterThan(settledAt);
  });
});

describe("Nothing is synced when nothing settled", () => {
  it("does not sync on a poll that found no payment", async () => {
    // Guards the guard: a sync fired unconditionally would satisfy the tests
    // above while telling the brain a payment arrived when none had.
    await poll(false);

    expect(mocks.settlePayment).not.toHaveBeenCalled();
    expect(mocks.syncAfterSettlement).not.toHaveBeenCalled();
  });
});
