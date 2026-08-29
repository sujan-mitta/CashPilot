import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateStrategies } from "../strategyEngine";
import { scoreAllStrategies } from "../scorer";
import { POST as handleApprove } from "../../../app/api/approve/route";
import { seedFreshDecision } from "./helpers/prismaFakes";
import { POST as handleExecute } from "../../../app/api/execute/route";
import { POST as handleWebhook } from "../../../app/api/webhooks/route";
import { prisma } from "../../../lib/prisma";
import crypto from "crypto";
import { addDays } from "date-fns";

const today = new Date(Date.UTC(2026, 7, 22));

let dbState = {
  business: { id: "biz_1", name: "Acme Corp", currentCash: 4000000 }, // ₹40k in paise
  transactions: [
    { id: "tx_failed", businessId: "biz_1", amount: 3000000, type: "INFLOW" as const, status: "FAILED" as const, expectedDate: today, description: "Failed Customer Invoice" },
    { id: "tx_payout", businessId: "biz_1", amount: 5000000, type: "OUTFLOW" as const, status: "PENDING" as const, expectedDate: addDays(today, 3), description: "Packaging Co Payout" },
  ],
  invoices: [
    { id: "inv_overdue", businessId: "biz_1", customerName: "Client A", amount: 2000000, dueDate: today, status: "OVERDUE" as const, priority: "MEDIUM" as const },
  ],
  payouts: [
    { id: "payout_1", vendor: "Packaging Co", amount: 5000000, scheduledDate: addDays(today, 3), criticality: "LOW" as const, status: "SCHEDULED" as const, businessId: "biz_1" },
  ],
  paymentRecoveries: [
    { id: "rec_1", transactionId: "tx_failed", status: "RECOVERY_CANDIDATE" as any, amount: 3000000, paymentLinkId: null as string | null, shortUrl: null as string | null, updatedAt: today },
  ],
  strategies: [] as any[],
  agentActions: [] as any[],
  processedEvents: [] as any[],
};

const stores = vi.hoisted(() => ({
  intents: [] as any[],
  decisions: [] as any[],
  events: [] as any[],
}));

vi.mock("@/lib/prisma", async () => {
  const { makeExecutionIntentFake, makeDecisionFakes } = await import("./helpers/prismaFakes");
  const executionIntentFake = makeExecutionIntentFake(stores as any);
  const decisionFakes = makeDecisionFakes(stores as any);
  return {
    prisma: {
      executionIntent: executionIntentFake,
      decision: decisionFakes.decision,
      decisionEvent: decisionFakes.decisionEvent,
      business: {
        findUnique: vi.fn(async () => dbState.business),
        findFirst: vi.fn(async () => dbState.business),
        update: vi.fn(async ({ data }) => {
          if (data.currentCash && data.currentCash.increment) {
            dbState.business.currentCash += data.currentCash.increment;
          }
          return dbState.business;
        }),
      },
      transaction: {
        findMany: vi.fn(async () => dbState.transactions),
        findFirst: vi.fn(async () => dbState.transactions[0]),
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
        findFirst: vi.fn(async () => dbState.invoices[0]),
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
        findFirst: vi.fn(async () => dbState.payouts[0]),
        update: vi.fn(async ({ where, data }) => {
          const p = dbState.payouts.find(x => x.id === where.id);
          if (p) {
            Object.assign(p, data);
            return p;
          }
        }),
      },
      paymentRecovery: {
        findFirst: vi.fn(async () => {
          const r = dbState.paymentRecoveries[0];
          if (r) {
            return {
              ...r,
              transaction: dbState.transactions.find((t) => t.id === r.transactionId),
            };
          }
          return null;
        }),
        findUnique: vi.fn(async () => {
          const r = dbState.paymentRecoveries[0];
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
        findFirst: vi.fn(async () => {
          const s = dbState.strategies[0];
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
        findMany: vi.fn(async () => dbState.agentActions),
        findFirst: vi.fn(async () => {
          const action = dbState.agentActions[0];
          if (action) {
            return {
              ...action,
              strategy: dbState.strategies.find((s) => s.id === action.strategyId),
            };
          }
          return null;
        }),
        findUnique: vi.fn(async ({ where }) => dbState.agentActions.find(a => a.id === where.id)),
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
            if (a.strategyId === where.strategyId || a.id === where.id) {
              Object.assign(a, data);
              count++;
            }
          });
          return { count };
        }),
      },
      processedEvent: {
        findUnique: vi.fn(async () => null),
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
    getSession: vi.fn(() => Promise.resolve({ userId: "mock-user-id", name: "Mock User", email: "mock@company.com", businessId: "biz_1", businessName: "Mock Business" })),
  };
});

vi.mock("@/lib/razorpay/client", () => {
  return {
    createRecoveryPaymentLink: vi.fn(async () => {
      return {
        id: "plink_mock",
        short_url: "https://rzp.io/i/mockurl",
      };
    }),
  };
});

vi.mock("@/lib/ai/agents", () => {
  return {
    runAgent: vi.fn(() => Promise.resolve("Mocked narrative description")),
  };
});

describe("Safe Intervention Approval, Execution & Reconciliation (Phase 10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState = {
      business: { id: "biz_1", name: "Acme Corp", currentCash: 4000000 },
      transactions: [
        { id: "tx_failed", businessId: "biz_1", amount: 3000000, type: "INFLOW" as const, status: "FAILED" as const, expectedDate: today, description: "Failed Customer Invoice" },
        { id: "tx_payout", businessId: "biz_1", amount: 5000000, type: "OUTFLOW" as const, status: "PENDING" as const, expectedDate: addDays(today, 3), description: "Packaging Co Payout" },
      ],
      invoices: [
        { id: "inv_overdue", businessId: "biz_1", customerName: "Client A", amount: 2000000, dueDate: today, status: "OVERDUE" as const, priority: "MEDIUM" as const },
      ],
      payouts: [
        { id: "payout_1", vendor: "Packaging Co", amount: 5000000, scheduledDate: addDays(today, 3), criticality: "LOW" as const, status: "SCHEDULED" as const, businessId: "biz_1" },
      ],
      paymentRecoveries: [
        { id: "rec_1", transactionId: "tx_failed", status: "RECOVERY_CANDIDATE" as any, amount: 3000000, paymentLinkId: null as string | null, shortUrl: null as string | null, updatedAt: today },
      ],
      strategies: [] as any[],
      agentActions: [] as any[],
      processedEvents: [] as any[],
    };
  });

  it("Test: End-to-end approval, execution, Razorpay settlement, and ledger reconciliation", async () => {
    // 1. DETECT, INVESTIGATE & SIMULATE
    const baseMovements = [
      { date: today, inflows: 0, outflows: 0 },
      { date: addDays(today, 3), inflows: 0, outflows: 5000000, transactionId: "tx_payout", description: "Packaging Co Payout" },
    ];

    const library = {
      recoverFailedPayments: 3000000,
      recoverFailedPaymentsId: "tx_failed",
      prioritizeCollections: 2000000,
      reschedulePayout: 5000000,
      rescheduleTransactionId: "tx_payout",
      reschedulePayoutId: "payout_1",
      rescheduleDelayDays: 15,
      pauseExpense: 0,
    };

    const strategies = generateStrategies(4000000, baseMovements, library, today, 25000000);
    const scored = scoreAllStrategies(strategies, 25000000, [], baseMovements);

    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.counterfactual?.effectiveness).toBe("DEFICIT_ELIMINATED_WITH_DEFERRED_OBLIGATION");
    expect(full.scoring.deferredObligations?.count).toBe(1);

    // Populate fake strategy and agent action tables
    dbState.strategies.push({
      id: "strategy-1",
      name: "FULL_INTERVENTION",
      projectedBalance: full.projectedBalance,
      startingCash: dbState.business.currentCash,
      riskLevel: full.riskLevel,
      score: full.score,
      recommended: full.recommended,
      createdAt: today,
    });

    dbState.agentActions = [
      { id: "act-1", strategyId: "strategy-1", actionType: "RECOVER_FAILED_PAYMENTS" as const, amount: 3000000, status: "PENDING" as const },
      { id: "act-2", strategyId: "strategy-1", actionType: "PRIORITIZE_COLLECTIONS" as const, amount: 2000000, status: "PENDING" as const },
      { id: "act-3", strategyId: "strategy-1", actionType: "RESCHEDULE_PAYOUT" as const, amount: 5000000, status: "PENDING" as const, targetPayoutId: "payout_1", targetTransactionId: "tx_payout" },
    ];

    // Approval runs a server-side freshness gate, so the strategy needs a
    // decision fingerprinted against the world it will be checked in.
    stores.decisions.length = 0;
    stores.events.length = 0;
    stores.intents.length = 0;
    await seedFreshDecision(prisma, stores as any, {
      businessId: dbState.business.id,
      strategyId: "strategy-1",
      strategyType: "FULL_INTERVENTION",
      actions: [
        { type: "RECOVER_FAILED_PAYMENTS", amount: 3000000 },
        { type: "PRIORITIZE_COLLECTIONS", amount: 2000000 },
        { type: "RESCHEDULE_PAYOUT", amount: 5000000, targetPayoutId: "payout_1", targetTransactionId: "tx_payout" },
      ],
      status: "PRESENTED",
    });

    // 2. HUMAN APPROVAL
    const reqApprove = new Request("http://localhost/api/approve", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    });

    const resApprove = await handleApprove(reqApprove);
    expect(resApprove.status).toBe(200);
    const bodyApprove = await resApprove.json();
    expect(bodyApprove.status).toBe("APPROVED");
    expect(dbState.agentActions.every(a => a.status === "APPROVED")).toBe(true);

    // 3. EXECUTION REQUEST
    const reqExecute = new Request("http://localhost/api/execute", {
      method: "POST",
      body: JSON.stringify({ strategyId: "strategy-1" }),
    });

    const resExecute = await handleExecute(reqExecute);
    expect(resExecute.status).toBe(200);
    const bodyExecute = await resExecute.json();
    expect(bodyExecute.steps.length).toBe(3);

    // Verify rescheduling was applied to the database state
    expect(dbState.payouts[0].status).toBe("RESCHEDULED");
    const diffMs = dbState.payouts[0].scheduledDate.getTime() - new Date().getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(20);

    // 4. RAZORPAY WEBHOOK RECEIPT & RECONCILIATION
    // Set paymentLinkId for recovery
    dbState.paymentRecoveries[0].paymentLinkId = "plink_mock";
    dbState.paymentRecoveries[0].status = "PAYMENT_PENDING";

    const webhookBody = {
      id: "evt_webhook_paid",
      event: "payment_link.paid",
      payload: {
        payment_link: {
          entity: {
            id: "plink_mock",
          },
        },
      },
    };

    const mockText = JSON.stringify(webhookBody);
    process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret";
    const expectedSig = crypto
      .createHmac("sha256", "test_webhook_secret")
      .update(mockText)
      .digest("hex");

    const reqWebhook = new Request("http://localhost/api/webhooks", {
      method: "POST",
      headers: {
        "x-razorpay-signature": expectedSig,
      },
      body: mockText,
    });

    const resWebhook = await handleWebhook(reqWebhook);
    expect(resWebhook.status).toBe(200);
    const bodyWebhook = await resWebhook.json();
    expect(bodyWebhook.status).toBe("paid");

    // Verify cash reconciliation has occurred
    expect(dbState.business.currentCash).toBe(7000000); // 4M original + 3M recovered
    expect(dbState.paymentRecoveries[0].status).toBe("RECOVERED");
  });
});
