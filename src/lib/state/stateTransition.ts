import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import type {
  StalenessClassification,
  ContextChange,
  FreshnessVerdict,
} from "@/lib/engine/strategyFreshness";
import type { FinancialStateSnapshot } from "./financialState";

/**
 * Phase 7 - classify a FINANCIAL STATE transition, and combine that judgement
 * with the existing decision-context freshness verdict (spec §19, §20, §32).
 *
 * ## Why this does not replace `classifyStaleness`
 *
 * A financial state is a set of AGGREGATES. The decision-context fingerprint
 * diffs INDIVIDUAL RECORDS. Those are not equivalent, and the difference is not
 * academic: an invoice for ₹5L disappearing at the same moment another ₹5L
 * invoice appears leaves every aggregate identical while changing exactly the
 * records a strategy was going to act on. The state would report NO_CHANGE; the
 * fingerprint correctly reports MATERIAL_CHANGE.
 *
 * So the state check is strictly ADDITIVE conservatism. `combineFreshness` takes
 * the more severe of the two verdicts, which means wiring it in can only ever
 * block something that would have been allowed - never allow something that
 * would have been blocked. There is a test for every one of the sixteen
 * combinations.
 *
 * ## Why a missing state is not UNKNOWN
 *
 * `classifyStaleness` treats a missing fingerprint as UNKNOWN and blocks, which
 * is right: a strategy that recorded no fingerprint cannot be verified. A
 * missing STATE means something different - that this decision predates state
 * tracking, or that nothing has materialised a state yet. Blocking on that would
 * take the entire product down the moment this code shipped. It is therefore
 * NOT_TRACKED, contributes nothing, and defers wholly to the fingerprint.
 *
 * Thresholds are taken from FINANCIAL_CONFIG, the same ones `classifyStaleness`
 * uses, so the two halves cannot disagree about what "material" means.
 */

export type StateTransitionClassification = StalenessClassification | "NOT_TRACKED";

export interface StateTransitionVerdict {
  classification: StateTransitionClassification;
  changes: ContextChange[];
  fromVersion: number | null;
  toVersion: number | null;
  /** True only for MATERIAL_CHANGE and UNKNOWN. NOT_TRACKED never blocks. */
  blocksExecution: boolean;
}

/** A state snapshot paired with the version it was stored as. */
export interface VersionedState {
  stateVersion: number;
  snapshot: FinancialStateSnapshot;
}

/** The smallest change worth treating as material, relative to the position. */
function materialityFloor(state: FinancialStateSnapshot): number {
  const basis = Math.max(
    Math.abs(state.cashPosition || 0),
    Math.abs(state.requiredBuffer || 0)
  );
  return Math.max(1, Math.round(basis * FINANCIAL_CONFIG.FRESHNESS_MATERIALITY_RATIO));
}

function relativeDrift(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(after - before) / Math.abs(before);
}

/**
 * Classify the move from the state a decision was made against to the current
 * state.
 *
 * `from` is null when the decision never recorded a state version - that is
 * NOT_TRACKED, not a failure. `to` being null while `from` is set IS a failure:
 * the decision claimed a state that cannot now be read.
 */
export function classifyStateTransition(
  from: VersionedState | null,
  to: VersionedState | null
): StateTransitionVerdict {
  if (!from) {
    return {
      classification: "NOT_TRACKED",
      changes: [],
      fromVersion: null,
      toVersion: to?.stateVersion ?? null,
      blocksExecution: false,
    };
  }

  if (!to) {
    return {
      classification: "UNKNOWN",
      changes: [
        {
          field: "financialState",
          severity: "UNKNOWN",
          from: from.stateVersion,
          to: null,
          reason:
            "This decision was made against a recorded financial state that can no longer be read, so it cannot be verified.",
        },
      ],
      fromVersion: from.stateVersion,
      toVersion: null,
      blocksExecution: true,
    };
  }

  if (from.snapshot.stateHash === to.snapshot.stateHash) {
    return {
      classification: "NO_CHANGE",
      changes: [],
      fromVersion: from.stateVersion,
      toVersion: to.stateVersion,
      blocksExecution: false,
    };
  }

  const before = from.snapshot;
  const after = to.snapshot;
  const changes: ContextChange[] = [];
  const floor = materialityFloor(before);

  // An incomplete state on either side means the comparison itself is not
  // trustworthy - the same rule classifyStaleness applies (spec §64).
  if (before.riskState === "INCOMPLETE" || after.riskState === "INCOMPLETE") {
    changes.push({
      field: "riskState",
      severity: "UNKNOWN",
      from: before.riskState,
      to: after.riskState,
      reason: "A financial state was built from incomplete inputs; it cannot certify freshness.",
    });
  }

  if (before.horizonDays !== after.horizonDays) {
    changes.push({
      field: "horizonDays",
      severity: "MATERIAL",
      from: before.horizonDays,
      to: after.horizonDays,
      reason: "The forecast horizon changed between these states.",
    });
  }

  if (before.cashPosition !== after.cashPosition) {
    const drift = relativeDrift(before.cashPosition, after.cashPosition);
    changes.push({
      field: "cashPosition",
      severity: drift > FINANCIAL_CONFIG.EXECUTION_DRIFT_THRESHOLD ? "MATERIAL" : "MINOR",
      from: before.cashPosition,
      to: after.cashPosition,
      reason: `Cash position moved ${
        Number.isFinite(drift) ? (drift * 100).toFixed(1) + "%" : "from a zero baseline"
      }.`,
    });
  }

  if (before.requiredBuffer !== after.requiredBuffer) {
    const drift = relativeDrift(before.requiredBuffer, after.requiredBuffer);
    changes.push({
      field: "requiredBuffer",
      severity:
        drift > FINANCIAL_CONFIG.FRESHNESS_BUFFER_DRIFT_THRESHOLD ? "MATERIAL" : "MINOR",
      from: before.requiredBuffer,
      to: after.requiredBuffer,
      reason: "The adaptive liquidity requirement changed.",
    });
  }

  for (const field of ["receivables", "payables", "expectedInflows", "expectedOutflows"] as const) {
    if (before[field] !== after[field]) {
      const delta = Math.abs(after[field] - before[field]);
      changes.push({
        field,
        severity: delta >= floor ? "MATERIAL" : "MINOR",
        from: before[field],
        to: after[field],
        reason: `${field} moved by ${delta} paise.`,
      });
    }
  }

  if (before.activeCommitments !== after.activeCommitments) {
    // A commitment appearing or vanishing is exactly what a plan is built
    // around, so the count moving at all is material.
    changes.push({
      field: "activeCommitments",
      severity: "MATERIAL",
      from: before.activeCommitments,
      to: after.activeCommitments,
      reason: "The set of live obligations changed size.",
    });
  }

  if (before.riskState !== after.riskState) {
    changes.push({
      field: "riskState",
      severity: "MATERIAL",
      from: before.riskState,
      to: after.riskState,
      reason: `Liquidity risk moved from ${before.riskState} to ${after.riskState}.`,
    });
  }

  // A newly detected cross-source conflict means the numbers underneath this
  // plan are themselves disputed (spec §14).
  const conflictsBefore = before.reconciliation?.conflicts ?? 0;
  const conflictsAfter = after.reconciliation?.conflicts ?? 0;
  if (conflictsAfter > conflictsBefore) {
    changes.push({
      field: "reconciliation.conflicts",
      severity: "MATERIAL",
      from: conflictsBefore,
      to: conflictsAfter,
      reason: "Sources now disagree about figures this plan depends on.",
    });
  }

  const missingBefore = before.reconciliation?.missing ?? 0;
  const missingAfter = after.reconciliation?.missing ?? 0;
  if (missingAfter > missingBefore) {
    changes.push({
      field: "reconciliation.missing",
      severity: "MATERIAL",
      from: missingBefore,
      to: missingAfter,
      reason: "An expected payment this plan relied on has not arrived.",
    });
  }

  // Hashes differ but nothing above explains it: something we hash and do not
  // diff has moved. Do not assume it is harmless.
  if (changes.length === 0) {
    return {
      classification: "UNKNOWN",
      changes: [
        {
          field: "stateHash",
          severity: "UNKNOWN",
          from: before.stateHash,
          to: after.stateHash,
          reason:
            "The financial state changed in a way this comparison could not attribute. Regenerate the strategy.",
        },
      ],
      fromVersion: from.stateVersion,
      toVersion: to.stateVersion,
      blocksExecution: true,
    };
  }

  const hasUnknown = changes.some((c) => c.severity === "UNKNOWN");
  const hasMaterial = changes.some((c) => c.severity === "MATERIAL");
  const classification: StalenessClassification = hasUnknown
    ? "UNKNOWN"
    : hasMaterial
    ? "MATERIAL_CHANGE"
    : "MINOR_CHANGE";

  return {
    classification,
    changes,
    fromVersion: from.stateVersion,
    toVersion: to.stateVersion,
    blocksExecution: classification === "MATERIAL_CHANGE" || classification === "UNKNOWN",
  };
}

/** Severity ordering. Higher is more conservative. */
const SEVERITY_RANK: Record<StalenessClassification, number> = {
  NO_CHANGE: 0,
  MINOR_CHANGE: 1,
  MATERIAL_CHANGE: 2,
  UNKNOWN: 3,
};

/**
 * Combine the decision-context verdict with the financial-state verdict, taking
 * whichever is more conservative.
 *
 * The safety property, asserted exhaustively in the tests: the combined verdict
 * is never less severe than the fingerprint verdict alone. Adding the state
 * check can block something that used to pass; it can never pass something that
 * used to be blocked.
 *
 * NOT_TRACKED contributes nothing, so a decision made before state tracking
 * existed behaves exactly as it did before this function was introduced.
 */
export function combineFreshness(
  fingerprint: FreshnessVerdict,
  state: StateTransitionVerdict
): FreshnessVerdict {
  if (state.classification === "NOT_TRACKED") return fingerprint;

  const stateClass = state.classification;
  const winner =
    SEVERITY_RANK[stateClass] > SEVERITY_RANK[fingerprint.classification]
      ? stateClass
      : fingerprint.classification;

  return {
    ...fingerprint,
    classification: winner,
    fresh: winner === "NO_CHANGE" || winner === "MINOR_CHANGE",
    blocksExecution: winner === "MATERIAL_CHANGE" || winner === "UNKNOWN",
    // Both sets of reasons, so an explanation can cite whichever actually fired.
    changes: [...fingerprint.changes, ...state.changes],
  };
}
