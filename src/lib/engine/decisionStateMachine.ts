import { DecisionStatus, DecisionEventType } from "../../../generated/prisma/client";
import { DecisionRow, DecisionWriter } from "../db/records";

/**
 * ============================================================================
 * DECISION STATE MACHINE  (Phase 14)
 * ============================================================================
 *
 * CashPilot has TWO deliberately separate state machines. They are not
 * duplicates of each other and neither is authoritative for the other's concern.
 *
 *   Decision.status    - the lifecycle of a HUMAN FINANCIAL DECISION.
 *                        Coarse-grained, one row per strategy, append-forward
 *                        only. Answers: "what did the business decide, and did
 *                        that decision reach a settled financial conclusion?"
 *
 *   AgentAction.status - the lifecycle of ONE MECHANICAL ACTION.
 *                        Fine-grained, many rows per decision. Answers: "what
 *                        physically happened when we tried to move this money?"
 *
 * WHY THERE IS NO `EXECUTING` DecisionStatus
 * ------------------------------------------
 * Execution is not an attribute of a decision; it is an attribute of the
 * individual actions the decision authorises. A decision with four actions can
 * be simultaneously mid-flight on one, settled on another and unknown on a
 * third - there is no single honest `EXECUTING` value for the parent row.
 * `ActionStatus.EXECUTING` and `ActionStatus.EXECUTION_UNKNOWN` are therefore
 * the authoritative execution states, and Decision.status only advances to
 * EXECUTED once execution has been *confirmed* for every action.
 *
 * Consequence (PRINCIPLE 4 & 10): a decision whose actions are EXECUTING or
 * EXECUTION_UNKNOWN stays at APPROVED. It is never promoted to EXECUTED on the
 * strength of a request having been sent, and never demoted to NOT_EXECUTED
 * merely because the result is unknown. The attempt is recorded in
 * `executionSnapshot.outcome`.
 */
const DECISION_TRANSITIONS: Record<DecisionStatus, DecisionStatus[]> = {
  // A freshly simulated decision awaiting presentation to a human.
  [DecisionStatus.GENERATED]: [
    DecisionStatus.PRESENTED,
    DecisionStatus.APPROVED,
    DecisionStatus.REJECTED,
    DecisionStatus.NOT_EXECUTED,
  ],

  // Shown to the operator, awaiting their call.
  [DecisionStatus.PRESENTED]: [
    DecisionStatus.APPROVED,
    DecisionStatus.REJECTED,
    DecisionStatus.NOT_EXECUTED,
  ],

  // Human authorised it. Execution may confirm (EXECUTED) or be refused /
  // fail outright (NOT_EXECUTED). An unknown result keeps it here.
  [DecisionStatus.APPROVED]: [
    DecisionStatus.EXECUTED,
    DecisionStatus.NOT_EXECUTED,
  ],

  // Human declined. The only forward step is recording what happened anyway.
  // REJECTED -> EXECUTED and REJECTED -> RECONCILED are forbidden.
  [DecisionStatus.REJECTED]: [DecisionStatus.OUTCOME_MEASURED],

  // Confirmed executed; reconciliation against external settlement follows.
  [DecisionStatus.EXECUTED]: [
    DecisionStatus.RECONCILED,
    DecisionStatus.NOT_RECONCILED,
    DecisionStatus.RECONCILIATION_MISMATCH,
    DecisionStatus.OUTCOME_MEASURED,
  ],

  // Execution was refused or failed. Nothing settled, so nothing to reconcile.
  [DecisionStatus.NOT_EXECUTED]: [DecisionStatus.OUTCOME_MEASURED],

  // Executed but settlement not yet observed. A late webhook may still resolve
  // this either way, so both reconciliation outcomes remain reachable.
  [DecisionStatus.NOT_RECONCILED]: [
    DecisionStatus.RECONCILED,
    DecisionStatus.RECONCILIATION_MISMATCH,
    DecisionStatus.OUTCOME_MEASURED,
  ],

  // Fully settled as predicted.
  [DecisionStatus.RECONCILED]: [DecisionStatus.OUTCOME_MEASURED],

  // Settled, but not for the amount/shape we predicted. A later corrective
  // webhook may still resolve it to RECONCILED.
  [DecisionStatus.RECONCILIATION_MISMATCH]: [
    DecisionStatus.RECONCILED,
    DecisionStatus.OUTCOME_MEASURED,
  ],

  // TERMINAL. History is closed. PRINCIPLE 13: never rewritten.
  [DecisionStatus.OUTCOME_MEASURED]: [],
};

export class InvalidDecisionTransitionError extends Error {
  readonly code = "INVALID_DECISION_TRANSITION";
  constructor(readonly from: DecisionStatus, readonly to: DecisionStatus) {
    super(`Invalid decision transition ${from} -> ${to}`);
    this.name = "InvalidDecisionTransitionError";
  }
}

/**
 * True if `next` is a permitted successor of `current`.
 * A self-transition is permitted (it is how idempotent retries land) but callers
 * must treat it as a no-op and must not overwrite immutable snapshots.
 */
export function validateDecisionTransition(
  current: DecisionStatus,
  next: DecisionStatus
): boolean {
  if (current === next) return true;
  return (DECISION_TRANSITIONS[current] ?? []).includes(next);
}

/** True when no further transition is possible. */
export function isTerminalDecisionStatus(status: DecisionStatus): boolean {
  return (DECISION_TRANSITIONS[status] ?? []).length === 0;
}

/** Exposed for documentation/tests; do not mutate. */
export function decisionTransitionMap(): Readonly<Record<DecisionStatus, DecisionStatus[]>> {
  return DECISION_TRANSITIONS;
}

/**
 * Guarded Decision status write.
 *
 * Reads the current status, refuses illegal transitions, and - critically -
 * refuses to overwrite immutable historical fields. Snapshot fields are
 * write-once: `baselineSnapshot`, `recommendedSnapshot` and `engineVersion` are
 * never accepted here at all, and `approvalSnapshot` / `executionSnapshot` are
 * only written when currently empty.
 *
 * Returns the updated decision, or null when the decision row does not exist.
 * Throws InvalidDecisionTransitionError when the transition is not permitted.
 *
 * `client` may be a PrismaClient or an interactive transaction client, so this
 * can participate in a caller's atomic block.
 */
export interface TransitionAudit {
  /** Defaults to a sensible event for `next` when omitted. */
  eventType?: DecisionEventType;
  actorType: "HUMAN" | "SYSTEM" | "WEBHOOK";
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Maps a target status onto its audit event when the caller does not specify. */
const STATUS_EVENT: Partial<Record<DecisionStatus, DecisionEventType>> = {
  [DecisionStatus.GENERATED]: DecisionEventType.GENERATED,
  [DecisionStatus.PRESENTED]: DecisionEventType.PRESENTED,
  [DecisionStatus.APPROVED]: DecisionEventType.APPROVED,
  [DecisionStatus.REJECTED]: DecisionEventType.REJECTED,
  [DecisionStatus.EXECUTED]: DecisionEventType.EXECUTED,
  [DecisionStatus.NOT_EXECUTED]: DecisionEventType.NOT_EXECUTED,
  [DecisionStatus.RECONCILED]: DecisionEventType.RECONCILED,
  [DecisionStatus.NOT_RECONCILED]: DecisionEventType.NOT_RECONCILED,
  [DecisionStatus.RECONCILIATION_MISMATCH]: DecisionEventType.RECONCILIATION_MISMATCH,
  [DecisionStatus.OUTCOME_MEASURED]: DecisionEventType.OUTCOME_MEASURED,
};

/**
 * Appends an audit event. Never updates or deletes an existing row.
 *
 * Callers pass a transaction client so the event and the status change it
 * describes commit together (PART 24) - if the event insert fails, the
 * transition rolls back with it, and the log can never disagree with state.
 */
export async function appendDecisionEvent(
  client: DecisionWriter,
  decision: { id: string; businessId: string },
  event: {
    eventType: DecisionEventType;
    fromStatus?: DecisionStatus | null;
    toStatus?: DecisionStatus | null;
    actorType: string;
    actorId?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<void> {
  if (!client?.decisionEvent?.create) return;
  await client.decisionEvent.create({
    data: {
      decisionId: decision.id,
      businessId: decision.businessId,
      eventType: event.eventType,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus ?? null,
      actorType: event.actorType,
      actorId: event.actorId ?? null,
      metadata: event.metadata ?? null,
    },
  });
}

export async function transitionDecision(
  client: DecisionWriter,
  where: { id?: string; strategyId?: string },
  next: DecisionStatus,
  data: Record<string, unknown> = {},
  options: { allowSnapshotOverwrite?: boolean; audit?: TransitionAudit } = {}
): Promise<DecisionRow | null> {
  if (!client?.decision) return null;

  // PART 24 - atomicity, applied centrally.
  //
  // The status write and its audit event must commit together. Rather than rely
  // on every call site remembering to open a transaction (only one of six did),
  // this wraps itself when handed a root client. A transaction client has no
  // `$transaction` method, so an already-transactional caller falls straight
  // through and still participates in the caller's transaction.
  if (typeof client.$transaction === "function") {
    return await client.$transaction((tx) =>
      transitionDecisionInner(tx, where, next, data, options)
    );
  }

  return await transitionDecisionInner(client, where, next, data, options);
}

async function transitionDecisionInner(
  client: DecisionWriter,
  where: { id?: string; strategyId?: string },
  next: DecisionStatus,
  data: Record<string, unknown> = {},
  options: { allowSnapshotOverwrite?: boolean; audit?: TransitionAudit } = {}
): Promise<DecisionRow | null> {
  if (!client?.decision) return null;

  const current = await client.decision.findFirst({ where });
  if (!current) return null;

  if (!validateDecisionTransition(current.status, next)) {
    throw new InvalidDecisionTransitionError(current.status, next);
  }

  // PRINCIPLE 13 / PART 8-10: prediction and baseline are write-once at creation.
  const forbidden = ["baselineSnapshot", "recommendedSnapshot", "engineVersion", "createdAt"];
  for (const key of forbidden) {
    if (key in data) {
      throw new Error(
        `Immutable historical field "${key}" cannot be rewritten after decision creation`
      );
    }
  }

  const payload: Record<string, unknown> = { ...data };

  // Write-once snapshots: the first approval and the first execution attempt are
  // the historical record. A duplicate request must not restamp who/when.
  if (!options.allowSnapshotOverwrite) {
    if ("approvalSnapshot" in payload && current.approvalSnapshot != null) {
      delete payload.approvalSnapshot;
    }
    if ("executionSnapshot" in payload && current.executionSnapshot != null) {
      delete payload.executionSnapshot;
    }
  }

  // A self-transition carrying no new data is a pure no-op. No event either:
  // an audit log should record what happened, not what was asked for twice.
  if (current.status === next && Object.keys(payload).length === 0) {
    return current;
  }

  payload.status = next;

  // Compare-and-set on the status we validated against, so a concurrent writer
  // cannot slip a different transition in between the read and the write.
  const result = await client.decision.updateMany({
    where: { ...where, status: current.status },
    data: payload,
  });

  if (result && result.count === 0) {
    const refetched = await client.decision.findFirst({ where });
    if (refetched && refetched.status === next) return refetched;
    throw new Error("Decision concurrently modified");
  }

  // PART 24: the event is written on the same client as the status change. When
  // that client is a transaction, a failure here rolls the transition back.
  if (current.status !== next || options.audit) {
    const eventType = options.audit?.eventType ?? STATUS_EVENT[next];
    if (eventType) {
      await appendDecisionEvent(client, { id: current.id, businessId: current.businessId }, {
        eventType,
        fromStatus: current.status,
        toStatus: next,
        actorType: options.audit?.actorType ?? "SYSTEM",
        actorId: options.audit?.actorId ?? null,
        metadata: options.audit?.metadata ?? null,
      });
    }
  }

  return await client.decision.findFirst({ where });
}
