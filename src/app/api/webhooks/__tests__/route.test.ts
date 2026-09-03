import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST as handleWebhook } from "../[[...token]]/route";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

vi.mock("@/lib/prisma", () => {
  return {
    prisma: {
      processedEvent: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      paymentRecovery: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      agentAction: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        updateMany: vi.fn(),
      },
      executionIntent: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        updateMany: vi.fn(),
      },
      business: {
        update: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ id: "business-1", name: "Mock Business", currentCash: 10000000 }),
        findFirst: vi.fn().mockResolvedValue({ id: "business-1", name: "Mock Business", currentCash: 10000000 }),
      },
      $transaction: vi.fn((cb) => cb(prisma)),
    },
  };
});

describe("Razorpay Webhook Verification Gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret";
  });

  it("POST /api/webhooks rejects request with 400 if signature is invalid", async () => {
    const mockBody = JSON.stringify({ id: "evt_1", event: "payment_link.paid" });
    const req = new Request("http://localhost/api/webhooks", {
      method: "POST",
      headers: {
        "x-razorpay-signature": "invalid_sig",
      },
      body: mockBody,
    });

    const res = await handleWebhook(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid signature");
  });

  it("POST /api/webhooks processes valid signature events and enforces idempotency", async () => {
    const mockEvent = {
      id: "evt_12345",
      event: "payment_link.paid",
      payload: {
        payment_link: {
          entity: {
            id: "plink_123",
          },
        },
      },
    };

    const mockBody = JSON.stringify(mockEvent);
    const secret = "test_webhook_secret";
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(mockBody)
      .digest("hex");

    // Mock ProcessedEvent lookup: not processed yet
    vi.mocked(prisma.processedEvent.findUnique).mockResolvedValue(null);

    // Mock business lookup relationships
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue({
      id: "recovery-1",
      amount: 100000,
      status: "RECOVERY_CANDIDATE",
      transaction: { businessId: "business-1" },
    } as any);

    const req = new Request("http://localhost/api/webhooks", {
      method: "POST",
      headers: {
        "x-razorpay-signature": expectedSig,
      },
      body: mockBody,
    });

    const res = await handleWebhook(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("paid");
    expect(prisma.processedEvent.create).toHaveBeenCalledWith({ data: { id: "evt_12345" } });
  });

  it("POST /api/webhooks ignores duplicate events immediately without balance mutations", async () => {
    const mockEvent = {
      id: "evt_duplicate",
      event: "payment_link.paid",
      payload: {
        payment_link: {
          entity: {
            id: "plink_123",
          },
        },
      },
    };

    const mockBody = JSON.stringify(mockEvent);
    const secret = "test_webhook_secret";
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(mockBody)
      .digest("hex");

    // Mock ProcessedEvent lookup: already exists!
    vi.mocked(prisma.processedEvent.findUnique).mockResolvedValue({ id: "evt_duplicate" } as any);

    const req = new Request("http://localhost/api/webhooks", {
      method: "POST",
      headers: {
        "x-razorpay-signature": expectedSig,
      },
      body: mockBody,
    });

    const res = await handleWebhook(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ALREADY_PROCESSED");
    expect(prisma.paymentRecovery.findFirst).not.toHaveBeenCalled();
  });
});
