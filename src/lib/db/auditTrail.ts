import type { Prisma } from "../../../generated/prisma/client";

/**
 * ===========================================================================
 * APPEND-ONLY ACTION AUDIT
 * ===========================================================================
 *
 * `AgentAction.auditLog` is documented as append-only, and every write path
 * except one honoured that. `/api/approve` assigned a fresh single-entry array
 * instead, because `updateMany` cannot append per row - so approving or
 * rejecting an action erased whatever history it already had.
 *
 * It happened to be harmless in practice (approve only touched PENDING rows,
 * which have no history yet), but a guarantee that holds only by coincidence is
 * not a guarantee. This appends, one row at a time.
 */

export interface AuditEntry {
  /** userId for a human, or a SYSTEM_* actor string. */
  who: string;
  what: string;
  /** ISO 8601. */
  when: string;
  why: string;
  result: string;
  [key: string]: unknown;
}

/** The subset of an AgentAction this helper needs. */
export interface AuditableAction {
  id: string;
  auditLog: unknown;
}

/**
 * Appends one entry to each action's audit log.
 *
 * `entry` is applied per row rather than shared by reference, so a caller
 * cannot mutate an entry after the fact and change history retroactively.
 * Errors are NOT swallowed: this runs inside the same transaction as the status
 * change it describes, and a state change whose audit entry failed to write is
 * precisely the divergence the append-only rule exists to prevent.
 */
export async function appendAuditToActions(
  tx: Prisma.TransactionClient,
  actions: readonly AuditableAction[],
  entry: AuditEntry
): Promise<void> {
  for (const action of actions) {
    const existing = Array.isArray(action.auditLog) ? action.auditLog : [];
    await tx.agentAction.update({
      where: { id: action.id },
      data: {
        auditLog: [...existing, { ...entry }] as Prisma.InputJsonValue,
      },
    });
  }
}

/** Single-row form, for callers that already hold one fresh action. */
export function appendAuditEntry(existingLog: unknown, entry: AuditEntry): Prisma.InputJsonValue {
  const existing = Array.isArray(existingLog) ? existingLog : [];
  return [...existing, { ...entry }] as Prisma.InputJsonValue;
}
