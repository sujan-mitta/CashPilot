import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

/**
 * M1 REGRESSION — a delivered webhook must leave durable evidence even when
 * processing fails.
 *
 * Status: VERIFIED_TEST. Real route handler, real HMAC signatures, but the
 * request originates here rather than from Razorpay.
 *
 * THE DEFECT: ProcessedEvent is claimed before processing and DELETED again by
 * releaseEventClaim() if processing throws. That release is correct - it lets
 * the provider's retry still settle a real payment - but it meant a
 * delivered-then-failed webhook left no trace anywhere. During the Phase 20
 * audit this was decisive: three payments occurred after the webhook was
 * correctly configured, ProcessedEvent held no matching row, and there was no
 * way to distinguish "never delivered" from "delivered and failed".
 *
 * WebhookDeliveryAttempt records the DELIVERY. ProcessedEvent remains the sole
 * idempotency mechanism; this does not replace it.
 */

const state = vi.hoisted(() => ({
  processed: [] as string[],
  deliveries: [] as any[],
  settleCalls: 0,
  settleShouldThrow: false,
  cash: 100_000,
}));

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
    webhookDeliveryAttempt: {
      count: vi.fn(async ({ where }: any) =>
        state.deliveries.filter((d) => d.providerEventId === where.providerEventId).length
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `wda_${state.deliveries.length + 1}`, ...data };
        state.deliveries.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = state.deliveries.find((d) => d.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
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
      findFirst: vi.fn(async () => ({ id: "intent_1", businessId: "biz-A" })),
    },
    agentAction: { findFirst: vi.fn(async () => null) },
    business: {
      findUnique: vi.fn(async () => ({ id: "biz-A" })),
      findFirst: vi.fn(async () => ({ id: "biz-A" })),
    },
  },
}));

vi.mock("@/lib/razorpay/settlement", () => ({
  settlePayment: vi.fn(async () => {
    state.settleCalls++;
    if (state.settleShouldThrow) throw new Error("simulated downstream settlement failure");
    state.cash += 100_000; // only on success
    return "paid";
  }),
}));

import { POST } from "../route";

const SECRET = "whsec_m1_test_secret_value_9876543210";

const body = (id: string, event = "payment_link.paid") =>
  JSON.stringify({
    id,
    event,
    payload: { payment_link: { entity: { id: "plink_test", amount_paid: 100000, reference_id: "cp_ref_1" } } },
  });

const sign = (b: string) => crypto.createHmac("sha256", SECRET).update(b).digest("hex");

const post = (b: string, signature?: string) =>
  POST(new Request("http://localhost/api/webhooks", {
    method: "POST",
    body: b,
    headers: signature ? { "x-razorpay-signature": signature } : {},
  }));

const deliveriesFor = (eventId: string) =>
  state.deliveries.filter((d) => d.providerEventId === eventId);

beforeEach(() => {
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", SECRET);
  state.processed.length = 0;
  state.deliveries.length = 0;
  state.settleCalls = 0;
  state.settleShouldThrow = false;
  state.cash = 100_000;
});

describe("M1 — durable webhook delivery observability", () => {
  it("records a successful delivery as SUCCEEDED with its correlation ids", async () => {
    const b = body("evt_success_1");
    const res = await post(b, sign(b));

    expect(res.status).toBe(200);
    const d = deliveriesFor("evt_success_1");
    expect(d).toHaveLength(1);
    expect(d[0].status).toBe("SUCCEEDED");
    expect(d[0].eventType).toBe("payment_link.paid");
    expect(d[0].attemptNumber).toBe(1);
    expect(d[0].externalRef).toBe("plink_test");
    expect(d[0].executionIntentId).toBe("intent_1");
    expect(d[0].businessId).toBe("biz-A");
    // ProcessedEvent remains the idempotency mechanism, untouched.
    expect(state.processed).toContain("evt_success_1");
  });

  it("records an invalid signature WITHOUT storing any signature material", async () => {
    const b = body("evt_badsig");
    const res = await post(b, "a".repeat(64));

    expect(res.status).toBe(400);
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0].status).toBe("FAILED");
    expect(state.deliveries[0].errorClass).toBe("INVALID_SIGNATURE");
    // Rejected before the body is trusted, so no event id is attributed.
    expect(state.deliveries[0].providerEventId).toBeNull();

    // Nothing anywhere may contain the secret or the presented signature.
    const dump = JSON.stringify(state.deliveries);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("a".repeat(64));
    expect(state.settleCalls).toBe(0);
  });

  it("records a missing signature as its own classification", async () => {
    const b = body("evt_nosig");
    const res = await post(b);
    expect(res.status).toBe(400);
    expect(state.deliveries[0].errorClass).toBe("MISSING_SIGNATURE");
    expect(state.settleCalls).toBe(0);
  });

  it("records a duplicate delivery as DUPLICATE, as a SECOND row", async () => {
    const b = body("evt_dup");
    await post(b, sign(b));
    await post(b, sign(b));

    const d = deliveriesFor("evt_dup");
    // Two deliveries genuinely arrived; both are visible.
    expect(d).toHaveLength(2);
    expect(d[0].status).toBe("SUCCEEDED");
    expect(d[1].status).toBe("DUPLICATE");
    expect(d[1].attemptNumber).toBe(2);
    // Settled exactly once.
    expect(state.settleCalls).toBe(1);
    expect(state.cash).toBe(200_000);
  });

  it("THE DEFECT: a processing failure keeps the delivery record even though ProcessedEvent is released", async () => {
    state.settleShouldThrow = true;
    const b = body("evt_fail");
    const res = await post(b, sign(b));

    expect(res.status).toBe(500);

    // ProcessedEvent released, so the provider's retry can still settle it.
    expect(state.processed).not.toContain("evt_fail");

    // ...but the delivery attempt SURVIVES. This is the whole of M1.
    const d = deliveriesFor("evt_fail");
    expect(d).toHaveLength(1);
    expect(d[0].status).toBe("FAILED");
    expect(d[0].errorClass).toBe("PROCESSING_ERROR");
    expect(d[0].errorMessage).toContain("simulated downstream settlement failure");
    expect(d[0].processingStartedAt).toBeDefined();

    // No partial financial mutation.
    expect(state.cash).toBe(100_000);
  });

  it("a retry after a processing failure succeeds and both attempts are visible", async () => {
    state.settleShouldThrow = true;
    const b = body("evt_retry");
    await post(b, sign(b)).catch(() => {});

    state.settleShouldThrow = false;
    const res = await post(b, sign(b));
    expect(res.status).toBe(200);

    const d = deliveriesFor("evt_retry");
    expect(d).toHaveLength(2);
    expect(d[0].status).toBe("FAILED");
    expect(d[1].status).toBe("SUCCEEDED");
    expect(d[1].attemptNumber).toBe(2);

    // The retry settled exactly once, so the release was correct.
    expect(state.cash).toBe(200_000);
    expect(state.processed).toContain("evt_retry");
  });

  it("records an unhandled event type rather than discarding it", async () => {
    const b = body("evt_other", "payment.captured");
    const res = await post(b, sign(b));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "EVENT_IGNORED" });
    const d = deliveriesFor("evt_other");
    expect(d).toHaveLength(1);
    expect(d[0].errorClass).toBe("UNKNOWN_EVENT_TYPE");
    expect(state.settleCalls).toBe(0);
  });

  it("observability never mutates financial state on its own", async () => {
    const before = state.cash;
    await post(body("evt_nosig2"));                 // rejected
    await post(body("evt_badsig2"), "b".repeat(64)); // rejected
    expect(state.cash).toBe(before);
    expect(state.settleCalls).toBe(0);
    // Both rejections still left durable evidence.
    expect(state.deliveries).toHaveLength(2);
    expect(state.deliveries.every((d) => d.status === "FAILED")).toBe(true);
  });
});
