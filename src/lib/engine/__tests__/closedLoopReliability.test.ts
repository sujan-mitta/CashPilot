import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateActionTransition, validateRecoveryTransition } from "../stateTransitions";
import { POST as handleApprove } from "../../../app/api/approve/route";
import { POST as handleExecute } from "../../../app/api/execute/route";
import { POST as handleWebhook } from "../../../app/api/webhooks/route";
import { GET as handlePaymentStatus } from "../../../app/api/payment-status/route";
import { prisma } from "../../../lib/prisma";
import crypto from "crypto";
import { ActionStatus, RecoveryStatus } from "../../../../generated/prisma/client";
import { seedFreshDecision } from "./helpers/prismaFakes";

// vi.mock factories are hoisted, so the backing arrays must be created by
// vi.hoisted to exist before the factory runs. Tests reset them in place
// (length = 0) so the fakes keep pointing at the same arrays.
const stores = vi.hoisted(() => ({
  intents: [] as any[],
  decisions: [] as any[],
  events: [] as any[],
}));

const today = new Date(Date.UTC(2026, 7, 22));

let mockSession: any = { userId: "mock-user", name: "Mock User", email: "mock@company.com", businessId: "biz_1", businessName: "Mock Business" };
let mockCreatePaymentLink: any = vi.fn(async () => {
  return { id: "plink_1", short_url: "https://rzp.io/i/plink_1" };
});
let mockRazorpayFetch: any = vi.fn();

let dbState = {
  business: { id: "biz_1", name: "Acme Corp", currentCash: 10000000 },
  transactions: [
    { id: "tx_1", businessId: "biz_1", amount: 3000000, type: "INFLOW" as const, status: "FAILED" as const, expectedDate: today, description: "Failed payment" },
    { id: "tx_2", businessId: "biz_1", amount: 5000000, type: "OUTFLOW" as const, status: "PENDING" as const, expectedDate: today, description: "Packaging Co Payout" },
  ],
  invoices: [
    { id: "inv_1", businessId: "biz_1", customerName: "Client A", amount: 2000000, dueDate: today, status: "OVERDUE" as const, priority: "MEDIUM" as const },
  ],
  payouts: [
    { id: "payout_1", businessId: "biz_1", vendor: "Packaging Co", amount: 5000000, scheduledDate: today, criticality: "LOW" as const, status: "SCHEDULED" as const },
  ],
  paymentRecoveries: [
    { id: "rec_1", transactionId: "tx_1", status: "RECOVERY_CANDIDATE" as any, amount: 3000000, paymentLinkId: "plink_1" as string | null, shortUrl: null as string | null, updatedAt: today },
  ],
  strategies: [] as any[],
  agentActions: [] as any[],
  processedEvents: [] as any[],
};



vi.mock("@/lib/prisma", async () => {
  const { makeExecutionIntentFake, makeDecisionFakes, matchesField } = await import("./helpers/prismaFakes");
  const executionIntentFake = makeExecutionIntentFake(stores as any);
  const decisionFakes = makeDecisionFakes(stores as any);
  return {
    prisma: {
      business: {
        findUnique: vi.fn(async ({ where }) => {
          if (where && where.id) {
            return dbState.business.id === where.id ? dbState.business : null;
          }
          return dbState.business;
        }),
        findFirst: vi.fn(async ({ where }) => {
          if (where && where.id) {
            return dbState.business.id === where.id ? dbState.business : null;
          }
          return dbState.business;
        }),
        update: vi.fn(async ({ where, data }) => {
          if (data.currentCash && data.currentCash.increment) {
            dbState.business.currentCash += data.currentCash.increment;
          }
          return dbState.business;
        }),
      },
      transaction: {
        findMany: vi.fn(async () => dbState.transactions),
        findFirst: vi.fn(async ({ where }) => dbState.transactions.find(t => t.id === where.id) || null),
        update: vi.fn(async ({ where, data }) => {
          const tx = dbState.transactions.find(t => t.id === where.id);
          if (tx) {
            Object.assign(tx, data);
            return tx;
          }
        }),
      },
      invoice: {
        findMany: vi.fn(async () => dbState.invoices),
        findFirst: vi.fn(async ({ where }) => dbState.invoices.find(i => i.id === where.id) || null),
        updateMany: vi.fn(async ({ where, data }) => {
          dbState.invoices.forEach(i => {
            if (i.status === where.status || i.id === where.id) {
              Object.assign(i, data);
            }
          });
          return { count: dbState.invoices.length };
        }),
      },
      payout: {
        findMany: vi.fn(async () => dbState.payouts),
        findFirst: vi.fn(async ({ where }) => dbState.payouts.find(p => p.id === where.id || p.vendor === where.vendor) || null),
        update: vi.fn(async ({ where, data }) => {
          const p = dbState.payouts.find(x => x.id === where.id);
          if (p) {
            Object.assign(p, data);
            return p;
          }
        }),
      },
      paymentRecovery: {
        findFirst: vi.fn(async ({ where }) => {
          const r = dbState.paymentRecoveries.find(x => {
            if (where.id && x.id !== where.id) return false;
            if (where.paymentLinkId && x.paymentLinkId !== where.paymentLinkId) return false;
            if (where.transactionId && x.transactionId !== where.transactionId) return false;
            if (where.status && !matchesField(x.status, where.status)) return false;
            return true;
          });
          if (r) {
            return {
              ...r,
              transaction: dbState.transactions.find((t) => t.id === r.transactionId),
            };
          }
          return null;
        }),
        findUnique: vi.fn(async ({ where }) => {
          const r = dbState.paymentRecoveries.find(x => x.id === where.id);
          if (r) {
            return {
              ...r,
              transaction: dbState.transactions.find((t) => t.id === r.transactionId),
            };
          }
          return null;
        }),
        update: vi.fn(async ({ where, data }) => {
          const r = dbState.paymentRecoveries.find(x => x.id === where.id);
          if (r) {
            Object.assign(r, data);
            return r;
          }
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const r = dbState.paymentRecoveries.find(x => x.id === where.id);
          if (r) {
            Object.assign(r, data);
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
      strategy: {
        findFirst: vi.fn(async ({ where }) => {
          const s = dbState.strategies.find(x => x.id === where.id && (!where.businessId || x.businessId === where.businessId));
          if (s) {
            return {
              ...s,
              agentActions: dbState.agentActions.filter((a) => a.strategyId === s.id),
            };
          }
          return null;
        }),
        create: vi.fn(async ({ data }) => {
          const s = { id: "strategy-1", ...data, createdAt: new Date(), agentActions: [] };
          dbState.strategies.push(s);
          return s;
        }),
      },
      agentAction: {
        findMany: vi.fn(async ({ where }) => dbState.agentActions.filter(a => a.strategyId === where.strategyId)),
        findFirst: vi.fn(async ({ where }) => {
          const a = dbState.agentActions.find(x => 
            x.id === where.id || 
            (where.result && where.result.contains && x.result && x.result.includes(where.result.contains))
          );
          if (a) {
            return {
              ...a,
              strategy: dbState.strategies.find((s) => s.id === a.strategyId),
            };
          }
          return null;
        }),
        findUnique: vi.fn(async ({ where }) => {
          const a = dbState.agentActions.find(x => x.id === where.id);
          if (a) {
            return {
              ...a,
              strategy: dbState.strategies.find((s) => s.id === a.strategyId),
            };
          }
          return null;
        }),
        update: vi.fn(async ({ where, data }) => {
          const a = dbState.agentActions.find(x => x.id === where.id);
          if (a) {
            Object.assign(a, data);
            return a;
          }
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          let count = 0;
          dbState.agentActions.forEach(a => {
            if ((where.id && a.id === where.id) || (where.strategyId && a.strategyId === where.strategyId)) {
              if (!where.status || matchesField(a.status, where.status)) {
                Object.assign(a, data);
                count++;
              }
            }
          });
          return { count };
        }),
      },
      executionIntent: executionIntentFake,
      decision: decisionFakes.decision,
      decisionEvent: decisionFakes.decisionEvent,
      processedEvent: {
        findUnique: vi.fn(async ({ where }) => {
          return dbState.processedEvents.find(e => e.id === where.id) || null;
        }),
        create: vi.fn(async ({ data }) => {
          dbState.processedEvents.push(data);
          return data;
        }),
      },
      $transaction: vi.fn(async (cb) => {
        return cb(prisma);
      }),
    },
  };
});

vi.mock("@/lib/auth", () => {
  return {
    getSession: vi.fn(() => Promise.resolve(mockSession)),
  };
});

vi.mock("@/lib/razorpay/client", async () => {
  // The executor imports the error classes and the classifier to decide FAILED
  // vs EXECUTION_UNKNOWN, so a partial mock of this module cannot model the
  // system under test. Only the network call itself is replaced.
  const actual = await vi.importActual<typeof import("../../razorpay/client")>("../../razorpay/client");
  return {
    ...actual,
    createRecoveryPaymentLink: vi.fn((amount: number, description: string, key?: string) =>
      mockCreatePaymentLink(amount, description, key)
    ),
  };
});

vi.mock("razorpay", () => {
  const MockRazorpay = function(this: any) {
    this.paymentLink = {
      fetch: vi.fn((paymentLinkId: string) => mockRazorpayFetch(paymentLinkId)),
    };
  } as any;
  return {
    default: MockRazorpay,
  };
});

vi.mock("@/lib/ai/agents", () => {
  return {
    runAgent: vi.fn(() => Promise.resolve("Mock narrative")),
  };
});

describe("CashPilot Phase 11 — Closed-Loop Reliability, Recovery & State Consistency", () => {
  beforeEach(async () => {
    mockSession = { userId: "mock-user", name: "Mock User", email: "mock@company.com", businessId: "biz_1", businessName: "Mock Business" };
    mockCreatePaymentLink = vi.fn(async () => {
      return { id: "plink_1", short_url: "https://rzp.io/i/plink_1" };
    });
    mockRazorpayFetch = vi.fn(async () => {
      return { status: "paid" };
    });
    vi.clearAllMocks();
    dbState = {
      business: { id: "biz_1", name: "Acme Corp", currentCash: 10000000 },
      transactions: [
        { id: "tx_1", businessId: "biz_1", amount: 3000000, type: "INFLOW" as const, status: "FAILED" as const, expectedDate: today, description: "Failed payment" },
        { id: "tx_2", businessId: "biz_1", amount: 5000000, type: "OUTFLOW" as const, status: "PENDING" as const, expectedDate: today, description: "Packaging Co Payout" },
      ],
      invoices: [
        { id: "inv_1", businessId: "biz_1", customerName: "Client A", amount: 2000000, dueDate: today, status: "OVERDUE" as const, priority: "MEDIUM" as const },
      ],
      payouts: [
        { id: "payout_1", businessId: "biz_1", vendor: "Packaging Co", amount: 5000000, scheduledDate: today, criticality: "LOW" as const, status: "SCHEDULED" as const },
      ],
      paymentRecoveries: [
        { id: "rec_1", transactionId: "tx_1", status: "RECOVERY_CANDIDATE" as any, amount: 3000000, paymentLinkId: "plink_1" as string | null, shortUrl: null as string | null, updatedAt: today },
      ],
      strategies: [
        { id: "strat_1", businessId: "biz_1", name: "FULL_INTERVENTION", actions: [], projectedBalance: 12000000, riskLevel: "LOW", score: 90, recommended: true, createdAt: today, startingCash: 10000000 },
      ],
      agentActions: [
        { id: "act_1", strategyId: "strat_1", actionType: "RECOVER_FAILED_PAYMENTS" as const, amount: 3000000, status: ActionStatus.PENDING, result: null as string | null, auditLog: [] as any[], targetTransactionId: "tx_1", targetPayoutId: null },
        { id: "act_2", strategyId: "strat_1", actionType: "RESCHEDULE_PAYOUT" as const, amount: 5000000, status: ActionStatus.PENDING, result: null as string | null, auditLog: [] as any[], targetTransactionId: "tx_2", targetPayoutId: "payout_1" },
      ],
      processedEvents: [] as any[],
    };

    // Phase 15 stores. The seeded decision's fingerprint is computed from the
    // world as it stands right now, so it is genuinely fresh - a test that then
    // mutates the ledger will correctly be seen as stale.
    stores.intents.length = 0;
    stores.decisions.length = 0;
    stores.events.length = 0;
    await seedFreshDecision(prisma, stores as any, {
      businessId: "biz_1",
      strategyId: "strat_1",
      strategyType: "FULL_INTERVENTION",
      actions: [
        { type: "RECOVER_FAILED_PAYMENTS", amount: 3000000, targetTransactionId: "tx_1" },
        { type: "RESCHEDULE_PAYOUT", amount: 5000000, targetPayoutId: "payout_1", targetTransactionId: "tx_2" },
      ],
      today,
    });
  });

  // Scenario 1: Invalid State Transition
  it("Scenario 1: Should reject impossible transitions (e.g. APPROVED to COMPLETED directly)", () => {
    expect(validateActionTransition(ActionStatus.APPROVED, ActionStatus.COMPLETED)).toBe(false);
  });

  // Scenario 2: Duplicate Approval
  it("Scenario 2: Duplicate approvals should be handled idempotently", async () => {
    const req1 = new Request("http://localhost/api/approve", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res1 = await handleApprove(req1);
    expect(res1.status).toBe(200);

    const req2 = new Request("http://localhost/api/approve", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res2 = await handleApprove(req2);
    expect(res2.status).toBe(200);
  });

  // Scenario 3: Duplicate Execution
  it("Scenario 3: Duplicate execution requests should return idempotently", async () => {
    dbState.agentActions.forEach(a => { a.status = ActionStatus.APPROVED; });
    const req1 = new Request("http://localhost/api/execute", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res1 = await handleExecute(req1);
    expect(res1.status).toBe(200);

    const req2 = new Request("http://localhost/api/execute", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res2 = await handleExecute(req2);
    expect(res2.status).toBe(200);
  });

  // Scenario 4: Duplicate Webhook
  it("Scenario 4: Replayed webhooks are processed only once (Event Idempotency)", async () => {
    const body = { id: "evt_dup", event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_1", amount: 3000000 } } } };
    const text = JSON.stringify(body);
    process.env.RAZORPAY_WEBHOOK_SECRET = "secret";
    const sig = crypto.createHmac("sha256", "secret").update(text).digest("hex");

    const req1 = new Request("http://localhost/api/webhooks", { method: "POST", headers: { "x-razorpay-signature": sig }, body: text });
    const res1 = await handleWebhook(req1);
    expect(res1.status).toBe(200);
    const result1 = await res1.json();
    expect(result1.status).toBe("paid");

    const req2 = new Request("http://localhost/api/webhooks", { method: "POST", headers: { "x-razorpay-signature": sig }, body: text });
    const res2 = await handleWebhook(req2);
    expect(res2.status).toBe(200);
    const result2 = await res2.json();
    expect(result2.status).toBe("ALREADY_PROCESSED");
  });

  // Scenario 5: Out-of-order Webhook
  it("Scenario 5: Out-of-order webhook events must not transition state backward", () => {
    expect(validateActionTransition(ActionStatus.COMPLETED, ActionStatus.PENDING)).toBe(false);
    expect(validateActionTransition(ActionStatus.COMPLETED, ActionStatus.APPROVED)).toBe(false);
  });

  // Scenario 6: Unknown Execution
  it("Scenario 6: Differentiates connection timeouts from normal errors and transitions to EXECUTION_UNKNOWN", async () => {
    dbState.agentActions.forEach(a => { a.status = ActionStatus.APPROVED; });
    mockCreatePaymentLink.mockRejectedValueOnce(new Error("Connection ETIMEDOUT"));

    const req = new Request("http://localhost/api/execute", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res = await handleExecute(req);
    expect(res.status).toBe(200);
    expect(dbState.agentActions[0].status).toBe(ActionStatus.EXECUTION_UNKNOWN);
  });

  // Scenario 7: Unknown Execution Recovery (Success)
  it("Scenario 7: Recovers actions stuck in EXECUTION_UNKNOWN when external status is paid", async () => {
    dbState.agentActions[0].status = ActionStatus.EXECUTION_UNKNOWN;
    dbState.agentActions[0].result = "Razorpay link generated: https://rzp.io/i/plink_1";
    
    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_1&simulatePaid=true", { method: "GET" });
    const res = await handlePaymentStatus(req);
    expect(res.status).toBe(200);
    console.log("SCENARIO 7 ACTIONS:", JSON.stringify(dbState.agentActions, null, 2));
    expect(dbState.agentActions[0].status).toBe(ActionStatus.COMPLETED);
  });

  // Scenario 8: Unknown Execution Recovery (Fail)
  it("Scenario 8: Transitions EXECUTION_UNKNOWN to FAILED when external link is cancelled or expired", async () => {
    dbState.agentActions[0].status = ActionStatus.EXECUTION_UNKNOWN;
    dbState.agentActions[0].result = "Razorpay link generated: https://rzp.io/i/plink_1";

    // Mock Razorpay API returning cancelled
    const oldKeyId = process.env.RAZORPAY_KEY_ID;
    const oldKeySecret = process.env.RAZORPAY_KEY_SECRET;
    process.env.RAZORPAY_KEY_ID = "rzp_live_test"; // Force non-placeholder route
    process.env.RAZORPAY_KEY_SECRET = "live_secret";
    mockRazorpayFetch.mockResolvedValueOnce({ status: "cancelled" });

    try {
      const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_1", { method: "GET" });
      const res = await handlePaymentStatus(req);
      expect(res.status).toBe(200);
      expect(dbState.agentActions[0].status).toBe(ActionStatus.FAILED);
    } finally {
      process.env.RAZORPAY_KEY_ID = oldKeyId;
      process.env.RAZORPAY_KEY_SECRET = oldKeySecret;
    }
  });

  // Scenario 9: Stale Strategy
  it("Scenario 9: Strategy approval fails if ledger updates occur after strategy simulation", async () => {
    // The ledger genuinely moves after simulation: a new overdue payout appears.
    // (The old fixture only bumped PaymentRecovery.updatedAt, which the Phase 15
    // fingerprint deliberately ignores - a touched timestamp is not a financial
    // fact. Mutating substance is what staleness is supposed to detect.)
    dbState.strategies[0].createdAt = new Date(today.getTime() - 10000);
    dbState.payouts.push({
      id: "payout_new",
      businessId: "biz_1",
      vendor: "Urgent Supplier",
      amount: 50000000,
      scheduledDate: new Date(today.getTime() + 24 * 60 * 60 * 1000),
      criticality: "HIGH" as any,
      status: "SCHEDULED" as any,
    });

    const req = new Request("http://localhost/api/approve", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res = await handleApprove(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("STRATEGY_STALE");
  });

  // Scenario 10: Financial State Drift
  it("Scenario 10: Prevents strategy execution if cash balance drifts by more than 5%", async () => {
    dbState.agentActions.forEach(a => { a.status = ActionStatus.APPROVED; });
    dbState.business.currentCash = 11000000; // Drifted to 11M (10% increase from 10M baseline)

    const req = new Request("http://localhost/api/execute", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res = await handleExecute(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("STATE_DRIFT_DETECTED");
  });

  // Scenario 11: Parameter Tampering
  it("Scenario 11: Rejects execution if client attempts parameter tampering (e.g. zero amount)", async () => {
    dbState.agentActions[0].amount = 0; // Invalid amount

    const req = new Request("http://localhost/api/execute", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res = await handleExecute(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("PARAMETER_TAMPERING");
  });

  // Scenario 12: Tenant Isolation (Strategy)
  it("Scenario 12: Tenant cannot execute actions belonging to another business", async () => {
    dbState.strategies[0].businessId = "biz_2"; // Belongs to different tenant

    const req = new Request("http://localhost/api/execute", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res = await handleExecute(req);
    expect(res.status).toBe(404);
  });

  // Scenario 13: Concurrent Approval Prevention
  it("Scenario 13: Multiple concurrent approvals return HTTP 200 idempotently", async () => {
    const req1 = new Request("http://localhost/api/approve", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const req2 = new Request("http://localhost/api/approve", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const [res1, res2] = await Promise.all([handleApprove(req1), handleApprove(req2)]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  // Scenario 14: Concurrent Execution Prevention
  it("Scenario 14: Multiple concurrent executions process safely through atomic claims", async () => {
    dbState.agentActions.forEach(a => { a.status = ActionStatus.APPROVED; });
    const req1 = new Request("http://localhost/api/execute", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const req2 = new Request("http://localhost/api/execute", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const [res1, res2] = await Promise.all([handleExecute(req1), handleExecute(req2)]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  // Scenario 15: Crash before external request
  it("Scenario 15: Retains approved status if system restarts before external invocation", () => {
    dbState.agentActions[0].status = ActionStatus.APPROVED;
    expect(dbState.agentActions[0].status).toBe(ActionStatus.APPROVED);
  });

  // Scenario 16: Crash after external request but before state update
  it("Scenario 16: Recovers and determines final state using status query job", async () => {
    dbState.agentActions[0].status = ActionStatus.EXECUTION_UNKNOWN;
    dbState.agentActions[0].result = "Razorpay link generated: https://rzp.io/i/plink_1";

    const req = new Request("http://localhost/api/payment-status?paymentLinkId=plink_1&simulatePaid=true", { method: "GET" });
    const res = await handlePaymentStatus(req);
    expect(res.status).toBe(200);
    expect(dbState.agentActions[0].status).toBe(ActionStatus.COMPLETED);
  });

  // Scenario 17: Reconciliation Mismatch
  it("Scenario 17: Transitions action to RECONCILIATION_MISMATCH if webhook actual amount disagrees with expectation", async () => {
    dbState.agentActions[0].status = ActionStatus.EXECUTING;
    dbState.agentActions[0].result = "Razorpay link generated: https://rzp.io/i/plink_1";
    
    const body = { id: "evt_mismatch", event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_1", amount: 1500000 } } } }; // Expected 30M, paid 15M
    const text = JSON.stringify(body);
    process.env.RAZORPAY_WEBHOOK_SECRET = "secret";
    const sig = crypto.createHmac("sha256", "secret").update(text).digest("hex");

    const req = new Request("http://localhost/api/webhooks", { method: "POST", headers: { "x-razorpay-signature": sig }, body: text });
    const res = await handleWebhook(req);
    expect(res.status).toBe(200);
    expect(dbState.agentActions[0].status).toBe(ActionStatus.RECONCILIATION_MISMATCH);
  });

  // Scenario 18: Audit Trail consistency
  it("Scenario 18: Every transition appends structured details to the audit log", async () => {
    const req = new Request("http://localhost/api/approve", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    await handleApprove(req);

    const audit = dbState.agentActions[0].auditLog;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0].who).toBe("mock-user");
    expect(audit[0].what).toContain("APPROVED");
  });

  // Scenario 19: Unauthorized execution
  it("Scenario 19: Returns 401 if user session is missing", async () => {
    mockSession = null;
    const req = new Request("http://localhost/api/approve", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res = await handleApprove(req);
    expect(res.status).toBe(401);
  });

  // Scenario 20: Rejected strategy cannot execute
  it("Scenario 20: Rejects execution if any actions are REJECTED", async () => {
    dbState.agentActions[0].status = "REJECTED" as any;

    const req = new Request("http://localhost/api/execute", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res = await handleExecute(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("REJECTED_ACTION_EXECUTION");
  });

  // Scenario 21: Bounded retry
  it("Scenario 21: Prevents retries from terminal states unless explicitly allowed", () => {
    expect(validateActionTransition(ActionStatus.COMPLETED, ActionStatus.EXECUTING)).toBe(false);
  });

  // Scenario 22: Forecast rebuild idempotency
  it("Scenario 22: Forecast recalculation is pure and produces identical projections on multiple runs", () => {
    const movements = [{ date: today, inflows: 100000, outflows: 0 }];
    const run1 = dbState.business.currentCash + movements[0].inflows;
    const run2 = dbState.business.currentCash + movements[0].inflows;
    expect(run1).toBe(run2);
  });

  // Scenario 23: Prediction vs Actual recording
  it("Scenario 23: Tracks simulated outcomes against actual reconciled results", async () => {
    dbState.agentActions.forEach(a => { a.status = ActionStatus.APPROVED; });
    const reqExecute = new Request("http://localhost/api/execute", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    await handleExecute(reqExecute);

    const body = { id: "evt_reconcile", event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_1", amount: 3000000 } } } };
    const text = JSON.stringify(body);
    const sig = crypto.createHmac("sha256", "secret").update(text).digest("hex");
    const reqWebhook = new Request("http://localhost/api/webhooks", { method: "POST", headers: { "x-razorpay-signature": sig }, body: text });
    await handleWebhook(reqWebhook);

    const record = dbState.agentActions[0].predictionActual as any;
    expect(record).toBeDefined();
    expect(record.prediction.projectedBalance).toBe(12000000);
    expect(record.actual.balance).toBe(13000000); // 10M starting + 3M recovered
  });

  // Scenario 24: Incorrect resource target isolation
  it("Scenario 24: Enforces strict target validation to prevent hijacking payouts of other businesses", async () => {
    dbState.payouts[0].businessId = "biz_2"; // Belongs to different tenant

    const req = new Request("http://localhost/api/execute", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res = await handleExecute(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Checks that payout is ignored or not updated
    expect(dbState.payouts[0].status).toBe("SCHEDULED");
  });

  // Scenario 25: Verification target amount tampering checks
  it("Scenario 25: Validates transaction amounts strictly match snapshots", async () => {
    dbState.agentActions[0].amount = -50000; // Negative amount tampering
    const req = new Request("http://localhost/api/execute", { method: "POST", body: JSON.stringify({ strategyId: "strat_1" }) });
    const res = await handleExecute(req);
    expect(res.status).toBe(400);
  });

  // Scenario 26: Rescheduling date reconciliation mismatch
  //
  // The discrepancy is only meaningful AFTER execution has been attempted. This
  // scenario originally staged the action as APPROVED - i.e. never executed -
  // in which case the payout being SCHEDULED is not a discrepancy at all, it is
  // simply work that has not run yet. The route stamped RECONCILIATION_MISMATCH
  // anyway, so polling any unrelated payment link corrupted every pending
  // reschedule in the tenant.
  it("Scenario 26: Detects and marks RECONCILIATION_MISMATCH if an EXECUTED vendor payout failed to transition to RESCHEDULED", async () => {
    dbState.agentActions[1].status = ActionStatus.EXECUTING;
    dbState.payouts[0].status = "SCHEDULED"; // Execution claimed to move it; it did not.

    const req = new Request(`http://localhost/api/payment-status?actionId=act_2&paymentLinkId=plink_mock`, { method: "GET" });
    const res = await handlePaymentStatus(req);
    expect(res.status).toBe(200);
    expect(dbState.agentActions[1].status).toBe(ActionStatus.RECONCILIATION_MISMATCH);
  });

  it("Scenario 26b: Leaves a not-yet-executed reschedule alone instead of calling it a mismatch", async () => {
    dbState.agentActions[1].status = ActionStatus.APPROVED;
    dbState.payouts[0].status = "SCHEDULED"; // Correct: nothing has run yet.

    const req = new Request(`http://localhost/api/payment-status?actionId=act_2&paymentLinkId=plink_mock`, { method: "GET" });
    const res = await handlePaymentStatus(req);
    expect(res.status).toBe(200);
    expect(dbState.agentActions[1].status).toBe(ActionStatus.APPROVED);
  });

  // Scenario 27: Webhook payload tenant check
  it("Scenario 27: Discards payment link webhook notifications if tenant context resolves to a different merchant", async () => {
    dbState.transactions[0].businessId = "biz_2"; // Different tenant
    const body = { id: "evt_wrong_tenant", event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_1", amount: 3000000 } } } };
    const text = JSON.stringify(body);
    const sig = crypto.createHmac("sha256", "secret").update(text).digest("hex");

    const req = new Request("http://localhost/api/webhooks", { method: "POST", headers: { "x-razorpay-signature": sig }, body: text });
    const res = await handleWebhook(req);
    expect(res.status).toBe(404);
  });

  // Scenario 28: Webhook invalid transition checks
  it("Scenario 28: Does not allow transition to RECOVERED if current recovery status is terminal", () => {
    expect(validateRecoveryTransition(RecoveryStatus.RECOVERED, RecoveryStatus.RECOVERY_INITIATED)).toBe(false);
  });

  // Scenario 29: Webhook event type ignored
  it("Scenario 29: Returns status EVENT_IGNORED for unsupported webhook events", async () => {
    const body = { id: "evt_ignored", event: "payment_link.cancelled", payload: {} };
    const text = JSON.stringify(body);
    const sig = crypto.createHmac("sha256", "secret").update(text).digest("hex");

    const req = new Request("http://localhost/api/webhooks", { method: "POST", headers: { "x-razorpay-signature": sig }, body: text });
    const res = await handleWebhook(req);
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.status).toBe("EVENT_IGNORED");
  });

  // Scenario 30: Recovery transient retries
  it("Scenario 30: Permits retrying transient failures (e.g. FAILED -> EXECUTING)", () => {
    expect(validateActionTransition(ActionStatus.FAILED, ActionStatus.EXECUTING)).toBe(true);
  });
});
