import { isUsableAmount } from "./financialConfig";

/**
 * ===========================================================================
 * OBLIGATION OUTCOME MEASUREMENT  (Phase 15 PART 16-17)
 * ===========================================================================
 *
 * Phase 14 left `actualCriticalObligationsProtected` permanently null, because
 * the decision only stored an aggregate COUNT of critical obligations. A count
 * cannot be verified after the fact - you cannot go back and ask "which ones?".
 *
 * Decisions now snapshot each obligation with stable identity, so every one can
 * be checked individually against the ledger and the aggregate DERIVED from
 * that evidence. The prediction is never copied into the actual.
 */

export type ObligationVerdict =
  /** Due inside the window, came due with cash available to meet it. */
  | "PROTECTED"
  /** Settled on or before its original date. */
  | "PAID_ON_TIME"
  /** Settled, but after its original date. */
  | "PAID_LATE"
  /** Deliberately moved by the plan, and the move held. */
  | "RESCHEDULED"
  /** Still outstanding after its due date passed. */
  | "UNPAID"
  /** The obligation's own record reports a failure. */
  | "FAILED"
  /** Lands after the measurement window; genuinely not yet observable. */
  | "BEYOND_WINDOW"
  /** The underlying record cannot be read at all. */
  | "UNVERIFIABLE";

export interface ObligationOutcome {
  id: string;
  sourceType: string;
  sourceId: string;
  amount: number;
  originalDueDate: string;
  expectedAction: string;
  criticality: string;
  verdict: ObligationVerdict;
  observedDueDate: string | null;
  observedStatus: string | null;
  /** True only for verdicts that constitute evidence of protection. */
  countsAsProtected: boolean;
}

/** Verdicts that mean the business met (or legitimately deferred) the obligation. */
const PROTECTED_VERDICTS: ObligationVerdict[] = [
  "PROTECTED",
  "PAID_ON_TIME",
  "RESCHEDULED",
];

const DAY = 24 * 60 * 60 * 1000;

function dateOnly(value: Date | string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isFinite(d.getTime()) ? d.toISOString().split("T")[0] : "unknown";
}

/**
 * Judges one snapshotted obligation against its live record.
 *
 * The ordering is deliberate. "We cannot see it" and "it is not due yet" are
 * checked before any verdict about payment, because a verdict reached without
 * evidence is worse than no verdict at all.
 */
/** One obligation as captured at decision time. */
export interface ObligationSnapshotEntry {
  id: string;
  sourceType: string;
  sourceId: string;
  amount: number;
  originalDueDate: string;
  expectedAction: string;
  criticality: string;
}

/**
 * The only database surface obligation measurement needs.
 *
 * Declared structurally rather than as PrismaClient so a transaction client, the
 * base client, and a test fake are all equally valid - and so it is obvious at a
 * glance that measurement READS and never writes.
 */
export interface ObligationRecordReader {
  payout?: {
    findFirst(args: { where: { id: string } }): Promise<{
      scheduledDate: Date | string;
      status: string;
    } | null>;
  };
  transaction?: {
    findFirst(args: { where: { id: string } }): Promise<{
      expectedDate: Date | string;
      status: string;
    } | null>;
  };
}

export function classifyObligation(
  snapshot: ObligationSnapshotEntry,
  record: { dueDate: Date | string; status: string } | null,
  windowEnd: Date
): ObligationOutcome {
  const base = {
    id: snapshot.id,
    sourceType: snapshot.sourceType,
    sourceId: snapshot.sourceId,
    amount: isUsableAmount(snapshot.amount) ? snapshot.amount : 0,
    originalDueDate: snapshot.originalDueDate,
    expectedAction: snapshot.expectedAction,
    criticality: snapshot.criticality,
    observedDueDate: null as string | null,
    observedStatus: null as string | null,
  };

  if (!record) {
    return { ...base, verdict: "UNVERIFIABLE", countsAsProtected: false };
  }

  const observedDate = new Date(record.dueDate);
  const observedDueDate = dateOnly(observedDate);
  const observedStatus = record.status;
  const withObs = { ...base, observedDueDate, observedStatus };

  // Moved beyond what we can observe. Not a success, not a failure.
  if (Number.isFinite(observedDate.getTime()) && observedDate.getTime() > windowEnd.getTime()) {
    return { ...withObs, verdict: "BEYOND_WINDOW", countsAsProtected: false };
  }

  const originalDue = new Date(snapshot.originalDueDate);
  const movedLater =
    Number.isFinite(originalDue.getTime()) &&
    Number.isFinite(observedDate.getTime()) &&
    observedDate.getTime() - originalDue.getTime() >= DAY;

  switch (observedStatus) {
    case "PAID":
      // Paid late still counts as paid, but not as the plan working.
      return movedLater
        ? { ...withObs, verdict: "PAID_LATE", countsAsProtected: false }
        : { ...withObs, verdict: "PAID_ON_TIME", countsAsProtected: true };

    case "RESCHEDULED":
      // Only counts if the plan actually asked for this.
      return snapshot.expectedAction === "RESCHEDULE"
        ? { ...withObs, verdict: "RESCHEDULED", countsAsProtected: true }
        : { ...withObs, verdict: "PAID_LATE", countsAsProtected: false };

    case "PAUSED":
      return snapshot.expectedAction === "PAUSE"
        ? { ...withObs, verdict: "RESCHEDULED", countsAsProtected: true }
        : { ...withObs, verdict: "UNPAID", countsAsProtected: false };

    case "FAILED":
      return { ...withObs, verdict: "FAILED", countsAsProtected: false };

    case "SCHEDULED":
    case "PENDING":
      // Still outstanding. If its date has passed inside the window it is
      // unpaid; if it is still ahead of us it was protected up to now.
      return observedDate.getTime() <= Date.now()
        ? { ...withObs, verdict: "UNPAID", countsAsProtected: false }
        : { ...withObs, verdict: "PROTECTED", countsAsProtected: true };

    case "SUCCESS":
      return movedLater
        ? { ...withObs, verdict: "PAID_LATE", countsAsProtected: false }
        : { ...withObs, verdict: "PAID_ON_TIME", countsAsProtected: true };

    default:
      return { ...withObs, verdict: "UNVERIFIABLE", countsAsProtected: false };
  }
}

/**
 * Measures every snapshotted obligation against the live ledger.
 *
 * Reads the payout/transaction record by the id captured at decision time.
 * Anything it cannot resolve is UNVERIFIABLE, never assumed good.
 */
export async function measureObligationSnapshot(
  client: ObligationRecordReader,
  snapshot: unknown[],
  windowEnd: Date
): Promise<ObligationOutcome[]> {
  const results: ObligationOutcome[] = [];

  for (const raw of snapshot ?? []) {
    const entry = raw as ObligationSnapshotEntry;
    let record: { dueDate: Date | string; status: string } | null = null;
    try {
      if (entry.sourceType === "PAYOUT" && client?.payout?.findFirst) {
        const p = await client.payout.findFirst({ where: { id: entry.sourceId } });
        if (p) record = { dueDate: p.scheduledDate, status: p.status };
      } else if (client?.transaction?.findFirst) {
        const t = await client.transaction.findFirst({ where: { id: entry.sourceId } });
        if (t) record = { dueDate: t.expectedDate, status: t.status };
      }
    } catch {
      record = null; // UNVERIFIABLE rather than a guess.
    }

    results.push(classifyObligation(entry, record, windowEnd));
  }

  return results;
}

export interface ObligationSummary {
  total: number;
  /** DERIVED from evidence, never copied from the prediction. */
  protectedCount: number;
  breachedCount: number;
  unresolvedCount: number;
  byVerdict: Record<string, number>;
  /** True when at least one critical obligation was demonstrably breached. */
  criticalBreach: boolean;
}

/**
 * Aggregates measured verdicts.
 *
 * `protectedCount` is a count of obligations we have positive evidence for.
 * `unresolvedCount` covers everything still unobservable - it is deliberately
 * NOT folded into either the protected or breached bucket, because doing so
 * would turn an absence of evidence into a claim.
 */
export function summariseObligationOutcomes(outcomes: ObligationOutcome[]): ObligationSummary {
  const byVerdict: Record<string, number> = {};
  for (const o of outcomes) {
    byVerdict[o.verdict] = (byVerdict[o.verdict] ?? 0) + 1;
  }

  const unresolved = outcomes.filter(
    (o) => o.verdict === "BEYOND_WINDOW" || o.verdict === "UNVERIFIABLE"
  ).length;

  const breached = outcomes.filter(
    (o) => o.verdict === "UNPAID" || o.verdict === "FAILED" || o.verdict === "PAID_LATE"
  );

  return {
    total: outcomes.length,
    protectedCount: outcomes.filter((o) => o.countsAsProtected).length,
    breachedCount: breached.length,
    unresolvedCount: unresolved,
    byVerdict,
    criticalBreach: breached.some((o) => o.criticality === "CRITICAL" || o.criticality === "HIGH"),
  };
}

export { PROTECTED_VERDICTS };
