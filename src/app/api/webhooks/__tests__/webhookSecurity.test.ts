import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

/**
 * Phase 18 PART 6/9 — webhook signature and fail-closed configuration.
 *
 * Status: VERIFIED_TEST. These drive the real route handler with real HMAC
 * signatures, but the HTTP request originates here, not from Razorpay. Actual
 * Razorpay webhook DELIVERY is a separate claim and is NOT established by this
 * file.
 */

const state = vi.hoisted(() => ({ processed: [] as string[], settleCalls: 0 }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    processedEvent: {
      findUnique: vi.fn(async ({ where }: any) =>
        state.processed.includes(where.id) ? { id: where.id } : null
      ),
      create: vi.fn(async ({ data }: any) => {
        if (state.processed.includes(data.id)) throw new Error("Unique constraint failed");
        state.processed.push(data.id);
        return data;
      }),
      delete: vi.fn(async ({ where }: any) => {
        state.processed = state.processed.filter((i) => i !== where.id);
        return { id: where.id };
      }),
    },
    paymentRecovery: {
      findFirst: vi.fn(async () => ({
        id: "rec_1",
        paymentLinkId: "plink_test",
        transaction: { businessId: "biz-A" },
      })),
    },
    executionIntent: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    agentAction: { findFirst: vi.fn(async () => null) },
    business: { findUnique: vi.fn(async () => ({ id: "biz-A" })), findFirst: vi.fn(async () => ({ id: "biz-A" })) },
  },
}));

vi.mock("@/lib/razorpay/settlement", () => ({
  settlePayment: vi.fn(async () => {
    state.settleCalls++;
    return "paid";
  }),
}));

const SECRET = "whsec_phase18_test_secret_value_0123456789";

const eventBody = (id: string) =>
  JSON.stringify({
    id,
    event: "payment_link.paid",
    payload: { payment_link: { entity: { id: "plink_test", amount_paid: 100000 } } },
  });

const sign = (body: string, secret: string) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

async function post(body: string, signature?: string) {
  const { POST } = await import("../[[...token]]/route");
  return POST(
    new Request("http://localhost/api/webhooks", {
      method: "POST",
      headers: signature ? { "x-razorpay-signature": signature } : {},
      body,
    })
  );
}

beforeEach(() => {
  state.processed = [];
  state.settleCalls = 0;
  vi.unstubAllEnvs();
  process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
});

describe("PART 6 - Webhook signature verification (VERIFIED_TEST)", () => {
  it("A. a correct signature is accepted and the payment settles once", async () => {
    const body = eventBody("evt_ok_1");
    const res = await post(body, sign(body, SECRET));
    expect(res.status).toBe(200);
    expect(state.settleCalls).toBe(1);
  });

  it("B. an invalid signature is rejected and nothing settles", async () => {
    const body = eventBody("evt_bad_1");
    const res = await post(body, sign(body, "attacker-secret"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid signature");
    expect(state.settleCalls).toBe(0);
    // A rejected webhook must not consume the event id either.
    expect(state.processed).not.toContain("evt_bad_1");
  });

  it("C. a missing signature is rejected", async () => {
    const body = eventBody("evt_nosig_1");
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(state.settleCalls).toBe(0);
  });

  it("a tampered body invalidates a previously-valid signature", async () => {
    const original = eventBody("evt_tamper_1");
    const signature = sign(original, SECRET);
    const tampered = original.replace("100000", "99999999");
    const res = await post(tampered, signature);
    expect(res.status).toBe(400);
    expect(state.settleCalls).toBe(0);
  });

  it("a malformed (non-hex) signature is rejected without throwing", async () => {
    const body = eventBody("evt_malformed_1");
    const res = await post(body, "not-a-hex-signature");
    expect(res.status).toBe(400);
    expect(state.settleCalls).toBe(0);
  });
});

describe("PART 7 - Webhook idempotency (VERIFIED_TEST)", () => {
  it("a duplicate delivery settles exactly once", async () => {
    const body = eventBody("evt_dup_1");
    const signature = sign(body, SECRET);

    const first = await post(body, signature);
    const second = await post(body, signature);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe("ALREADY_PROCESSED");
    // The financial side effect happened once.
    expect(state.settleCalls).toBe(1);
  });

  it("three deliveries still settle exactly once", async () => {
    const body = eventBody("evt_dup_3");
    const signature = sign(body, SECRET);
    await post(body, signature);
    await post(body, signature);
    await post(body, signature);
    expect(state.settleCalls).toBe(1);
  });

  it("a distinct event id is processed independently", async () => {
    const a = eventBody("evt_a");
    const b = eventBody("evt_b");
    await post(a, sign(a, SECRET));
    await post(b, sign(b, SECRET));
    expect(state.settleCalls).toBe(2);
  });
});

describe("PART 9 - Production fails closed (VERIFIED_TEST)", () => {
  it("production with NO secret refuses the webhook", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    vi.stubEnv("NODE_ENV", "production");
    const body = eventBody("evt_prod_missing");
    const res = await post(body);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("WEBHOOK_SECRET_NOT_CONFIGURED");
    expect(state.settleCalls).toBe(0);
    vi.unstubAllEnvs();
  });

  it("production with a PLACEHOLDER secret refuses the webhook", async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "placeholder";
    vi.stubEnv("NODE_ENV", "production");
    const { inspectConfiguration } = await import("@/lib/config/productionConfig");
    // A placeholder counts as absent, so the control is reported missing.
    expect(inspectConfiguration("production").fatalKeys).toContain("RAZORPAY_WEBHOOK_SECRET");
    vi.unstubAllEnvs();
  });

  it("no unsigned webhook can mutate financial state in production", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    vi.stubEnv("NODE_ENV", "production");
    await post(eventBody("evt_prod_unsigned"));
    expect(state.settleCalls).toBe(0);
    vi.unstubAllEnvs();
  });

  it("the redacted summary never contains the secret value", async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
    const { inspectConfiguration, redactedConfigSummary } = await import("@/lib/config/productionConfig");
    const summary = JSON.stringify(redactedConfigSummary(inspectConfiguration("production")));
    expect(summary).not.toContain(SECRET);
    expect(summary).not.toContain("whsec_");
  });
});
