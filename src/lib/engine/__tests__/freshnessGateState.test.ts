import { describe, it, expect, vi } from "vitest";
import { checkStrategyFreshness } from "../freshnessGate";
import { computeFinancialState, type FinancialStateInputs } from "@/lib/state/financialState";
import { buildDecisionContext } from "../decisionContext";
import type { Prisma } from "../../../../generated/prisma/client";

/**
 * Phase 7 integration: the financial-state half of the freshness gate.
 *
 * The property these tests exist to protect is that adding the state check can
 * only ever TIGHTEN the gate. The first block proves the existing money path is
 * untouched for every decision that predates state tracking; the rest prove the
 * new check actually fires when it should.
 */

const BUSINESS = "biz_1";
const TODAY = new Date("2026-09-01T00:00:00Z");

function snapshot(overrides: Partial<FinancialStateInputs> = {}) {
  return computeFinancialState({
    currentCash: 1000000_00,
    requiredBuffer: 700000_00,
    today: TODAY,
    transactions: [],
    invoices: [],
    payouts: [],
    ...overrides,
  });
}

/** A stored FinancialState row, as the gate reads it back. */
function stateRow(stateVersion: number, overrides: Partial<FinancialStateInputs> = {}) {
  const s = snapshot(overrides);
  return {
    id: `fs_${stateVersion}`,
    businessId: BUSINESS,
    stateVersion,
    stateHash: s.stateHash,
    asOf: new Date(s.asOf),
    cashPosition: s.cashPosition,
    receivables: s.receivables,
    payables: s.payables,
    expectedInflows: s.expectedInflows,
    expectedOutflows: s.expectedOutflows,
    activeCommitments: s.activeCommitments,
    requiredBuffer: s.requiredBuffer,
    projectedMinimumBalance: s.projectedMinimumBalance,
    riskState: s.riskState,
    reconciliation: s.reconciliation,
    detail: { components: s.components, horizonDays: s.horizonDays },
    evidenceRefs: s.evidenceRefs,
    createdAt: new Date(),
  };
}

const BUSINESS_ROW = { id: BUSINESS, name: "Acme", currentCash: 1000000_00 };

/**
 * A client that returns a decision whose fingerprint matches the CURRENT
 * context, so the fingerprint half is always NO_CHANGE and any block observed
 * in these tests can only have come from the state half.
 */
async function makeClient(opts: {
  financialStateVersion: number | null;
  states?: ReturnType<typeof stateRow>[];
  omitStateTable?: boolean;
}) {
  const base = {
    business: { findUnique: vi.fn(async () => BUSINESS_ROW) },
    transaction: { findMany: vi.fn(async () => []) },
    payout: { findMany: vi.fn(async () => []) },
    invoice: { findMany: vi.fn(async () => []) },
  };

  // Build the fingerprint the decision will claim using EXACTLY the call the
  // gate makes - including letting the buffer be derived rather than supplied -
  // so the fingerprint half reports NO_CHANGE and any block observed below can
  // only have come from the state half.
  const detail = await buildDecisionContext(base as unknown as Prisma.TransactionClient, BUSINESS, {
    strategyType: "RECOVER_ONLY",
    actions: [],
    today: TODAY,
  });

  const states = opts.states ?? [];
  const financialState = {
    findFirst: vi.fn(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: Record<string, unknown> }) => {
      const hits = states.filter((s) =>
        Object.entries(where).every(([k, v]) => (s as Record<string, unknown>)[k] === v)
      );
      if (orderBy?.stateVersion === "desc") {
        hits.sort((a, b) => b.stateVersion - a.stateVersion);
      }
      return hits[0] ?? null;
    }),
  };

  const client = {
    ...base,
    decision: {
      findFirst: vi.fn(async () => ({
        id: "dec_1",
        businessId: BUSINESS,
        strategyId: "strat_1",
        fingerprintDetail: detail,
        financialStateVersion: opts.financialStateVersion,
      })),
    },
    ...(opts.omitStateTable ? {} : { financialState }),
  };

  return { client: client as unknown as Prisma.TransactionClient, financialState };
}

const params = {
  businessId: BUSINESS,
  strategyId: "strat_1",
  strategyType: "RECOVER_ONLY",
  actions: [],
  today: TODAY,
};

describe("the existing path is untouched (decisions with no recorded state)", () => {
  it("reports NOT_TRACKED and does not block", async () => {
    const { client } = await makeClient({ financialStateVersion: null });
    const result = await checkStrategyFreshness(client, params);

    expect(result.stateVerdict.classification).toBe("NOT_TRACKED");
    expect(result.blocked).toBe(false);
    expect(result.verdict.classification).toBe("NO_CHANGE");
  });

  it("issues no financial-state query at all", async () => {
    // Not merely harmless - it costs nothing on the hot path.
    const { client, financialState } = await makeClient({
      financialStateVersion: null,
      states: [stateRow(1)],
    });
    await checkStrategyFreshness(client, params);
    expect(financialState.findFirst).not.toHaveBeenCalled();
  });

  it("does not block even when states exist and have moved materially", async () => {
    const { client } = await makeClient({
      financialStateVersion: null,
      states: [stateRow(1), stateRow(2, { currentCash: 1 })],
    });
    const result = await checkStrategyFreshness(client, params);
    expect(result.blocked).toBe(false);
  });
});

describe("the state check fires once a decision records a state", () => {
  it("passes when the state has not changed", async () => {
    const { client } = await makeClient({
      financialStateVersion: 1,
      states: [stateRow(1)],
    });
    const result = await checkStrategyFreshness(client, params);

    expect(result.stateVerdict.classification).toBe("NO_CHANGE");
    expect(result.blocked).toBe(false);
  });

  it("blocks on a material state move even though the fingerprint is clean", async () => {
    // The fingerprint half sees NO_CHANGE here; the block can only come from
    // the state half. This is the new protection Phase 7 adds.
    const { client } = await makeClient({
      financialStateVersion: 1,
      states: [stateRow(1), stateRow(2, { currentCash: 100_00 })],
    });
    const result = await checkStrategyFreshness(client, params);

    expect(result.stateVerdict.classification).toBe("MATERIAL_CHANGE");
    expect(result.verdict.classification).toBe("MATERIAL_CHANGE");
    expect(result.blocked).toBe(true);
  });

  it("does not block on an immaterial state move", async () => {
    const { client } = await makeClient({
      financialStateVersion: 1,
      states: [stateRow(1), stateRow(2, { currentCash: 1000000_00 + 100 })],
    });
    const result = await checkStrategyFreshness(client, params);

    expect(result.stateVerdict.classification).toBe("MINOR_CHANGE");
    expect(result.blocked).toBe(false);
  });

  it("blocks when the recorded state version is no longer on record", async () => {
    const { client } = await makeClient({
      financialStateVersion: 7,
      states: [stateRow(1)],
    });
    const result = await checkStrategyFreshness(client, params);

    expect(result.stateVerdict.classification).toBe("UNKNOWN");
    expect(result.blocked).toBe(true);
    expect(result.stateVerdict.changes[0].reason).toMatch(/no longer on record/);
  });

  it("blocks rather than throwing when the state table is unavailable", async () => {
    const { client } = await makeClient({ financialStateVersion: 1, omitStateTable: true });
    const result = await checkStrategyFreshness(client, params);

    expect(result.stateVerdict.classification).toBe("UNKNOWN");
    expect(result.blocked).toBe(true);
  });

  it("scopes both state lookups to the tenant (spec §47)", async () => {
    const { client, financialState } = await makeClient({
      financialStateVersion: 1,
      states: [stateRow(1)],
    });
    await checkStrategyFreshness(client, params);

    expect(financialState.findFirst).toHaveBeenCalledTimes(2);
    for (const call of financialState.findFirst.mock.calls) {
      expect(call[0].where.businessId).toBe(BUSINESS);
    }
  });

  it("reports both version numbers for the audit trail", async () => {
    const { client } = await makeClient({
      financialStateVersion: 1,
      states: [stateRow(1), stateRow(4, { currentCash: 1 })],
    });
    const result = await checkStrategyFreshness(client, params);

    expect(result.stateVerdict.fromVersion).toBe(1);
    expect(result.stateVerdict.toVersion).toBe(4);
  });
});
