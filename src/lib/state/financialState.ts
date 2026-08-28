import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import { extractObligations } from "@/lib/engine/liquiditySafety";
import { buildForecast, transactionsToMovements, calculateRunway } from "@/lib/engine/forecast";
import { sha256, stableStringify } from "@/lib/engine/strategyFreshness";
import type { PayoutRecord, TransactionRecord } from "@/lib/db/records";

/**
 * Phase 6 - the Unified Financial State, computed from canonical rows
 * (spec §18).
 *
 * The single most important property of this module is what it does NOT do: it
 * does not define what an obligation is, what counts as a movement, or how a
 * forecast is built. Every one of those already has exactly one definition in
 * the engine, and this file CALLS those definitions rather than restating them.
 *
 * That is spec §3 in practice. A state that computed its own payables would be
 * a second opinion about financial reality, and the moment it drifted from
 * `extractObligations` the product would hold two contradictory beliefs with no
 * way to tell which was right. Aggregation is all that belongs here.
 *
 * `stateHash` deliberately excludes `asOf`. State identity is about CONTENT, so
 * the clock advancing must not mint a new version - the same rule the existing
 * `contextFingerprint` follows, using the same hash implementation.
 */

export interface InvoiceRecord {
  id: string;
  amount: number;
  status: string;
  dueDate?: Date | string | null;
}

/** Rollup of cross-source reconciliation at the time the state was computed. */
export interface ReconciliationSummary {
  /** Subjects examined. */
  total: number;
  reconciled: number;
  /** Sources materially disagree - a human has to look (spec §14). */
  conflicts: number;
  /** An expectation came due and nothing observed it (spec §17). */
  missing: number;
  /** Not enough information to say. */
  unknown: number;
}

export type RiskState =
  /** Projected to stay above the liquidity requirement. */
  | "OK"
  /** Projected to fall below it within the horizon. */
  | "AT_RISK"
  /** Some input could not be read; the state is a partial view (spec §64). */
  | "INCOMPLETE"
  /** Nothing could be projected at all. */
  | "UNKNOWN";

export interface FinancialStateInputs {
  currentCash: number;
  transactions: TransactionRecord[];
  invoices: InvoiceRecord[];
  payouts: PayoutRecord[];
  /** From `calculateLiquiditySafetyRequirement`. The caller owns that call. */
  requiredBuffer: number;
  today?: Date;
  horizonDays?: number;
  /**
   * True when any input could not be read. Mirrors `buildDecisionContext`'s
   * `incomplete` flag: a partial state must announce itself rather than look
   * like a complete one that happens to be empty.
   */
  incomplete?: boolean;
  reconciliation?: ReconciliationSummary | null;
  /** Non-sensitive pointers to the claims/evidence behind this state. */
  evidenceRefs?: string[];
}

export interface FinancialStateSnapshot {
  /** ISO timestamp. Excluded from stateHash. */
  asOf: string;

  cashPosition: number;
  receivables: number;
  payables: number;
  expectedInflows: number;
  expectedOutflows: number;
  activeCommitments: number;

  requiredBuffer: number;
  projectedMinimumBalance: number | null;
  riskState: RiskState;
  horizonDays: number;

  reconciliation: ReconciliationSummary | null;
  evidenceRefs: string[];

  /** Per-component hashes, so a diff can say WHAT changed (feeds P7). */
  components: Record<string, string>;
  /** Deterministic hash of the financial content. */
  stateHash: string;
}

/** An invoice still owed to us. PAID is the only settled status. */
function isOutstanding(invoice: InvoiceRecord): boolean {
  return invoice.status !== "PAID";
}

function isUsableAmount(amount: unknown): amount is number {
  return typeof amount === "number" && Number.isFinite(amount);
}

/**
 * Compute the unified financial state for one tenant.
 *
 * Pure and deterministic: the same inputs always produce the same `stateHash`,
 * regardless of the order rows arrive in or the wall clock. Callers must pass
 * rows for ONE tenant; this function has no way to check that.
 */
export function computeFinancialState(inputs: FinancialStateInputs): FinancialStateSnapshot {
  const today = inputs.today ?? new Date();
  const horizonDays = inputs.horizonDays ?? FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS;

  // Obligations come from the engine's own definition - payouts that are
  // SCHEDULED/RESCHEDULED plus PENDING outflows - not from a rule restated here.
  const obligations = extractObligations(inputs.payouts, inputs.transactions, today);
  const payables = obligations.reduce((sum, o) => sum + o.amount, 0);

  const receivables = inputs.invoices
    .filter((i) => isOutstanding(i) && isUsableAmount(i.amount) && i.amount > 0)
    .reduce((sum, i) => sum + i.amount, 0);

  // Expected flows come from the real forecast, over the real horizon, so the
  // state cannot disagree with the forecast about what is coming.
  const movements = transactionsToMovements(
    inputs.transactions.map((t) => ({
      id: t.id,
      amount: t.amount,
      type: t.type as "INFLOW" | "OUTFLOW",
      status: t.status,
      expectedDate: new Date(t.expectedDate),
      description: t.description ?? null,
    }))
  );
  const forecast = buildForecast(inputs.currentCash, movements, horizonDays, today);

  const expectedInflows = forecast.reduce((sum, d) => sum + d.expectedInflows, 0);
  const expectedOutflows = forecast.reduce((sum, d) => sum + d.expectedOutflows, 0);

  const runway = forecast.length > 0 ? calculateRunway(forecast, inputs.requiredBuffer) : null;
  const projectedMinimumBalance = runway ? runway.minimumBalance : null;

  const riskState = deriveRiskState({
    incomplete: inputs.incomplete === true,
    projectedMinimumBalance,
    requiredBuffer: inputs.requiredBuffer,
  });

  // Component hashes mirror the fingerprint's shape so P7 can diff a state
  // transition the same way `classifyStaleness` diffs a decision context.
  const components: Record<string, string> = {
    cash: sha256(stableStringify({ cashPosition: inputs.currentCash })),
    buffer: sha256(stableStringify({ requiredBuffer: inputs.requiredBuffer })),
    horizon: sha256(stableStringify({ horizonDays })),
    receivables: sha256(stableStringify({ receivables })),
    payables: sha256(stableStringify({ payables, activeCommitments: obligations.length })),
    flows: sha256(stableStringify({ expectedInflows, expectedOutflows })),
    risk: sha256(stableStringify({ riskState, projectedMinimumBalance })),
    reconciliation: sha256(stableStringify(inputs.reconciliation ?? null)),
  };

  return {
    // asOf is reported but NOT hashed: time passing is not a state change.
    asOf: today.toISOString(),
    cashPosition: inputs.currentCash,
    receivables,
    payables,
    expectedInflows,
    expectedOutflows,
    activeCommitments: obligations.length,
    requiredBuffer: inputs.requiredBuffer,
    projectedMinimumBalance,
    riskState,
    horizonDays,
    reconciliation: inputs.reconciliation ?? null,
    evidenceRefs: [...(inputs.evidenceRefs ?? [])].sort(),
    components,
    stateHash: sha256(stableStringify(components)),
  };
}

function deriveRiskState(args: {
  incomplete: boolean;
  projectedMinimumBalance: number | null;
  requiredBuffer: number;
}): RiskState {
  // Incompleteness outranks the numbers: a state built on partial data must not
  // report a confident OK just because the rows it did read looked healthy.
  if (args.incomplete) return "INCOMPLETE";
  if (args.projectedMinimumBalance === null) return "UNKNOWN";
  return args.projectedMinimumBalance < args.requiredBuffer ? "AT_RISK" : "OK";
}

/** True when two states describe the same financial reality. */
export function isSameState(a: FinancialStateSnapshot, b: FinancialStateSnapshot): boolean {
  return a.stateHash === b.stateHash;
}

/** Which components differ between two states. Feeds P7's materiality check. */
export function changedComponents(
  a: FinancialStateSnapshot,
  b: FinancialStateSnapshot
): string[] {
  const keys = new Set([...Object.keys(a.components), ...Object.keys(b.components)]);
  return [...keys].filter((k) => a.components[k] !== b.components[k]).sort();
}
