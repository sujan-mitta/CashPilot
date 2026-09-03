import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET as getPaymentStatus } from "../../payment-status/route";
import { POST as handleWebhook } from "../../webhooks/[[...token]]/route";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import crypto from "crypto";

vi.mock("@/lib/prisma", () => {
  const mockPrisma = {
    business: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    transaction: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    payout: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    invoice: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    strategy: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    agentAction: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    paymentRecovery: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    executionIntent: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(),
    },
    processedEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn((cb) => cb(mockPrisma)),
  };
  return { prisma: mockPrisma };
});

vi.mock("@/lib/auth", () => {
  return {
    getSession: vi.fn(),
    signSession: vi.fn((payload) => {
      const payloadWithExp = { ...payload, exp: payload.exp || (Date.now() + 604800000) };
      const str = JSON.stringify(payloadWithExp);
      const signature = crypto.createHmac("sha256", "test_secret").update(str).digest("hex");
      return `${Buffer.from(str).toString("base64")}.${signature}`;
    }),
    verifySession: vi.fn((token) => {
      try {
        const [payloadBase64, signature] = token.split(".");
        const payloadStr = Buffer.from(payloadBase64, "base64").toString("utf-8");
        const expected = crypto.createHmac("sha256", "test_secret").update(payloadStr).digest("hex");
        if (signature === expected) {
          const parsed = JSON.parse(payloadStr);
          if (parsed && typeof parsed.exp === "number" && Date.now() > parsed.exp) {
            return null;
          }
          return parsed;
        }
      } catch {}
      return null;
    }),
  };
});

vi.mock("@/lib/ai/agents", () => {
  return {
    runAgent: vi.fn(() => Promise.resolve("Mocked Narration")),
  };
});

describe("CashPilot Idempotency and Race Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // These tests exercise the payment-status route's SANDBOX branch, which the
    // route selects by reading RAZORPAY_* from the environment on every request.
    // That dependency used to be ambient: the branch was taken only because no
    // credentials happened to be set. Running with RAZORPAY_LIVE_TEST=1 loads
    // real ones (see vitest.config.ts), the route then tried to fetch these
    // fictional link ids from Razorpay, and three race assertions failed for a
    // reason that had nothing to do with the races under test.
    //
    // Stubbing makes the intent explicit and the suite hermetic either way.
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_placeholder");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "placeholder_secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // TEST 1 — WEBHOOK WINS
  it("Test 1: Webhook wins race: polling request returns 200 paid and does not duplicate cash mutation", async () => {
    const mockSession = { userId: "u-A", businessId: "biz-A" };
    vi.mocked(getSession).mockResolvedValue(mockSession as any);
    vi.mocked(prisma.business.findUnique).mockResolvedValue({ id: "biz-A", currentCash: 1000 } as any);

    // Mock recovery owned by biz-A
    const mockRecovery = { id: "rec_A", amount: 10000, status: "PAYMENT_PENDING", transaction: { businessId: "biz-A" } };
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue(mockRecovery as any);

    // First call to findUnique (by polling inside transaction) returns already RECOVERED
    // indicating the Webhook request has won the race and updated the status
    vi.mocked(prisma.paymentRecovery.findUnique).mockResolvedValue({
      ...mockRecovery,
      status: "RECOVERED",
    } as any);

    const mockAction = { id: "act_A", actionType: "RECOVER_FAILED_PAYMENTS", status: "EXECUTING", amount: 10000 };
    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(mockAction as any);
    vi.mocked(prisma.agentAction.findUnique).mockResolvedValue(mockAction as any);

    // Mock CAS failure (count: 0) for polling since Webhook already completed it
    vi.mocked(prisma.paymentRecovery.updateMany).mockResolvedValue({ count: 0 } as any);

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_A&simulatePaid=true");
    const res = await getPaymentStatus(req);

    // Expect successful 200 status with "paid" rather than 400 error
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("paid");

    // No cash updates occurred in polling (since it returned early on re-fetch check)
    expect(prisma.business.update).not.toHaveBeenCalled();
  });

  // TEST 2 — POLLING WINS
  it("Test 2: Polling wins race: webhook request resolves idempotently without duplicating cash increment", async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "webhook_secret";

    const mockBody = {
      id: "evt_1",
      event: "payment_link.paid",
      payload: {
        payment_link: { entity: { id: "plink_A" } }
      }
    };
    const bodyStr = JSON.stringify(mockBody);
    const sig = crypto.createHmac("sha256", "webhook_secret").update(bodyStr).digest("hex");

    vi.mocked(prisma.processedEvent.findUnique).mockResolvedValue(null);

    // Mock webhook lookup
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue({
      id: "rec_A",
      amount: 10000,
      status: "PAYMENT_PENDING",
      transaction: { businessId: "biz-A" }
    } as any);

    // Webhook findUnique (inside settlement transaction) returns RECOVERED
    // indicating polling has won the race
    vi.mocked(prisma.paymentRecovery.findUnique).mockResolvedValue({
      id: "rec_A",
      amount: 10000,
      status: "RECOVERED",
      transaction: { businessId: "biz-A" }
    } as any);

    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.paymentRecovery.updateMany).mockResolvedValue({ count: 0 } as any);

    const req = new Request("http://localhost/api/webhooks", {
      method: "POST",
      headers: { "x-razorpay-signature": sig },
      body: bodyStr,
    });

    const res = await handleWebhook(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("paid");

    // No cash mutation in webhook
    expect(prisma.business.update).not.toHaveBeenCalled();
  });

  // TEST 3 — ALREADY SETTLED POLLING RETRY
  it("Test 3: Polling an already settled payment returns 200 paid and triggers no additional cash updates", async () => {
    const mockSession = { userId: "u-A", businessId: "biz-A" };
    vi.mocked(getSession).mockResolvedValue(mockSession as any);
    vi.mocked(prisma.business.findUnique).mockResolvedValue({ id: "biz-A", currentCash: 1000 } as any);

    // Business A owns the link, status is already RECOVERED
    const mockRecovery = { id: "rec_A", amount: 10000, status: "RECOVERED", transaction: { businessId: "biz-A" } };
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue(mockRecovery as any);

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_A");
    const res = await getPaymentStatus(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("paid");

    // No transaction settlement triggers
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // TEST 4 — TRUE INVALID TRANSITION
  // 409 CONFLICT, not 400. The client's request was well-formed; the RESOURCE
  // is in a state that forbids the operation, which is what 409 exists to say.
  // 400 told the caller they had sent something wrong, which they had not.
  it("Test 4: Genuinely incompatible state returns 409 INVALID_TRANSITION and mutates no ledger records", async () => {
    const mockSession = { userId: "u-A", businessId: "biz-A" };
    vi.mocked(getSession).mockResolvedValue(mockSession as any);
    vi.mocked(prisma.business.findUnique).mockResolvedValue({ id: "biz-A", currentCash: 1000 } as any);

    // Mock recovery status is EXPIRED (illegal to settle)
    const mockRecovery = { id: "rec_A", amount: 10000, status: "EXPIRED", transaction: { businessId: "biz-A" } };
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue(mockRecovery as any);
    vi.mocked(prisma.paymentRecovery.findUnique).mockResolvedValue(mockRecovery as any);

    const mockAction = { id: "act_A", actionType: "RECOVER_FAILED_PAYMENTS", status: "EXECUTING", amount: 10000 };
    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(mockAction as any);
    vi.mocked(prisma.agentAction.findUnique).mockResolvedValue(mockAction as any);

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_A&simulatePaid=true");
    const res = await getPaymentStatus(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("INVALID_TRANSITION");
    // The stable code is what a client may branch on. The internal
    // state-machine text - which names action ids and enum values - is logged,
    // never returned.
    expect(JSON.stringify(body)).not.toMatch(/Invalid (recovery|action) transition/);

    // No ledger increments
    expect(prisma.business.update).not.toHaveBeenCalled();
  });

  // TEST 5 — TENANT SAFETY AFTER CAS LOSS
  it("Test 5: Post-CAS re-fetch strictly enforces tenant boundaries and throws Access Denied on foreign recovery mismatch", async () => {
    const mockSession = { userId: "u-A", businessId: "biz-A" };
    vi.mocked(getSession).mockResolvedValue(mockSession as any);
    vi.mocked(prisma.business.findUnique).mockResolvedValue({ id: "biz-A", currentCash: 1000 } as any);

    // Business A owns the link initially
    const mockRecovery = { id: "rec_A", amount: 10000, status: "PAYMENT_PENDING", transaction: { businessId: "biz-A" } };
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue(mockRecovery as any);

    const mockAction = { id: "act_A", actionType: "RECOVER_FAILED_PAYMENTS", status: "EXECUTING", amount: 10000 };
    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(mockAction as any);
    vi.mocked(prisma.agentAction.findUnique).mockResolvedValue(mockAction as any);

    vi.mocked(prisma.paymentRecovery.updateMany).mockResolvedValue({ count: 0 } as any);

    // During re-fetch, the resolved recovery returned is fake or belongs to biz-B (attack scenario)
    vi.mocked(prisma.paymentRecovery.findUnique).mockResolvedValue({
      id: "rec_A",
      amount: 10000,
      status: "RECOVERED",
      transaction: { businessId: "biz-B" }, // Mismatched tenant!
    } as any);

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_A&simulatePaid=true");
    const res = await getPaymentStatus(req);

    // The tenant guard throws, so the request fails rather than silently
    // accepting a foreign record.
    expect(res.status).toBe(500);
    const body = await res.json();

    // What matters is that NOTHING MOVED - not that the response quotes our
    // internal guard text back at the caller. The message used to be the raw
    // "Access Denied: recovery record belongs to a different tenant", which
    // confirms to an attacker that the id they guessed is real and belongs to
    // someone else. The refusal is logged; the client gets a generic 500.
    expect(prisma.business.update).not.toHaveBeenCalled();
    expect(prisma.paymentRecovery.update).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("Access Denied");
    expect(JSON.stringify(body)).not.toContain("biz-B");
  });
});
