import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "../route";
import { prisma } from "@/lib/prisma";
import { ActionStatus, RecoveryStatus } from "../../../../../generated/prisma/client";

vi.mock("@/lib/prisma", () => {
  return {
    prisma: {
      agentAction: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      paymentRecovery: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      executionIntent: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        updateMany: vi.fn(),
      },
      business: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      invoice: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      $transaction: vi.fn(),
    },
  };
});

vi.mock("@/lib/auth", () => {
  return {
    getSession: vi.fn(() => Promise.resolve({ userId: "mock-user-id", name: "Mock User", email: "mock@company.com", businessId: "business-1", businessName: "Mock Business" })),
  };
});

const mockRazorpayFetch = vi.fn();
vi.mock("razorpay", () => {
  const MockRazorpay = function(this: any) {
    this.paymentLink = {
      fetch: mockRazorpayFetch,
    };
  } as any;
  return {
    default: MockRazorpay,
  };
});

describe("Payment Status Verification Route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RAZORPAY_KEY_ID = "rzp_test_mockkey";
    process.env.RAZORPAY_KEY_SECRET = "mocksecret";
    vi.mocked(prisma.business.findFirst).mockResolvedValue({
      id: "business-1",
      name: "Mock Business",
      currentCash: 10000000,
    } as any);
    vi.mocked(prisma.business.findUnique).mockResolvedValue({
      id: "business-1",
      name: "Mock Business",
      currentCash: 10000000,
    } as any);
  });

  it("Verified Success: updates states and increments cash atomically in transaction", async () => {
    const mockAction = {
      id: "action-1",
      actionType: "RECOVER_FAILED_PAYMENTS",
      status: ActionStatus.EXECUTING,
      amount: 2400000,
      result: "plink_success",
    };

    const mockRecovery = {
      id: "recovery-1",
      status: RecoveryStatus.PAYMENT_PENDING,
      amount: 2400000,
    };

    const mockBusiness = {
      id: "business-1",
      currentCash: 10000000,
    };

    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(mockAction as any);
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue(mockRecovery as any);
    mockRazorpayFetch.mockResolvedValue({ status: "paid" });

    let txContext: any;
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (cb) => {
      txContext = {
        paymentRecovery: {
          findUnique: vi.fn().mockResolvedValue(mockRecovery as any),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        business: {
          findFirst: vi.fn().mockResolvedValue(mockBusiness as any),
          update: vi.fn(),
        },
        agentAction: {
          findUnique: vi.fn().mockResolvedValue(mockAction as any),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      return cb(txContext);
    });

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_success");
    const res = await GET(req);
    const body = await res.json();
    console.log("TEST FAILURE BODY:", body);
    expect(res.status).toBe(200);
    expect(body.status).toBe("paid");

    expect(txContext.paymentRecovery.updateMany).toHaveBeenCalledWith({
      where: { id: mockRecovery.id, status: mockRecovery.status },
      data: { status: RecoveryStatus.RECOVERED },
    });
    expect(txContext.business.update).toHaveBeenCalledWith({
      where: { id: mockBusiness.id },
      data: { currentCash: { increment: mockRecovery.amount } },
    });
    expect(txContext.agentAction.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: mockAction.id },
      data: { status: ActionStatus.RECONCILING },
    });
    expect(txContext.agentAction.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: mockAction.id, status: ActionStatus.RECONCILING },
      data: {
        status: ActionStatus.COMPLETED,
        result: `Successfully recovered via Razorpay Link plink_success`,
        predictionActual: expect.any(Object),
        auditLog: expect.any(Array),
      },
    });
  });

  it("Verified Failure: does not trigger database writes or cash increments", async () => {
    const mockAction = {
      id: "action-1",
      actionType: "RECOVER_FAILED_PAYMENTS",
      status: ActionStatus.EXECUTING,
      amount: 2400000,
      result: "plink_fail",
    };

    const mockRecovery = {
      id: "recovery-1",
      status: RecoveryStatus.PAYMENT_PENDING,
      amount: 2400000,
    };

    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(mockAction as any);
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue(mockRecovery as any);
    mockRazorpayFetch.mockResolvedValue({ status: "cancelled" });

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_fail");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("cancelled");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("Network Error: falls back to local database status and does not mark success", async () => {
    const mockAction = {
      id: "action-1",
      actionType: "RECOVER_FAILED_PAYMENTS",
      status: ActionStatus.EXECUTING,
      amount: 2400000,
      result: "plink_neterr",
    };

    const mockRecovery = {
      id: "recovery-1",
      status: RecoveryStatus.PAYMENT_PENDING,
      amount: 2400000,
    };

    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(mockAction as any);
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue(mockRecovery as any);
    mockRazorpayFetch.mockRejectedValue(new Error("Network connection lost"));

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_neterr");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("created"); // defaults to pending/created status
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("Timeout: does not mark success and retains pending state", async () => {
    const mockAction = {
      id: "action-1",
      actionType: "RECOVER_FAILED_PAYMENTS",
      status: ActionStatus.EXECUTING,
      amount: 2400000,
      result: "plink_timeout",
    };

    const mockRecovery = {
      id: "recovery-1",
      status: RecoveryStatus.PAYMENT_PENDING,
      amount: 2400000,
    };

    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(mockAction as any);
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue(mockRecovery as any);
    mockRazorpayFetch.mockRejectedValue(new Error("Request timeout"));

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_timeout");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("created");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("Unexpected Response: preserves status as pending and does not increment cash", async () => {
    const mockAction = {
      id: "action-1",
      actionType: "RECOVER_FAILED_PAYMENTS",
      status: ActionStatus.EXECUTING,
      amount: 2400000,
      result: "plink_weird",
    };

    const mockRecovery = {
      id: "recovery-1",
      status: RecoveryStatus.PAYMENT_PENDING,
      amount: 2400000,
    };

    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(mockAction as any);
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue(mockRecovery as any);
    mockRazorpayFetch.mockResolvedValue({ status: "unexpected_state" });

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_weird");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("unexpected_state");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("Duplicate Status Check: does not duplicate cash or recovery completions", async () => {
    const mockAction = {
      id: "action-1",
      actionType: "RECOVER_FAILED_PAYMENTS",
      status: ActionStatus.COMPLETED,
      amount: 2400000,
      result: "plink_dup",
    };

    const mockRecovery = {
      id: "recovery-1",
      status: RecoveryStatus.RECOVERED,
      amount: 2400000,
    };

    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(mockAction as any);
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue(mockRecovery as any);
    mockRazorpayFetch.mockResolvedValue({ status: "paid" });

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_dup");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("paid");

    // Since it's already RECOVERED, check that updates were bypassed and transaction was never started
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("Failure During Update: transaction rejects and propagates error cleanly without partial mutations", async () => {
    const mockAction = {
      id: "action-1",
      actionType: "RECOVER_FAILED_PAYMENTS",
      status: ActionStatus.EXECUTING,
      amount: 2400000,
      result: "plink_txerr",
    };

    const mockRecovery = {
      id: "recovery-1",
      status: RecoveryStatus.PAYMENT_PENDING,
      amount: 2400000,
    };

    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(mockAction as any);
    vi.mocked(prisma.paymentRecovery.findFirst).mockResolvedValue(mockRecovery as any);
    mockRazorpayFetch.mockResolvedValue({ status: "paid" });

    vi.mocked(prisma.$transaction).mockRejectedValue(new Error("Database connection lost during update"));

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_txerr");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(500);
    // The raw driver message used to be returned verbatim. A Prisma/pg error
    // carries table names, column names and sometimes connection detail, none
    // of which belongs in a response body. It is logged server-side instead.
    expect(body.error).toBe("Could not check the payment status. Please try again.");
    expect(JSON.stringify(body)).not.toContain("Database connection lost");
  });

  it("Concurrency: simultaneous requests only increment cash once", async () => {
    const mockAction = {
      id: "action-1",
      actionType: "RECOVER_FAILED_PAYMENTS",
      status: ActionStatus.EXECUTING,
      amount: 2400000,
      result: "plink_success",
    };

    const mockRecovery = {
      id: "recovery-1",
      status: RecoveryStatus.PAYMENT_PENDING,
      amount: 2400000,
    };

    const mockBusiness = {
      id: "business-1",
      currentCash: 10000000,
    };

    // Set up sequential behavior: first read is PENDING, subsequent reads are RECOVERED
    let findUniqueCallCount = 0;
    const mockFindUnique = vi.fn().mockImplementation(() => {
      findUniqueCallCount++;
      return Promise.resolve({
        ...mockRecovery,
        status: findUniqueCallCount > 1 ? RecoveryStatus.RECOVERED : RecoveryStatus.PAYMENT_PENDING,
      });
    });

    let findFirstCallCount = 0;
    const mockFindFirst = vi.fn().mockImplementation(() => {
      findFirstCallCount++;
      return Promise.resolve({
        ...mockRecovery,
        status: findFirstCallCount > 1 ? RecoveryStatus.RECOVERED : RecoveryStatus.PAYMENT_PENDING,
      });
    });

    vi.mocked(prisma.agentAction.findFirst).mockResolvedValue(mockAction as any);
    vi.mocked(prisma.paymentRecovery.findFirst).mockImplementation(mockFindFirst);
    mockRazorpayFetch.mockResolvedValue({ status: "paid" });

    // Set up sequential behavior for updateMany: first returns count: 1, second returns count: 0
    let updateManyCallCount = 0;
    const mockUpdateMany = vi.fn().mockImplementation(() => {
      updateManyCallCount++;
      return Promise.resolve({ count: updateManyCallCount === 1 ? 1 : 0 });
    });

    const txContext = {
      paymentRecovery: {
        findUnique: mockFindUnique,
        updateMany: mockUpdateMany,
        update: vi.fn(),
      },
      business: {
        findFirst: vi.fn().mockResolvedValue(mockBusiness as any),
        update: vi.fn(),
      },
      agentAction: {
        findUnique: vi.fn().mockResolvedValue(mockAction as any),
        updateMany: vi.fn().mockResolvedValue({ count: 1 } as any),
        update: vi.fn(),
      },
    };

    vi.mocked(prisma.$transaction).mockImplementation((cb) => {
      return cb(txContext as any);
    });

    const req1 = new Request("http://localhost/api/payment-status?paymentLinkId=plink_success");
    const req2 = new Request("http://localhost/api/payment-status?paymentLinkId=plink_success");

    const [res1, res2] = await Promise.all([
      GET(req1),
      GET(req2)
    ]);

    const body1 = await res1.json();
    const body2 = await res2.json();

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(body1.status).toBe("paid");
    expect(body2.status).toBe("paid");

    // Verify cash was only incremented exactly once (since only one updateMany returned count: 1)
    expect(txContext.business.update).toHaveBeenCalledTimes(1);
  });
});
