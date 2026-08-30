import { FINANCIAL_CONFIG } from "../engine/financialConfig";
import type { FinancialStateSnapshot } from "./financialState";

/**
 * Does the forecast agree with the materialised financial state?
 *
 * ## Why this exists instead of "the forecast reads FinancialState"
 *
 * The roadmap (B-7) describes the forecast consuming `FinancialState` rather
 * than canonical rows. That is not implementable as written, and implementing
 * it would be a mistake.
 *
 * `FinancialState` is AGGREGATE-ONLY: cash position, receivables, payables,
 * expected inflow and outflow totals, a commitment count. `buildForecast`
 * constructs a day-by-day runway, which needs each invoice's due date and each
 * payout's scheduled date — per-record detail the state does not carry. Making
 * it carry that detail would turn it into a second copy of the ledger, and the
 * spec is explicit that it must not become a second conflicting source of
 * truth. The canonical rows ARE the truth; a materialised aggregate cannot
 * outrank them.
 *
 * What the state IS good for is checking. Two independent paths compute
 * overlapping totals — the forecast from records, the state from the reconciled
 * brain — and when they disagree, something is wrong that neither path can see
 * alone: a stale sync, an unreconciled conflict, or a record that changed
 * between the two computations.
 *
 * So the boundary this establishes is a VERIFICATION boundary. The forecast
 * keeps reading canonical rows and the state gets a vote on whether to trust
 * the result. Disagreement is surfaced, never silently resolved (spec §7).
 */

export type ConsistencyVerdict = "AGREES" | "DIVERGED" | "NOT_COMPARABLE";

export interface ConsistencyFinding {
  field: string;
  forecastValue: number;
  stateValue: number;
  /** Absolute difference in paise. */
  deltaPaise: number;
  /** Difference as a share of the larger figure, 0-1. */
  deltaRatio: number;
}

export interface ForecastConsistencyResult {
  verdict: ConsistencyVerdict;
  /** The state this was compared against; null when there was none. */
  stateVersion: number | null;
  findings: ConsistencyFinding[];
  /** Operator-facing sentence. Always populated. */
  summary: string;
}

/** The forecast-side totals that overlap with the state's. */
export interface ForecastTotals {
  cashPosition: number;
  expectedInflows: number;
  expectedOutflows: number;
  projectedMinimumBalance: number | null;
}

/**
 * How far apart two figures may drift before it is worth reporting.
 *
 * Reuses the freshness materiality ratio rather than inventing a second
 * threshold: "material" should mean one thing across the system. A tiny delta is
 * expected — the two paths round and filter slightly differently — and
 * reporting it would train operators to ignore this signal, which is worse than
 * not having it.
 */
const MATERIALITY_RATIO = FINANCIAL_CONFIG.FRESHNESS_MATERIALITY_RATIO;

function compare(
  field: string,
  forecastValue: number | null,
  stateValue: number | null
): ConsistencyFinding | null {
  // A null on either side is "not measured", which is not the same as zero and
  // must not be compared as though it were.
  if (forecastValue == null || stateValue == null) return null;
  if (!Number.isFinite(forecastValue) || !Number.isFinite(stateValue)) return null;

  const deltaPaise = Math.abs(forecastValue - stateValue);
  if (deltaPaise === 0) return null;

  const scale = Math.max(Math.abs(forecastValue), Math.abs(stateValue));
  const deltaRatio = scale === 0 ? 0 : deltaPaise / scale;

  if (deltaRatio < MATERIALITY_RATIO) return null;

  return { field, forecastValue, stateValue, deltaPaise, deltaRatio };
}

export function checkForecastConsistency(
  forecast: ForecastTotals,
  state: FinancialStateSnapshot | null,
  stateVersion: number | null
): ForecastConsistencyResult {
  // No state is the ordinary case before any sync has run. It is NOT a
  // disagreement, and reporting it as one would cry wolf on every tenant that
  // has simply never synced.
  if (!state || stateVersion == null) {
    return {
      verdict: "NOT_COMPARABLE",
      stateVersion: null,
      findings: [],
      summary:
        "No materialised financial state exists yet, so this forecast has not been " +
        "cross-checked against one. It is computed from the ledger directly.",
    };
  }

  const findings = [
    compare("cashPosition", forecast.cashPosition, state.cashPosition),
    compare("expectedInflows", forecast.expectedInflows, state.expectedInflows),
    compare("expectedOutflows", forecast.expectedOutflows, state.expectedOutflows),
    compare(
      "projectedMinimumBalance",
      forecast.projectedMinimumBalance,
      state.projectedMinimumBalance
    ),
  ].filter((f): f is ConsistencyFinding => f !== null);

  if (findings.length === 0) {
    return {
      verdict: "AGREES",
      stateVersion,
      findings: [],
      summary: `This forecast agrees with financial state v${stateVersion}.`,
    };
  }

  const worst = findings.reduce((a, b) => (b.deltaRatio > a.deltaRatio ? b : a));

  return {
    verdict: "DIVERGED",
    stateVersion,
    findings,
    // Names the discrepancy and stops. Deciding which side is right is a human
    // judgement (spec §7) — one of them may be stale, and silently preferring
    // either would be inventing an answer.
    summary:
      `This forecast disagrees with financial state v${stateVersion} on ` +
      `${findings.length} figure${findings.length === 1 ? "" : "s"}, the largest being ` +
      `${worst.field} (${Math.round(worst.deltaRatio * 100)}% apart). The forecast is ` +
      `computed from the ledger; the state may be stale, or a source conflict may be ` +
      `unresolved. Re-run the brain sync, and review any open conflicts.`,
  };
}
