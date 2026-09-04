import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

/**
 * A settled payment folds itself into the brain — and never fails because of it.
 *
 * WHY THE SYNC IS HERE AT ALL
 *
 * Settlement is the one moment new payment history exists: an invoice gains a
 * paidAt, which is the only input the behaviour model has for "how late does
 * this customer actually pay?". Nothing on the settlement path resolved
 * entities or refreshed the state snapshot, so that history piled up without
 * ever being attributed to a counterparty and the behavioural forecast could
 * not use a single day of it. The only callers of syncFinancialBrain were the
 * alert dispatcher and a manual script.
 *
 * WHY ITS FAILURE MUST NOT PROPAGATE
 *
 * The money is settled, recorded and emailed before this runs. Throwing here
 * fails the webhook, and Razorpay retries a payment that has ALREADY been
 * applied. A stale brain is a worse forecast; a retried settlement is a
 * corrupted ledger. The trade is not close.
 */

const mocks = vi.hoisted(() => ({
  webhookSecretForToken: vi.fn(),
  settlePayment: vi.fn(),
  syncFinancialBrain: vi.fn(),
  notifySettlement: vi.fn(),
  beginDelivery: vi.fn(),
  markSucceeded: vi.fn(),
  intentFindUnique: vi.fn(),
  intentFindFirst: vi.fn(),
  businessFindUnique: vi.fn(),
  processedFindUnique: vi.fn(),
  processedCreate: vi.fn(),
  processedDelete: vi.fn(),
}));

vi.mock("@/lib/razorpay/connection", () => ({ webhookSecretForToken: mocks.webhookSecretForToken }));
vi.mock("@/lib/razorpay/settlement", () => ({ settlePayment: mocks.settlePayment }));
vi.mock("@/lib/brain/sync", () => ({ syncFinancialBrain: mocks.syncFinancialBrain }));
vi.mock("@/lib/notifications/settlementNotice", () => ({ notifySettlement: mocks.notifySettlement }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    executionIntent: { findUnique: mocks.intentFindUnique, findFirst: mocks.intentFindFirst },
    business: { findUnique: mocks.businessFindUnique },
    // The replay guard: the route claims the event id before doing any work,
    // and releases the claim if processing fails.
    processedEvent: {
      findUnique: mocks.processedFindUnique,
      create: mocks.processedCreate,
      delete: mocks.processedDelete,
    },
    paymentRecovery: { findFirst: vi.fn().mockResolvedValue(null) },
    agentAction: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/razorpay/webhookDelivery", () => ({
  beginDelivery: mocks.beginDelivery,
  markProcessing: vi.fn().mockResolvedValue(undefined),
  markSucceeded: mocks.markSucceeded,
  markFailed: vi.fn().mockResolvedValue(undefined),
  markIgnored: vi.fn().mockResolvedValue(undefined),
  markUnmatched: vi.fn().mockResolvedValue(undefined),
  markDuplicate: vi.fn().mockResolvedValue(undefined),
  countDeliveriesForEvent: vi.fn().mockResolvedValue(1),
  recordRejectedDelivery: vi.fn().mockResolvedValue(undefined),
  UNMATCHED_RETRY_ATTEMPTS: 3,
}));
vi.mock("@/lib/observability", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  withCorrelationId: (h: unknown) => h,
}));

const SECRET = "merchant-secret";
const BUSINESS = "biz-1";

const BODY = JSON.stringify({
  event: "payment_link.paid",
  payload: {
    payment_link: {
      entity: { id: "plink_abc", reference_id: "ref_1", amount: 30000000, amount_paid: 30000000 },
    },
  },
});

import { POST } from "../[[...token]]/route";

const savedSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
afterEach(() => {
  if (savedSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
  else process.env.RAZORPAY_WEBHOOK_SECRET = savedSecret;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.webhookSecretForToken.mockResolvedValue({ businessId: BUSINESS, secret: SECRET });
  mocks.intentFindUnique.mockResolvedValue({ id: "i1", businessId: BUSINESS });
  mocks.intentFindFirst.mockResolvedValue({ id: "i1", businessId: BUSINESS });
  mocks.businessFindUnique.mockResolvedValue({ id: BUSINESS });
  mocks.settlePayment.mockResolvedValue("paid");
  mocks.notifySettlement.mockResolvedValue({ sent: 1, suppressed: 0 });
  mocks.syncFinancialBrain.mockResolvedValue({ businessId: BUSINESS, entities: null, state: null });
  mocks.beginDelivery.mockResolvedValue("d1");
  mocks.processedFindUnique.mockResolvedValue(null);
  mocks.processedCreate.mockResolvedValue({ id: "evt_1" });
  mocks.processedDelete.mockResolvedValue({ id: "evt_1" });
  mocks.markSucceeded.mockResolvedValue(undefined);
});

const post = () =>
  POST(
    new Request("https://app.test/api/webhooks/token-a", {
      method: "POST",
      headers: {
        "x-razorpay-signature": crypto.createHmac("sha256", SECRET).update(BODY).digest("hex"),
        "x-razorpay-event-id": "evt_1",
      },
      body: BODY,
    })
  );

describe("Settlement refreshes the financial brain", () => {
  it("syncs the business the payment belonged to", async () => {
    await post();
    expect(mocks.syncFinancialBrain).toHaveBeenCalledWith(expect.anything(), BUSINESS);
  });

  it("does it only after the money is actually settled", async () => {
    await post();
    const settledAt = mocks.settlePayment.mock.invocationCallOrder[0];
    const syncedAt = mocks.syncFinancialBrain.mock.invocationCallOrder[0];
    expect(syncedAt).toBeGreaterThan(settledAt);
  });
});

describe("A failing sync never costs a settled payment", () => {
  it("still answers success when the sync throws", async () => {
    // The failure that must not propagate. A non-2xx here makes Razorpay retry
    // a payment that has already moved the ledger.
    mocks.syncFinancialBrain.mockRejectedValue(new Error("brain exploded"));

    const res = await post();

    expect(res.status).toBe(200);
  });

  it("still records the delivery as succeeded", async () => {
    mocks.syncFinancialBrain.mockRejectedValue(new Error("brain exploded"));

    await post();

    // The delivery genuinely did succeed: the money was applied. Marking it
    // otherwise would misreport a settlement that happened.
    expect(mocks.markSucceeded).toHaveBeenCalled();
  });

  it("does not swallow a failure in the settlement itself", async () => {
    // Guards the guard: the try/catch is scoped to the sync alone. A settlement
    // that genuinely failed must still answer non-2xx, because THAT is the case
    // where a Razorpay retry is wanted — no money was applied.
    mocks.settlePayment.mockRejectedValue(new Error("settlement failed"));

    const res = await post();

    expect(res.status).not.toBe(200);
    expect(mocks.syncFinancialBrain).not.toHaveBeenCalled();
  });
});
