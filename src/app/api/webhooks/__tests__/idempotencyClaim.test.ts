import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

/**
 * THE IDEMPOTENCY CLAIM
 *
 * The webhook claimed an event by inserting a ProcessedEvent row before
 * processing, inside:
 *
 *     try { ...findUnique; ...create }
 *     catch { markDuplicate(); return { status: "ALREADY_PROCESSED" } }
 *
 * The bare catch swallowed EVERYTHING. A unique-constraint violation genuinely
 * is a duplicate, but an exhausted connection pool or a dropped socket is not -
 * and both answered HTTP 200 "ALREADY_PROCESSED". Razorpay treats 200 as
 * handled and stops retrying, so a transient database blip permanently dropped
 * a real payment with no trace in ProcessedEvent.
 *
 * Now only P2002/23505 is a duplicate. Anything else is a 500, which is what
 * makes the provider redeliver.
 */

const SECRET = "whsec_claim_test_secret_0123456789";

const state = vi.hoisted(() => ({
  processed: [] as string[],
  deliveries: [] as any[],
  settleCalls: 0,
  createError: null as any,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    processedEvent: {
      findUnique: vi.fn(async ({ where }: any) =>
        state.processed.includes(where.id) ? { id: where.id } : null
      ),
      create: vi.fn(async ({ data }: any) => {
        if (state.createError) throw state.createError;
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
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    paymentRecovery: {
      findFirst: vi.fn(async () => ({ id: "rec_1", transaction: { businessId: "biz-A" } })),
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
    return "paid";
  }),
}));

import { POST } from "../route";

/** Prisma's shape for a unique-constraint violation. */
const uniqueViolation = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

const body = (id: string, event = "payment_link.paid", entity: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    event,
    payload: {
      payment_link: { entity: { id: "plink_test", amount: 500000, amount_paid: 500000, ...entity } },
    },
  });

const post = (b: string) =>
  POST(
    new Request("http://localhost/api/webhooks", {
      method: "POST",
      body: b,
      headers: {
        "x-razorpay-signature": crypto.createHmac("sha256", SECRET).update(b).digest("hex"),
      },
    })
  );

beforeEach(() => {
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", SECRET);
  state.processed.length = 0;
  state.deliveries.length = 0;
  state.settleCalls = 0;
  state.createError = null;
});

describe("the idempotency claim distinguishes a duplicate from a database failure", () => {
  it("a genuine unique-constraint race is ALREADY_PROCESSED with a 200", async () => {
    state.createError = uniqueViolation();
    const res = await post(body("evt_race"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ALREADY_PROCESSED" });
    expect(state.deliveries.at(-1).status).toBe("DUPLICATE");
    expect(state.settleCalls).toBe(0);
  });

  it("also recognises the raw SQLSTATE, when an error escapes Prisma's wrapping", async () => {
    state.createError = Object.assign(new Error("duplicate key value"), { code: "23505" });
    const res = await post(body("evt_race_pg"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ALREADY_PROCESSED" });
  });

  it("THE BUG: a connection failure is a 500, so the provider RETRIES", async () => {
    // Before: 200 ALREADY_PROCESSED. Razorpay stopped retrying and the payment
    // was lost with no ProcessedEvent row to show for it.
    state.createError = new Error("Connection terminated due to connection timeout");
    const res = await post(body("evt_dbdown"));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("IDEMPOTENCY_CLAIM_FAILED");
    // Never claimed, so a redelivery can still settle it.
    expect(state.processed).not.toContain("evt_dbdown");
    expect(state.settleCalls).toBe(0);
  });

  it("a pool-exhaustion error is a 500, not a silent success", async () => {
    state.createError = Object.assign(new Error("Timed out fetching a connection"), { code: "P2024" });
    const res = await post(body("evt_pool"));
    expect(res.status).toBe(500);
    expect(state.settleCalls).toBe(0);
  });

  it("a failed claim still leaves a durable delivery record", async () => {
    state.createError = new Error("socket hang up");
    await post(body("evt_trace"));
    const d = state.deliveries.filter((x) => x.providerEventId === "evt_trace");
    expect(d).toHaveLength(1);
    expect(d[0].status).toBe("FAILED");
    expect(d[0].errorClass).toBe("PROCESSING_ERROR");
  });

  it("never leaks the internal error text to the caller", async () => {
    state.createError = new Error('relation "ProcessedEvent" does not exist at 10.0.0.4:5432');
    const res = await post(body("evt_leak"));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("ProcessedEvent");
    expect(text).not.toContain("10.0.0.4");
  });
});

describe("unhandled event types are ignored, not failed", () => {
  it("THE BUG: a routine unhandled event is SUCCEEDED/IGNORED, not FAILED", async () => {
    // Marking these FAILED made the failure metric count every ordinary
    // unhandled delivery, burying real settlement failures underneath them.
    const res = await post(body("evt_other", "payment.captured"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "EVENT_IGNORED" });

    const d = state.deliveries.at(-1);
    expect(d.status).toBe("SUCCEEDED");
    expect(d.errorClass).toBe("IGNORED_EVENT_TYPE");
    expect(state.settleCalls).toBe(0);
  });

  it("a genuine settlement is still SUCCEEDED with no errorClass", async () => {
    const res = await post(body("evt_real"));
    expect(res.status).toBe(200);
    const d = state.deliveries.at(-1);
    expect(d.status).toBe("SUCCEEDED");
    expect(d.errorClass ?? null).toBeNull();
    expect(state.settleCalls).toBe(1);
  });
});

describe("the settlement amount a webhook may assert", () => {
  it("a NEGATIVE amount_paid is refused with a 400 and never settles", async () => {
    const res = await post(body("evt_negative", "payment_link.paid", { amount_paid: -500000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_SETTLEMENT_AMOUNT");
    expect(state.settleCalls).toBe(0);
    // The claim is released, so a corrected redelivery can still be processed.
    expect(state.processed).not.toContain("evt_negative");
  });

  it("a fractional amount_paid is refused", async () => {
    const res = await post(body("evt_fraction", "payment_link.paid", { amount_paid: 100.5 }));
    expect(res.status).toBe(400);
    expect(state.settleCalls).toBe(0);
  });

  it("amount_paid: 0 is a VALID assertion and is passed through as zero", async () => {
    const { settlePayment } = await import("@/lib/razorpay/settlement");
    await post(body("evt_zero", "payment_link.paid", { amount_paid: 0 }));
    expect(vi.mocked(settlePayment)).toHaveBeenCalledWith(
      "plink_test",
      "biz-A",
      0,
      undefined,
      "WEBHOOK"
    );
  });

  it("a payload with NO amount at all falls back to the expected amount", async () => {
    const { settlePayment } = await import("@/lib/razorpay/settlement");
    const b = JSON.stringify({
      id: "evt_noamount",
      event: "payment_link.paid",
      payload: { payment_link: { entity: { id: "plink_test" } } },
    });
    const res = await post(b);
    expect(res.status).toBe(200);
    // undefined => settlement uses what we already know is owed, which is
    // bounded by our own record and cannot over-credit.
    expect(vi.mocked(settlePayment)).toHaveBeenCalledWith(
      "plink_test",
      "biz-A",
      undefined,
      undefined,
      "WEBHOOK"
    );
  });
});
