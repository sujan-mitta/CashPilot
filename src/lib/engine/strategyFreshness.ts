import crypto from "crypto";
import { FINANCIAL_CONFIG, isUsableAmount } from "./financialConfig";

/**
 * ===========================================================================
 * STRATEGY FRESHNESS  (Phase 15 P0)
 * ===========================================================================
 *
 * Phase 14 only compared `currentCash` against the cash the strategy was
 * simulated from. That misses the case that matters most:
 *
 *   T0  cash 10L, one 2L payout on day 3   -> "reschedule the 2L payout"
 *   T1  cash 10L, PLUS a new 50L payout due tomorrow
 *
 * Cash drift is 0%. The recommendation is nonsense. The old check waved it
 * through.
 *
 * A fingerprint over the financial FACTS the recommendation rests on catches
 * this. It is captured at decision time, recomputed at approval and at
 * execution, and any material difference blocks the strategy.
 */

export type StalenessClassification =
  | "NO_CHANGE"
  | "MINOR_CHANGE"
  | "MATERIAL_CHANGE"
  | "UNKNOWN";

export interface ContextObligation {
  sourceType: "PAYOUT" | "TRANSACTION";
  sourceId: string;
  amount: number;
  dueDate: string; // YYYY-MM-DD
  criticality: "CRITICAL" | "HIGH" | "NORMAL";
  status: string;
}

export interface ContextActionTarget {
  actionType: string;
  targetType: "PAYOUT" | "TRANSACTION" | "INVOICE_SET" | "NONE";
  targetId: string | null;
  amount: number;
  /** Status of the underlying record when the strategy was built. */
  targetStatus: string | null;
  /** false when the record could not be found at all. */
  targetExists: boolean;
}

/**
 * One ledger movement, identified absolutely.
 *
 * Deliberately NOT an aggregate: aggregates are computed over rolling windows
 * anchored on the current time, so they drift as the clock moves even when
 * nothing financial has changed.
 */
export interface ContextMovement {
  id: string;
  amount: number;
  type: "INFLOW" | "OUTFLOW";
  status: string;
  date: string; // YYYY-MM-DD, absolute
}

export interface DecisionContext {
  strategyType: string;
  startingCash: number;
  requiredBuffer: number;
  forecastHorizonDays: number;
  movements: ContextMovement[];
  obligations: ContextObligation[];
  actionTargets: ContextActionTarget[];
  engineVersion: string;
  scoringConfigVersion: string;
  liquidityConfigVersion: string;
  /** true when some input could not be read; forces conservative handling. */
  incomplete?: boolean;
}

export interface FingerprintDetail {
  fingerprint: string;
  components: Record<string, string>;
  context: DecisionContext;
  capturedAt: string;
}

export interface ContextChange {
  field: string;
  severity: "MINOR" | "MATERIAL" | "UNKNOWN";
  from: unknown;
  to: unknown;
  reason: string;
}

export interface FreshnessVerdict {
  classification: StalenessClassification;
  fresh: boolean;
  /** True only for MATERIAL_CHANGE and UNKNOWN - these must block execution. */
  blocksExecution: boolean;
  changes: ContextChange[];
  decisionFingerprint: string | null;
  currentFingerprint: string;
}

/**
 * Exported so the Phase 6 financial-state hash uses THIS implementation rather
 * than growing a second one. Two hashing schemes that drift apart would make
 * state identity and strategy freshness disagree about whether anything changed.
 */
export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Key-order-independent stringify, so an identical object always hashes alike. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** Sorts obligations so an identical set always hashes identically. */
function normaliseObligations(obligations: ContextObligation[]): ContextObligation[] {
  return [...obligations]
    .filter((o) => isUsableAmount(o.amount) && o.amount > 0)
    .sort((a, b) =>
      a.sourceId === b.sourceId
        ? a.dueDate.localeCompare(b.dueDate)
        : a.sourceId.localeCompare(b.sourceId)
    );
}

function normaliseMovements(movements: ContextMovement[]): ContextMovement[] {
  return [...(movements ?? [])]
    .filter((m) => isUsableAmount(m.amount) && m.amount !== 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normaliseTargets(targets: ContextActionTarget[]): ContextActionTarget[] {
  return [...targets].sort((a, b) =>
    a.actionType === b.actionType
      ? String(a.targetId).localeCompare(String(b.targetId))
      : a.actionType.localeCompare(b.actionType)
  );
}

/**
 * Computes the fingerprint plus per-component hashes.
 *
 * Component hashes exist so a later comparison can say WHICH part changed
 * rather than only that something did. Volatile fields (timestamps, ids of
 * rows we do not act on, narration text, scores) are deliberately excluded -
 * including them would make every strategy stale within seconds.
 */
export function computeContextFingerprint(context: DecisionContext): FingerprintDetail {
  const obligations = normaliseObligations(context.obligations);
  const actionTargets = normaliseTargets(context.actionTargets);
  const movements = normaliseMovements(context.movements);

  const components: Record<string, string> = {
    identity: sha256(stableStringify({ strategyType: context.strategyType })),
    cash: sha256(stableStringify({ startingCash: context.startingCash })),
    buffer: sha256(stableStringify({ requiredBuffer: context.requiredBuffer })),
    horizon: sha256(stableStringify({ forecastHorizonDays: context.forecastHorizonDays })),
    movements: sha256(stableStringify(movements)),
    obligations: sha256(stableStringify(obligations)),
    actionTargets: sha256(stableStringify(actionTargets)),
    config: sha256(
      stableStringify({
        engineVersion: context.engineVersion,
        scoringConfigVersion: context.scoringConfigVersion,
        liquidityConfigVersion: context.liquidityConfigVersion,
      })
    ),
  };

  const fingerprint = sha256(stableStringify(components));

  return {
    fingerprint,
    components,
    context: { ...context, obligations, actionTargets, movements },
    capturedAt: new Date().toISOString(),
  };
}

/** The smallest change worth treating as material for this business. */
function materialityFloor(context: DecisionContext): number {
  const basis = Math.max(
    Math.abs(context.startingCash || 0),
    Math.abs(context.requiredBuffer || 0)
  );
  return Math.max(1, Math.round(basis * FINANCIAL_CONFIG.FRESHNESS_MATERIALITY_RATIO));
}

function daysBetween(a: string, b: string): number {
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return Number.POSITIVE_INFINITY;
  return Math.abs(t1 - t2) / (24 * 60 * 60 * 1000);
}

/**
 * Compares the context captured at decision time against the world as it is now.
 *
 * Rules, in the order they are applied:
 *
 *   UNKNOWN   either side is incomplete, or the stored fingerprint is missing.
 *             Conservative by design - we cannot certify freshness we did not
 *             measure, and "we could not check" must not read as "it is fine".
 *   MATERIAL  configuration changed; an action's target vanished or already
 *             settled; a critical obligation appeared or disappeared; an
 *             obligation moved in amount or date beyond tolerance; cash or the
 *             required buffer drifted beyond threshold.
 *   MINOR     changes below every threshold.
 *   NO_CHANGE identical fingerprints.
 */
export function classifyStaleness(
  decisionDetail: FingerprintDetail | null | undefined,
  current: FingerprintDetail
): FreshnessVerdict {
  const changes: ContextChange[] = [];

  if (!decisionDetail || !decisionDetail.fingerprint) {
    return {
      classification: "UNKNOWN",
      fresh: false,
      blocksExecution: true,
      changes: [
        {
          field: "fingerprint",
          severity: "UNKNOWN",
          from: null,
          to: current.fingerprint,
          reason:
            "This strategy was generated by an older engine version that did not record a decision-time fingerprint, so its freshness cannot be verified. Regenerate the recommendation.",
        },
      ],
      decisionFingerprint: null,
      currentFingerprint: current.fingerprint,
    };
  }

  if (decisionDetail.fingerprint === current.fingerprint) {
    return {
      classification: "NO_CHANGE",
      fresh: true,
      blocksExecution: false,
      changes: [],
      decisionFingerprint: decisionDetail.fingerprint,
      currentFingerprint: current.fingerprint,
    };
  }

  const before = decisionDetail.context;
  const after = current.context;

  if (before?.incomplete || after?.incomplete) {
    changes.push({
      field: "context",
      severity: "UNKNOWN",
      from: before?.incomplete ?? null,
      to: after?.incomplete ?? null,
      reason: "Some financial inputs could not be read; freshness cannot be certified.",
    });
  }

  if (before.strategyType !== after.strategyType) {
    changes.push({
      field: "strategyType",
      severity: "MATERIAL",
      from: before.strategyType,
      to: after.strategyType,
      reason: "The strategy being checked is not the one this decision recorded.",
    });
  }

  // --- configuration identity ---------------------------------------------
  for (const key of ["engineVersion", "scoringConfigVersion", "liquidityConfigVersion"] as const) {
    if (before[key] !== after[key]) {
      changes.push({
        field: key,
        severity: "MATERIAL",
        from: before[key],
        to: after[key],
        reason: "The engine or scoring configuration changed after this strategy was simulated.",
      });
    }
  }

  if (before.forecastHorizonDays !== after.forecastHorizonDays) {
    changes.push({
      field: "forecastHorizonDays",
      severity: "MATERIAL",
      from: before.forecastHorizonDays,
      to: after.forecastHorizonDays,
      reason: "Forecast horizon changed.",
    });
  }

  const floor = materialityFloor(before);

  // --- cash ----------------------------------------------------------------
  if (before.startingCash !== after.startingCash) {
    const drift =
      before.startingCash !== 0
        ? Math.abs(after.startingCash - before.startingCash) / Math.abs(before.startingCash)
        : Number.POSITIVE_INFINITY;
    changes.push({
      field: "startingCash",
      severity: drift > FINANCIAL_CONFIG.EXECUTION_DRIFT_THRESHOLD ? "MATERIAL" : "MINOR",
      from: before.startingCash,
      to: after.startingCash,
      reason: `Cash moved ${Number.isFinite(drift) ? (drift * 100).toFixed(1) + "%" : "from an unknown baseline"}.`,
    });
  }

  // --- required buffer -----------------------------------------------------
  if (before.requiredBuffer !== after.requiredBuffer) {
    const drift =
      before.requiredBuffer !== 0
        ? Math.abs(after.requiredBuffer - before.requiredBuffer) / Math.abs(before.requiredBuffer)
        : Number.POSITIVE_INFINITY;
    changes.push({
      field: "requiredBuffer",
      severity: drift > FINANCIAL_CONFIG.FRESHNESS_BUFFER_DRIFT_THRESHOLD ? "MATERIAL" : "MINOR",
      from: before.requiredBuffer,
      to: after.requiredBuffer,
      reason: "The adaptive liquidity requirement changed.",
    });
  }

  // --- action targets: the records the strategy actually manipulates -------
  for (const target of before.actionTargets) {
    const now = after.actionTargets.find(
      (t) => t.actionType === target.actionType && t.targetId === target.targetId
    );

    if (!now || !now.targetExists) {
      changes.push({
        field: `actionTarget:${target.actionType}:${target.targetId}`,
        severity: "MATERIAL",
        from: target.targetStatus,
        to: null,
        reason: "The record this action was going to act on no longer exists.",
      });
      continue;
    }
    if (now.targetStatus !== target.targetStatus) {
      changes.push({
        field: `actionTarget:${target.actionType}:${target.targetId}`,
        severity: "MATERIAL",
        from: target.targetStatus,
        to: now.targetStatus,
        reason: "The target record has already changed state (for example, it was paid or rescheduled).",
      });
    }
    if (now.amount !== target.amount) {
      changes.push({
        field: `actionTargetAmount:${target.actionType}:${target.targetId}`,
        severity: Math.abs(now.amount - target.amount) >= floor ? "MATERIAL" : "MINOR",
        from: target.amount,
        to: now.amount,
        reason: "The amount of the targeted record changed.",
      });
    }
  }

  // A target the recommendation did not originally reference has appeared. The
  // earlier version only walked `before`, so this whole class of divergence fell
  // through to the unexplained-difference branch.
  for (const target of after.actionTargets) {
    const then = before.actionTargets.find(
      (t) => t.actionType === target.actionType && t.targetId === target.targetId
    );
    if (!then) {
      changes.push({
        field: `actionTarget:new:${target.actionType}:${target.targetId}`,
        severity: "MATERIAL",
        from: null,
        to: { amount: target.amount, status: target.targetStatus },
        reason: "The strategy now references a record the decision never recorded.",
      });
    }
  }

  // --- obligations ---------------------------------------------------------
  const beforeById = new Map(before.obligations.map((o) => [o.sourceId, o]));
  const afterById = new Map(after.obligations.map((o) => [o.sourceId, o]));

  for (const [id, now] of afterById) {
    const then = beforeById.get(id);
    if (!then) {
      const critical = now.criticality === "CRITICAL" || now.criticality === "HIGH";
      changes.push({
        field: `obligation:new:${id}`,
        severity: critical || now.amount >= floor ? "MATERIAL" : "MINOR",
        from: null,
        to: { amount: now.amount, dueDate: now.dueDate, criticality: now.criticality },
        reason: critical
          ? "A new critical obligation appeared after this strategy was simulated."
          : `A new obligation of ${now.amount} paise appeared.`,
      });
      continue;
    }

    if (now.amount !== then.amount) {
      changes.push({
        field: `obligation:amount:${id}`,
        severity: Math.abs(now.amount - then.amount) >= floor ? "MATERIAL" : "MINOR",
        from: then.amount,
        to: now.amount,
        reason: "An obligation amount changed.",
      });
    }
    if (now.dueDate !== then.dueDate) {
      const shift = daysBetween(then.dueDate, now.dueDate);
      changes.push({
        field: `obligation:dueDate:${id}`,
        severity:
          shift >= FINANCIAL_CONFIG.FRESHNESS_DUE_DATE_TOLERANCE_DAYS ? "MATERIAL" : "MINOR",
        from: then.dueDate,
        to: now.dueDate,
        reason: `An obligation moved by ${Number.isFinite(shift) ? shift : "an unknown number of"} day(s).`,
      });
    }
    if (now.criticality !== then.criticality) {
      changes.push({
        field: `obligation:criticality:${id}`,
        severity: "MATERIAL",
        from: then.criticality,
        to: now.criticality,
        reason: "An obligation changed criticality.",
      });
    }
  }

  for (const [id, then] of beforeById) {
    if (!afterById.has(id)) {
      const critical = then.criticality === "CRITICAL" || then.criticality === "HIGH";
      changes.push({
        field: `obligation:removed:${id}`,
        severity: critical || then.amount >= floor ? "MATERIAL" : "MINOR",
        from: { amount: then.amount, dueDate: then.dueDate, criticality: then.criticality },
        to: null,
        reason: critical
          ? "A critical obligation the plan was protecting has disappeared."
          : "An obligation disappeared.",
      });
    }
  }

  // --- ledger movements ----------------------------------------------------
  const beforeMovements = new Map((before.movements ?? []).map((m) => [m.id, m]));
  const afterMovements = new Map((after.movements ?? []).map((m) => [m.id, m]));

  for (const [id, now] of afterMovements) {
    const then = beforeMovements.get(id);
    if (!then) {
      changes.push({
        field: `movement:new:${id}`,
        severity: now.amount >= floor ? "MATERIAL" : "MINOR",
        from: null,
        to: { amount: now.amount, type: now.type, date: now.date },
        reason: `A new ${now.type.toLowerCase()} of ${now.amount} paise appeared in the ledger.`,
      });
      continue;
    }
    if (now.amount !== then.amount) {
      changes.push({
        field: `movement:amount:${id}`,
        severity: Math.abs(now.amount - then.amount) >= floor ? "MATERIAL" : "MINOR",
        from: then.amount,
        to: now.amount,
        reason: "A ledger movement changed amount.",
      });
    }
    if (now.status !== then.status) {
      changes.push({
        field: `movement:status:${id}`,
        severity: now.amount >= floor ? "MATERIAL" : "MINOR",
        from: then.status,
        to: now.status,
        reason: "A ledger movement changed status (for example, it settled or was cancelled).",
      });
    }
    if (now.date !== then.date) {
      const shift = daysBetween(then.date, now.date);
      changes.push({
        field: `movement:date:${id}`,
        severity:
          shift >= FINANCIAL_CONFIG.FRESHNESS_DUE_DATE_TOLERANCE_DAYS && now.amount >= floor
            ? "MATERIAL"
            : "MINOR",
        from: then.date,
        to: now.date,
        reason: "A ledger movement moved date.",
      });
    }
  }

  for (const [id, then] of beforeMovements) {
    if (!afterMovements.has(id)) {
      changes.push({
        field: `movement:removed:${id}`,
        severity: then.amount >= floor ? "MATERIAL" : "MINOR",
        from: { amount: then.amount, type: then.type, date: then.date },
        to: null,
        reason: "A ledger movement the simulation relied on has disappeared.",
      });
    }
  }

  const hasUnknown = changes.some((c) => c.severity === "UNKNOWN");
  const hasMaterial = changes.some((c) => c.severity === "MATERIAL");

  // The fingerprints differ but nothing above explains it. Something we hash
  // but do not diff has moved: treat as unknown rather than assume it is fine.
  if (changes.length === 0) {
    return {
      classification: "UNKNOWN",
      fresh: false,
      blocksExecution: true,
      changes: [
        {
          field: "fingerprint",
          severity: "UNKNOWN",
          from: decisionDetail.fingerprint,
          to: current.fingerprint,
          reason:
            "The decision context changed in a way this comparison could not attribute. Regenerate the strategy.",
        },
      ],
      decisionFingerprint: decisionDetail.fingerprint,
      currentFingerprint: current.fingerprint,
    };
  }

  const classification: StalenessClassification = hasUnknown
    ? "UNKNOWN"
    : hasMaterial
    ? "MATERIAL_CHANGE"
    : "MINOR_CHANGE";

  return {
    classification,
    fresh: classification === "MINOR_CHANGE",
    blocksExecution: classification === "MATERIAL_CHANGE" || classification === "UNKNOWN",
    changes,
    decisionFingerprint: decisionDetail.fingerprint,
    currentFingerprint: current.fingerprint,
  };
}
