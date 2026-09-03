import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

/**
 * A webhook signed for one merchant must not verify for another.
 *
 * Razorpay signs with a PER-ACCOUNT secret, so a deployment serving several
 * merchants cannot verify with one shared value. The account is identified by
 * the URL — /api/webhooks/<token> — and the secret that URL selects is the only
 * one the signature is checked against.
 *
 * This is the property that must not be wrong, and it needs no Razorpay account
 * to test: HMAC is HMAC, and a signature made with A's secret either verifies
 * under B's or it does not.
 */

const mocks = vi.hoisted(() => ({
  webhookSecretForToken: vi.fn(),
  recordRejectedDelivery: vi.fn(),
  beginDelivery: vi.fn(),
}));

vi.mock("@/lib/razorpay/connection", () => ({
  webhookSecretForToken: mocks.webhookSecretForToken,
}));

// Mirrors the real module's exports. Guessing at names produced a mock that
// failed for the wrong reason and proved nothing about signatures.
vi.mock("@/lib/razorpay/webhookDelivery", () => ({
  beginDelivery: mocks.beginDelivery,
  markProcessing: vi.fn().mockResolvedValue(undefined),
  markSucceeded: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
  markIgnored: vi.fn().mockResolvedValue(undefined),
  markUnmatched: vi.fn().mockResolvedValue(undefined),
  markDuplicate: vi.fn().mockResolvedValue(undefined),
  countDeliveriesForEvent: vi.fn().mockResolvedValue(1),
  recordRejectedDelivery: mocks.recordRejectedDelivery,
  UNMATCHED_RETRY_ATTEMPTS: 3,
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/observability", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  withCorrelationId: (h: unknown) => h,
}));

const SECRET_A = "merchant-a-webhook-secret";
const SECRET_B = "merchant-b-webhook-secret";

const sign = (body: string, secret: string) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

const BODY = JSON.stringify({
  event: "payment_link.paid",
  payload: { payment_link: { entity: { id: "plink_abc", reference_id: "ref_1" } } },
});

const post = async (path: string, body: string, signature: string) => {
  const { POST } = await import("../[[...token]]/route");
  return POST(
    new Request(`https://app.test${path}`, {
      method: "POST",
      headers: { "x-razorpay-signature": signature, "x-razorpay-event-id": "evt_1" },
      body,
    })
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.beginDelivery.mockResolvedValue("d1");
  mocks.recordRejectedDelivery.mockResolvedValue(undefined);
});

describe("One merchant's signature does not verify for another", () => {
  it("rejects a body signed with a DIFFERENT merchant's secret", async () => {
    // The whole point. If this passed, any merchant able to sign for their own
    // account could forge settlements against every other account on the
    // deployment.
    mocks.webhookSecretForToken.mockResolvedValue({ businessId: "biz-a", secret: SECRET_A });

    const res = await post("/api/webhooks/token-a", BODY, sign(BODY, SECRET_B));

    expect(res.status).toBe(400);
    expect(mocks.recordRejectedDelivery).toHaveBeenCalledWith("INVALID_SIGNATURE");
  });

  it("accepts a body signed with the secret that token selects", async () => {
    mocks.webhookSecretForToken.mockResolvedValue({ businessId: "biz-a", secret: SECRET_A });

    const res = await post("/api/webhooks/token-a", BODY, sign(BODY, SECRET_A));

    // Past verification. Whatever happens downstream, it is not a 400.
    expect(res.status).not.toBe(400);
  });

  it("uses the token from the URL to choose the secret", async () => {
    mocks.webhookSecretForToken.mockResolvedValue({ businessId: "biz-b", secret: SECRET_B });

    await post("/api/webhooks/token-b", BODY, sign(BODY, SECRET_B));

    expect(mocks.webhookSecretForToken).toHaveBeenCalledWith("token-b");
  });
});

describe("An unknown token is refused, never quietly downgraded", () => {
  it("returns 404 rather than falling back to the deployment secret", async () => {
    // Falling back would make the token look like security while providing
    // none: anyone could invent one and still be checked against a key that
    // might match.
    mocks.webhookSecretForToken.mockResolvedValue(null);
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET_A;

    const res = await post("/api/webhooks/made-up-token", BODY, sign(BODY, SECRET_A));

    expect(res.status).toBe(404);
  });

  it("records it as an unknown token, not an invalid signature", async () => {
    // A merchant with a stale URL should be told that, rather than being told
    // their signature was wrong when nothing was ever verified.
    mocks.webhookSecretForToken.mockResolvedValue(null);

    await post("/api/webhooks/made-up-token", BODY, sign(BODY, SECRET_A));

    expect(mocks.recordRejectedDelivery).toHaveBeenCalledWith("UNKNOWN_WEBHOOK_TOKEN");
  });
});

describe("The shared URL still serves the deployment's own account", () => {
  it("verifies against the environment secret when no token is given", async () => {
    // Existing merchants keep working with the URL they already configured;
    // this is what makes the change shippable without a cutover.
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET_A;

    const res = await post("/api/webhooks", BODY, sign(BODY, SECRET_A));

    expect(res.status).not.toBe(400);
    expect(mocks.webhookSecretForToken).not.toHaveBeenCalled();
  });

  it("still rejects a wrong signature on the shared URL", async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET_A;

    const res = await post("/api/webhooks", BODY, sign(BODY, SECRET_B));

    expect(res.status).toBe(400);
  });
});
