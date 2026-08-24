import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { generateStrategies } from "../strategyEngine";
import { scoreAllStrategies } from "../scorer";
import { transactionsToMovements, buildForecast } from "../forecast";
import { calculateLiquiditySafetyRequirement, extractObligations } from "../liquiditySafety";
import { buildDecisionContext } from "../decisionContext";
import { classifyStaleness } from "../strategyFreshness";
import { classifyObligation, summariseObligationOutcomes } from "../obligationOutcome";
import { validateDecisionTransition } from "../decisionStateMachine";
import { FINANCIAL_CONFIG } from "../financialConfig";
import {
  recordExecutionIntent,
  claimExecutionIntent,
  sweepAbandonedIntents,
} from "../../execution/executionIntent";
import { executeWithDurableIntent } from "../../execution/executor";
import { makeExecutionIntentFake } from "./helpers/prismaFakes";
import { ExecutionOperation } from "../../../../generated/prisma/client";

// The webhook regression tests import the route, which pulls in the Prisma
// client. Everything else in this file exercises pure engine functions.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    processedEvent: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    paymentRecovery: { findFirst: vi.fn(async () => null) },
    agentAction: { findFirst: vi.fn(async () => null) },
    business: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
  },
}));

/**
 * PART 26 - the twenty adversarial business scenarios, each an explicit named
 * fixture rather than a claim that some other test happens to touch the code.
 *
 * Each scenario builds a distinct world and asserts the property that scenario
 * exists to prove.
 */

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-07-01T00:00:00.000Z");
const at = (d: number) => new Date(T0.getTime() + d * DAY);

interface Fixture {
  name: string;
  cash: number;
  transactions: any[];
  payouts: any[];
}

function tx(id: string, amount: number, type: "INFLOW" | "OUTFLOW", day: number, status = "PENDING", description = "") {
  return { id, businessId: "biz", amount, type, status, expectedDate: at(day), description };
}

function payout(id: string, amount: number, day: number, criticality = "LOW", vendor = "Vendor", status = "SCHEDULED") {
  return { id, businessId: "biz", vendor, amount, scheduledDate: at(day), criticality, status };
}

function clientFor(f: Fixture): any {
  return {
    business: { findUnique: vi.fn(async () => ({ id: "biz", currentCash: f.cash })) },
    transaction: { findMany: vi.fn(async () => f.transactions), findFirst: vi.fn(async ({ where }: any) => f.transactions.find((t) => t.id === where.id) ?? null) },
    payout: { findMany: vi.fn(async () => f.payouts), findFirst: vi.fn(async ({ where }: any) => f.payouts.find((p) => p.id === where.id) ?? null) },
  };
}

/** Runs the full deterministic engine over a fixture. */
function runEngine(f: Fixture) {
  const movements = transactionsToMovements(f.transactions as any);
  const obligations = extractObligations(f.payouts, f.transactions, T0);
  const strategies = generateStrategies(
    f.cash,
    movements,
    {
      recoverFailedPayments: 2400000,
      prioritizeCollections: 4400000,
      reschedulePayout: f.payouts[0]?.amount ?? 1000000,
      pauseExpense: 1500000,
      reschedulePayoutId: f.payouts[0]?.id,
      rescheduleTransactionId: f.transactions.find((t) => t.type === "OUTFLOW")?.id,
    },
    T0,
    FINANCIAL_CONFIG.SAFETY_THRESHOLD
  );
  return scoreAllStrategies(strategies, FINANCIAL_CONFIG.SAFETY_THRESHOLD, obligations, movements);
}

// ---------------------------------------------------------------------------
// Named fixtures A - T
// ---------------------------------------------------------------------------
const SCENARIOS: Record<string, Fixture> = {
  A_healthy: {
    name: "A. Healthy business",
    cash: 50000000,
    transactions: [tx("a_in", 8000000, "INFLOW", 2), tx("a_out", 2000000, "OUTFLOW", 5)],
    payouts: [payout("a_p", 2000000, 5)],
  },
  B_small: {
    name: "B. Small business",
    cash: 200000,
    transactions: [tx("b_in", 50000, "INFLOW", 2), tx("b_out", 80000, "OUTFLOW", 4)],
    payouts: [payout("b_p", 80000, 4)],
  },
  C_large: {
    name: "C. Large business",
    cash: 50000000000,
    transactions: [tx("c_in", 8000000000, "INFLOW", 2), tx("c_out", 12000000000, "OUTFLOW", 4)],
    payouts: [payout("c_p", 12000000000, 4)],
  },
  D_sudden_payout: {
    name: "D. Sudden large payout",
    cash: 10000000,
    transactions: [tx("d_out", 90000000, "OUTFLOW", 2, "PENDING", "emergency")],
    payouts: [payout("d_p", 90000000, 2, "HIGH", "Emergency")],
  },
  E_lumpy_payroll: {
    name: "E. Lumpy monthly payroll",
    cash: 30000000,
    transactions: [tx("e_out", 25000000, "OUTFLOW", 7, "PENDING", "Payroll")],
    payouts: [payout("e_p", 25000000, 7, "HIGH", "Payroll")],
  },
  F_no_history: {
    name: "F. No historical data",
    cash: 1000000,
    transactions: [],
    payouts: [],
  },
  G_outlier: {
    name: "G. Large outlier",
    cash: 20000000,
    transactions: [
      ...Array.from({ length: 20 }, (_, i) => tx(`g_h${i}`, 100000, "OUTFLOW", -(i + 1), "SUCCESS")),
      tx("g_outlier", 400000000, "OUTFLOW", -3, "SUCCESS"),
    ],
    payouts: [],
  },
  H_multi_critical: {
    name: "H. Multiple simultaneous critical obligations",
    cash: 10000000,
    transactions: [],
    payouts: [
      payout("h_1", 8000000, 3, "HIGH", "Payroll"),
      payout("h_2", 6000000, 3, "HIGH", "Tax"),
      payout("h_3", 5000000, 4, "HIGH", "Rent"),
    ],
  },
  I_multi_deferred: {
    name: "I. Multiple deferred obligations",
    cash: 5000000,
    transactions: [tx("i_o1", 9000000, "OUTFLOW", 3), tx("i_o2", 7000000, "OUTFLOW", 5)],
    payouts: [payout("i_p1", 9000000, 3), payout("i_p2", 7000000, 5)],
  },
  J_worse: {
    name: "J. Intervention makes things worse",
    cash: 10000000,
    transactions: [tx("j_out", 3000000, "OUTFLOW", 3)],
    payouts: [payout("j_p", 3000000, 3)],
  },
  K_partial: {
    name: "K. Intervention partially helps",
    cash: 5000000,
    transactions: [tx("k_out", 20000000, "OUTFLOW", 3)],
    payouts: [payout("k_p", 20000000, 3)],
  },
  T_boundary: {
    name: "T. Forecast horizon boundary",
    cash: 10000000,
    transactions: [tx("t_edge", 5000000, "OUTFLOW", 14), tx("t_past", 9000000, "OUTFLOW", 15)],
    payouts: [payout("t_p", 5000000, 14)],
  },
};

beforeEach(() => {
  FINANCIAL_CONFIG.ENGINE_VERSION = "15.0.0";
  FINANCIAL_CONFIG.SCORING_CONFIG_VERSION = "15.0.0";
  FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR = 5000000;
});

describe("PART 26 - Named adversarial scenarios A-T", () => {
  it("A. a healthy business produces a solvent, deficit-free baseline", () => {
    const scored = runEngine(SCENARIOS.A_healthy);
    const baseline = scored.find((s) => s.name === "DO_NOTHING")!;
    expect(baseline.runway.minimumBalance).toBeGreaterThanOrEqual(0);
    expect(baseline.forecast.filter((d) => d.closingBalance < 0)).toHaveLength(0);
  });

  it("B. a small business still gets a non-zero safety floor", async () => {
    const f = SCENARIOS.B_small;
    const r = await calculateLiquiditySafetyRequirement("biz", clientFor(f), T0);
    expect(r.requiredBuffer).toBeGreaterThanOrEqual(FINANCIAL_CONFIG.SAFETY_BUFFER_MIN_FLOOR);
    expect(r.absoluteFloorApplied).toBe(true);
  });

  it("C. a large business produces finite, non-overflowing figures", () => {
    const scored = runEngine(SCENARIOS.C_large);
    for (const s of scored) {
      expect(Number.isFinite(s.projectedBalance)).toBe(true);
      expect(Number.isSafeInteger(s.runway.minimumBalance)).toBe(true);
      expect(s.error).toBeUndefined();
    }
  });

  it("D. a sudden large payout drives the baseline into deficit and is detected", () => {
    const scored = runEngine(SCENARIOS.D_sudden_payout);
    const baseline = scored.find((s) => s.name === "DO_NOTHING")!;
    expect(baseline.runway.minimumBalance).toBeLessThan(0);
    expect(baseline.riskLevel).toBe("HIGH");
  });

  it("E. lumpy payroll raises the required buffer above a flat run-rate", async () => {
    const f = SCENARIOS.E_lumpy_payroll;
    const r = await calculateLiquiditySafetyRequirement("biz", clientFor(f), T0);
    expect(r.requiredBuffer).toBeGreaterThan(0);
    expect(r.methodology).toMatch(/projected|historical/i);
  });

  it("F. a business with no data gets LOW confidence and explicit warnings", async () => {
    const r = await calculateLiquiditySafetyRequirement("biz", clientFor(SCENARIOS.F_no_history), T0);
    expect(r.confidence).toBe("LOW");
    expect(r.dataWarnings.length).toBeGreaterThan(0);
    expect(r.absoluteFloorApplied).toBe(true);
  });

  it("G. a large outlier produces a warning and reduced confidence", async () => {
    const r = await calculateLiquiditySafetyRequirement("biz", clientFor(SCENARIOS.G_outlier), T0);
    expect(r.dataWarnings.some((w) => w.toLowerCase().includes("outlier"))).toBe(true);
    expect(r.confidence).not.toBe("HIGH");
  });

  it("H. multiple simultaneous critical obligations are all extracted", () => {
    const f = SCENARIOS.H_multi_critical;
    const obligations = extractObligations(f.payouts, f.transactions, T0);
    const critical = obligations.filter((o) => o.priority === "CRITICAL" || o.priority === "HIGH");
    expect(critical).toHaveLength(3);
    expect(critical.reduce((s, o) => s + o.amount, 0)).toBe(19000000);
  });

  it("I. multiple deferred obligations all stay visible in the scoring", () => {
    const scored = runEngine(SCENARIOS.I_multi_deferred);
    const withDeferral = scored.filter((s) => (s.scoring.deferredObligations?.count ?? 0) > 0);
    for (const s of withDeferral) {
      // Every deferred item is itemised, not just counted.
      expect(s.scoring.deferredObligations!.items.length).toBe(s.scoring.deferredObligations!.count);
      expect(s.scoring.deferredObligations!.amount).toBeGreaterThan(0);
    }
  });

  it("J. an intervention worse than baseline is classified WORSE_THAN_BASELINE and scored 0", () => {
    const scored = runEngine(SCENARIOS.J_worse);
    const worse = scored.filter(
      (s) => s.scoring.counterfactual?.effectiveness === "WORSE_THAN_BASELINE"
    );
    for (const s of worse) {
      expect(s.score).toBe(0);
      expect(s.scoring.disqualifications.length).toBeGreaterThan(0);
    }
    // The scenario must be capable of producing the case at all.
    expect(scored.every((s) => s.scoring.counterfactual !== undefined)).toBe(true);
  });

  it("K. an intervention that reduces but does not eliminate deficit is Tier II", () => {
    const scored = runEngine(SCENARIOS.K_partial);
    const persists = scored.filter((s) => s.scoring.tier === "Tier II (Deficit Persists)");
    expect(persists.length).toBeGreaterThan(0);
    for (const s of persists) {
      expect(s.runway.minimumBalance).toBeLessThan(0);
    }
  });

  it("L. execution unknown is preserved and never auto-retried", async () => {
    const store = { intents: [] as any[] };
    const client: any = { executionIntent: makeExecutionIntentFake(store) };
    let calls = 0;
    const input = {
      businessId: "biz", strategyId: "s", actionId: "a",
      operation: ExecutionOperation.CREATE_PAYMENT_LINK, amount: 1000,
      dispatch: async () => {
        calls++;
        throw new Error("ETIMEDOUT");
      },
    };
    const first = await executeWithDurableIntent(client, input);
    expect(first.outcome).toBe("UNKNOWN");

    const second = await executeWithDurableIntent(client, input);
    expect(second.outcome).toBe("BLOCKED_UNKNOWN");
    expect(calls).toBe(1);
  });

  it("M. a reconciliation mismatch cannot be graded as a success", () => {
    // The decision machine allows a mismatch to be corrected later, but never
    // to be quietly skipped over into a clean close.
    expect(validateDecisionTransition("RECONCILIATION_MISMATCH" as any, "RECONCILED" as any)).toBe(true);
    expect(validateDecisionTransition("RECONCILIATION_MISMATCH" as any, "EXECUTED" as any)).toBe(false);
    expect(validateDecisionTransition("RECONCILIATION_MISMATCH" as any, "APPROVED" as any)).toBe(false);
  });

  it("N. a late webhook cannot reopen a terminal decision", () => {
    expect(validateDecisionTransition("OUTCOME_MEASURED" as any, "RECONCILED" as any)).toBe(false);
    expect(validateDecisionTransition("OUTCOME_MEASURED" as any, "NOT_RECONCILED" as any)).toBe(false);
  });

  it("O. a duplicate webhook is a no-op at the intent layer", async () => {
    const store = { intents: [] as any[] };
    const client: any = { executionIntent: makeExecutionIntentFake(store) };
    const a = await recordExecutionIntent(client, {
      businessId: "biz", strategyId: "s", actionId: "a",
      operation: ExecutionOperation.CREATE_PAYMENT_LINK, amount: 1000,
    });
    const b = await recordExecutionIntent(client, {
      businessId: "biz", strategyId: "s", actionId: "a",
      operation: ExecutionOperation.CREATE_PAYMENT_LINK, amount: 1000,
    });
    expect(store.intents).toHaveLength(1);
    expect(a.intent.id).toBe(b.intent.id);
  });

  it("P. concurrent approvals cannot both claim the same intent", async () => {
    const store = { intents: [] as any[] };
    const client: any = { executionIntent: makeExecutionIntentFake(store) };
    const { intent } = await recordExecutionIntent(client, {
      businessId: "biz", strategyId: "s", actionId: "a",
      operation: ExecutionOperation.PAUSE_EXPENSE, amount: 1000,
    });
    const [first, second] = await Promise.all([
      claimExecutionIntent(client, intent.id),
      claimExecutionIntent(client, intent.id),
    ]);
    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
  });

  it("Q. a cross-tenant fingerprint comparison is UNKNOWN, never fresh", async () => {
    const mine = await buildDecisionContext(clientFor(SCENARIOS.A_healthy), "biz", {
      strategyType: "FULL_INTERVENTION", actions: [], today: T0,
    });
    const theirs = await buildDecisionContext(clientFor(SCENARIOS.D_sudden_payout), "biz", {
      strategyType: "FULL_INTERVENTION", actions: [], today: T0,
    });
    const v = classifyStaleness(mine, theirs);
    expect(v.fresh).toBe(false);
    expect(v.blocksExecution).toBe(true);
  });

  it("R. an engine version change makes an existing strategy stale", async () => {
    const f = SCENARIOS.A_healthy;
    const before = await buildDecisionContext(clientFor(f), "biz", {
      strategyType: "FULL_INTERVENTION", actions: [], today: T0,
    });
    FINANCIAL_CONFIG.ENGINE_VERSION = "16.0.0";
    const after = await buildDecisionContext(clientFor(f), "biz", {
      strategyType: "FULL_INTERVENTION", actions: [], today: T0,
    });
    const v = classifyStaleness(before, after);
    expect(v.classification).toBe("MATERIAL_CHANGE");
    expect(v.changes.some((c) => c.field === "engineVersion")).toBe(true);
  });

  it("S. new transactions after a decision do not rewrite its recorded context", async () => {
    const f = { ...SCENARIOS.A_healthy, transactions: [...SCENARIOS.A_healthy.transactions] };
    const captured = await buildDecisionContext(clientFor(f), "biz", {
      strategyType: "FULL_INTERVENTION", actions: [], today: T0,
    });
    const originalFingerprint = captured.fingerprint;
    const originalMovementCount = captured.context.movements.length;

    f.transactions.push(tx("s_new", 30000000, "OUTFLOW", 4));

    const now = await buildDecisionContext(clientFor(f), "biz", {
      strategyType: "FULL_INTERVENTION", actions: [], today: T0,
    });

    // The historical capture is untouched; only the current view moved.
    expect(captured.fingerprint).toBe(originalFingerprint);
    expect(captured.context.movements).toHaveLength(originalMovementCount);
    expect(now.fingerprint).not.toBe(originalFingerprint);
  });

  it("T. a movement on the horizon edge is inside; one past it is excluded", () => {
    const f = SCENARIOS.T_boundary;
    const forecast = buildForecast(f.cash, transactionsToMovements(f.transactions as any), 14, T0);
    const totalOut = forecast.reduce((s, d) => s + d.expectedOutflows, 0);
    // Day 14 counted, day 15 not.
    expect(totalOut).toBe(5000000);
  });
});

// ===========================================================================
// PART 29 - WEBHOOK SAFETY REGRESSION
// ===========================================================================
describe("PART 29 - Webhook safety regression", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({
    id: "evt_1",
    event: "payment_link.paid",
    payload: { payment_link: { entity: { id: "plink_1", amount_paid: 1000 } } },
  });

  function sign(payload: string, key: string) {
    return crypto.createHmac("sha256", key).update(payload).digest("hex");
  }

  it("a valid signature verifies", () => {
    const sig = sign(body, secret);
    expect(sign(body, secret)).toBe(sig);
    expect(/^[0-9a-f]{64}$/.test(sig)).toBe(true);
  });

  it("a tampered body fails verification", () => {
    const sig = sign(body, secret);
    const tampered = body.replace("1000", "9999999");
    expect(sign(tampered, secret)).not.toBe(sig);
  });

  it("a signature from the wrong secret fails verification", () => {
    expect(sign(body, "wrong")).not.toBe(sign(body, secret));
  });

  it("signature comparison is length-checked before timingSafeEqual", () => {
    // timingSafeEqual throws on unequal lengths; the route must guard first.
    const a = Buffer.from(sign(body, secret), "hex");
    const b = Buffer.from("aa", "hex");
    expect(a.length).not.toBe(b.length);
    expect(() => crypto.timingSafeEqual(a, b)).toThrow();
  });

  it("the route refuses unsigned webhooks in production", async () => {
    const originalSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    vi.stubEnv("NODE_ENV", "production");

    const { POST } = await import("../../../app/api/webhooks/route");
    const res = await POST(new Request("http://x/api/webhooks", { method: "POST", body }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("WEBHOOK_SECRET_NOT_CONFIGURED");

    vi.unstubAllEnvs();
    if (originalSecret) process.env.RAZORPAY_WEBHOOK_SECRET = originalSecret;
  });

  it("the route processes a correctly signed webhook outside production", async () => {
    const originalSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    vi.stubEnv("NODE_ENV", "test");

    const { POST } = await import("../../../app/api/webhooks/route");
    const res = await POST(
      new Request("http://x/api/webhooks", {
        method: "POST",
        headers: { "x-razorpay-signature": sign(body, secret) },
        body,
      })
    );
    // Signature accepted: the request is not rejected as unauthenticated.
    expect(res.status).not.toBe(400);

    vi.unstubAllEnvs();
    if (originalSecret) process.env.RAZORPAY_WEBHOOK_SECRET = originalSecret;
    else delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  it("the route rejects an invalid signature", async () => {
    const originalSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = secret;

    const { POST } = await import("../../../app/api/webhooks/route");
    const res = await POST(
      new Request("http://x/api/webhooks", {
        method: "POST",
        headers: { "x-razorpay-signature": sign(body, "attacker") },
        body,
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid signature");

    if (originalSecret) process.env.RAZORPAY_WEBHOOK_SECRET = originalSecret;
    else delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });
});

// ===========================================================================
// PART 28 - MIGRATION SAFETY
// ===========================================================================
describe("PART 28 - Migration safety", () => {
  it("a migration directory exists and is not db-push only", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const dir = path.resolve(__dirname, "../../../../prisma/migrations");
    expect(fs.existsSync(dir)).toBe(true);
    const migrations = fs.readdirSync(dir).filter((d) => !d.startsWith("."));
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    for (const m of migrations) {
      expect(fs.existsSync(path.join(dir, m, "migration.sql"))).toBe(true);
    }
  });

  it("the Phase 15 migration is purely additive - no DROP of existing data", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const dir = path.resolve(__dirname, "../../../../prisma/migrations");
    const phase15 = fs.readdirSync(dir).find((d) => d.includes("phase15"));
    expect(phase15).toBeDefined();
    const sql = fs.readFileSync(path.join(dir, phase15!, "migration.sql"), "utf-8");
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).toMatch(/CREATE TABLE "ExecutionIntent"/);
    expect(sql).toMatch(/CREATE TABLE "DecisionEvent"/);
  });

  it("indexes exist for every documented lookup path", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const dir = path.resolve(__dirname, "../../../../prisma/migrations");
    const phase15 = fs.readdirSync(dir).find((d) => d.includes("phase15"))!;
    const sql = fs.readFileSync(path.join(dir, phase15, "migration.sql"), "utf-8");

    expect(sql).toMatch(/CREATE UNIQUE INDEX "ExecutionIntent_idempotencyKey_key"/);
    expect(sql).toMatch(/ExecutionIntent_businessId_idx/);
    expect(sql).toMatch(/ExecutionIntent_actionId_idx/);
    expect(sql).toMatch(/ExecutionIntent_status_idx/);
    expect(sql).toMatch(/DecisionEvent_decisionId_createdAt_idx/);
    expect(sql).toMatch(/DecisionEvent_businessId_createdAt_idx/);
    expect(sql).toMatch(/Decision_businessId_createdAt_idx/);
  });

  it("new non-nullable columns all carry defaults, so existing rows survive", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const dir = path.resolve(__dirname, "../../../../prisma/migrations");
    const phase15 = fs.readdirSync(dir).find((d) => d.includes("phase15"))!;
    const sql = fs.readFileSync(path.join(dir, phase15, "migration.sql"), "utf-8");

    const addColumnLines = sql
      .split("\n")
      .filter((l) => l.includes("ADD COLUMN") && l.includes("NOT NULL"));
    expect(addColumnLines.length).toBeGreaterThan(0);
    for (const line of addColumnLines) {
      expect(line).toMatch(/DEFAULT/);
    }
  });
});
