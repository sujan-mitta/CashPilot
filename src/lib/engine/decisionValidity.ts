import { FINANCIAL_CONFIG } from "./financialConfig";
import type { ContextChange, FreshnessVerdict, StalenessClassification } from "./strategyFreshness";

/**
 * Phase 11 - the two freshness axes the fingerprint cannot see (spec §32).
 *
 * `classifyStaleness` blocks when the FACTS changed. Phase 7 blocks when the
 * materialised STATE changed. Both are silent in two cases that still make a
 * recommendation unsafe to execute:
 *
 *   METHOD  - the forecasting pipeline changed underneath it. Every fact is
 *             identical, so the fingerprint is identical, but the numbers the
 *             plan was scored against were produced a different way.
 *
 *   AGE     - nothing OBSERVED changed for a week. That is not reassurance; in
 *             a live ledger it is a reason to distrust the inputs rather than
 *             the arithmetic (spec §55-56).
 *
 * Both follow the Phase 7 pattern exactly: a decision that recorded neither is
 * UNTRACKED and contributes nothing, so every decision made before this existed
 * behaves precisely as it did. And like Phase 7, this can only ever TIGHTEN a
 * verdict - `tightenForValidity` takes the more severe of the two.
 */

export type DecisionValidityClassification =
  /** Nothing recorded, so nothing to check. Contributes nothing. */
  | "UNTRACKED"
  /** Recorded and still valid. */
  | "VALID"
  /** Recorded and no longer valid. Blocks. */
  | "INVALID";

export interface DecisionValidityVerdict {
  classification: DecisionValidityClassification;
  changes: ContextChange[];
  blocksExecution: boolean;
}

export interface RecordedDecisionValidity {
  /** The forecasting method that produced the recommendation. */
  forecastVersion?: string | null;
  /** When it stops being executable on age alone. */
  expiresAt?: Date | null;
}

export interface ValidityCheckOptions {
  now?: Date;
  /** The method in force right now. */
  currentForecastVersion: string;
}

/**
 * Check a decision's recorded method and expiry against the present.
 *
 * A null on either field is UNTRACKED for that axis - never a failure. That
 * asymmetry is deliberate and is the same one Phase 7 makes: a missing
 * fingerprint means "cannot verify" and must block, whereas a missing expiry
 * means "this predates expiry" and must not.
 */
export function checkDecisionValidity(
  recorded: RecordedDecisionValidity | null | undefined,
  options: ValidityCheckOptions
): DecisionValidityVerdict {
  const now = options.now ?? new Date();
  const changes: ContextChange[] = [];

  const recordedVersion = recorded?.forecastVersion ?? null;
  const expiresAt = recorded?.expiresAt ?? null;

  if (recordedVersion === null && expiresAt === null) {
    return { classification: "UNTRACKED", changes: [], blocksExecution: false };
  }

  if (recordedVersion !== null && recordedVersion !== options.currentForecastVersion) {
    changes.push({
      field: "forecastVersion",
      severity: "MATERIAL",
      from: recordedVersion,
      to: options.currentForecastVersion,
      reason:
        "The forecasting method changed after this recommendation was produced, so the numbers it was scored against were calculated a different way. Regenerate it.",
    });
  }

  if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
    const ageHours = Math.floor((now.getTime() - expiresAt.getTime()) / (60 * 60 * 1000));
    changes.push({
      field: "expiresAt",
      severity: "MATERIAL",
      from: expiresAt.toISOString(),
      to: now.toISOString(),
      reason:
        `This recommendation expired ${ageHours} hour(s) ago. Nothing in the ledger has ` +
        `contradicted it, but it is too old to act on without re-checking reality.`,
    });
  }

  return {
    classification: changes.length > 0 ? "INVALID" : "VALID",
    changes,
    blocksExecution: changes.length > 0,
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
 * Fold a validity verdict into a freshness verdict, taking the more severe.
 *
 * Same safety property as Phase 7's `combineFreshness`, and asserted the same
 * way: the result is never less severe than the input, so adding this check can
 * block something that used to pass but can never pass something that used to
 * be blocked. UNTRACKED returns the input by identity.
 */
export function tightenForValidity(
  verdict: FreshnessVerdict,
  validity: DecisionValidityVerdict
): FreshnessVerdict {
  if (validity.classification !== "INVALID") return verdict;

  const winner: StalenessClassification =
    SEVERITY_RANK["MATERIAL_CHANGE"] > SEVERITY_RANK[verdict.classification]
      ? "MATERIAL_CHANGE"
      : verdict.classification;

  return {
    ...verdict,
    classification: winner,
    fresh: winner === "NO_CHANGE" || winner === "MINOR_CHANGE",
    blocksExecution: winner === "MATERIAL_CHANGE" || winner === "UNKNOWN",
    changes: [...verdict.changes, ...validity.changes],
  };
}

/**
 * When a recommendation created now should expire.
 *
 * Exported so the creation path and any test agree on one definition rather
 * than each doing the arithmetic.
 */
export function decisionExpiryFrom(createdAt: Date): Date {
  return new Date(createdAt.getTime() + FINANCIAL_CONFIG.DECISION_TTL_HOURS * 60 * 60 * 1000);
}
