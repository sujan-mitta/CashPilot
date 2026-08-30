import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { POST as handleWebhook } from "../route";
import { prisma } from "@/lib/prisma";
import { UNMATCHED_RETRY_ATTEMPTS } from "@/lib/razorpay/webhookDelivery";

/**
 * A webhook for a payment link CashPilot does not manage.
 *
 * Found in production against a real ₹100 test payment. The handler answered
 * 404 and released the idempotency claim, so Razorpay retried with backoff —
 * four deliveries in 45 seconds — and no amount of retrying could ever produce
 * a business that does not exist.
 *
 * The consequence is worse than noise. Providers disable endpoints that keep
 * failing, which is the most likely explanation for the Phase 18 webhook going
 * silent after 13 failed deliveries. One unmanaged link — created in the
 * Razorpay dashboard, by another integration, or from a CashPilot record since
 * deleted — could take settlement down for every real obligation.
 *
 * These drive the real handler. A bounded number of retries covers the genuine
 * race where the provider delivers before our own row commits; past that the
 * event is acknowledged rather than retried forever.
 */

const { world } = vi.hoisted(() => ({
  world: { deliveryCount: 0, claimDeleted: 0 },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    processedEvent: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "evt" })),
      delete: vi.fn(async () => {
        world.claimDeleted++;
        return {};
      }),
    },
    // Nothing links this payment link to a business — the case under test.
    paymentRecovery: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    agentAction: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    executionIntent: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    business: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    webhookDeliveryAttempt: {
      create: vi.fn(async () => ({ id: "wda_1" })),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => world.deliveryCount),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
  },
}));

const SECRET = "test_webhook_secret";

function signedRequest(paymentLinkId: string, eventId = "evt_unmatched_1") {
  const body = JSON.stringify({
    event: "payment_link.paid",
    payload: { payment_link: { entity: { id: paymentLinkId } } },
  });
  const signature = crypto.createHmac("sha256", SECRET).update(body).digest("hex");

  return new Request("http://localhost/api/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": eventId,
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
  world.deliveryCount = 0;
  world.claimDeleted = 0;
});

describe("While the race is still plausible", () => {
  it("asks the provider to retry on an early delivery", async () => {
    world.deliveryCount = 1;

    const res = await handleWebhook(signedRequest("plink_unknown"));

    // Retryable, because Razorpay can deliver before our own row commits and
    // giving up immediately would drop a settlement we were milliseconds from
    // being able to match.
    expect(res.status).toBe(503);
  });

  it("releases the claim so the retry can be reprocessed", async () => {
    world.deliveryCount = 1;
    await handleWebhook(signedRequest("plink_unknown"));

    expect(world.claimDeleted).toBe(1);
  });
});

describe("Once the link is accepted as genuinely unknown", () => {
  it("acknowledges with 200 instead of failing", async () => {
    world.deliveryCount = UNMATCHED_RETRY_ATTEMPTS + 1;

    const res = await handleWebhook(signedRequest("plink_unknown"));

    // THE REGRESSION THIS GUARDS. A 404 or 5xx here is a request to try again,
    // and Razorpay honours it forever.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(404);
  });

  it("names the outcome rather than reporting a bare success", async () => {
    world.deliveryCount = UNMATCHED_RETRY_ATTEMPTS + 1;

    const body = await (await handleWebhook(signedRequest("plink_unknown"))).json();

    // 200 must not be mistaken for "we settled something".
    expect(body.outcome).toBe("UNMATCHED_PAYMENT_LINK");
    expect(body.paymentLinkId).toBe("plink_unknown");
  });

  it("keeps the idempotency claim, so a later delivery is not reprocessed", async () => {
    world.deliveryCount = UNMATCHED_RETRY_ATTEMPTS + 1;
    await handleWebhook(signedRequest("plink_unknown"));

    // The event has been definitively handled. Releasing the claim would invite
    // the same fruitless work on every future delivery of it.
    expect(world.claimDeleted).toBe(0);
  });

  it("moves no money", async () => {
    world.deliveryCount = UNMATCHED_RETRY_ATTEMPTS + 1;
    await handleWebhook(signedRequest("plink_unknown"));

    // Acknowledging is not settling. There is no business, so there is nothing
    // to credit, and nothing may be credited.
    expect(prisma.business.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.anything() })
    );
  });
});

describe("Signature is still required", () => {
  it("rejects an unsigned delivery before any of this applies", async () => {
    world.deliveryCount = UNMATCHED_RETRY_ATTEMPTS + 1;

    const body = JSON.stringify({
      event: "payment_link.paid",
      payload: { payment_link: { entity: { id: "plink_unknown" } } },
    });
    const res = await handleWebhook(
      new Request("http://localhost/api/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    );

    // The unmatched path must never become a way in past authentication.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });
});
