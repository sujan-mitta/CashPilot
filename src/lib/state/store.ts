import { Prisma, FinancialState } from "../../../generated/prisma/client";
import { logger } from "@/lib/observability";
import type { FinancialStateSnapshot } from "./financialState";

/**
 * Phase 6 - materialise the Unified Financial State (spec §18, §19).
 *
 * Append-only: a state row is never updated. A changed reality inserts a NEW
 * row at the next `stateVersion`, so the history of what CashPilot believed
 * stays answerable forever (spec §45, §46).
 *
 * Materialisation is idempotent on CONTENT, not on time. Calling it repeatedly
 * with an unchanged financial reality returns the existing state and writes
 * nothing - otherwise a polling job would mint a new version every tick and
 * `stateVersion` would measure how often we looked rather than how often
 * anything changed.
 *
 * Every query is `businessId`-scoped (spec §47).
 */

export type FinancialStateClient = Pick<Prisma.TransactionClient, "financialState">;

const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Bounded retries for the version race. Each attempt re-reads the latest state,
 * so a competing writer either turns out to have stored OUR content (we return
 * theirs) or occupies the version we wanted (we take the next one).
 */
const MAX_VERSION_ATTEMPTS = 5;

export interface MaterializeResult {
  state: FinancialState;
  /** True when this call inserted a new version. */
  created: boolean;
  /** True when an identical state already existed and nothing was written. */
  unchanged: boolean;
}

/** The tenant's current state, or null if none has ever been materialised. */
export async function getLatestFinancialState(
  client: FinancialStateClient,
  tenantId: string
): Promise<FinancialState | null> {
  if (!tenantId) throw new Error("getLatestFinancialState requires a tenantId.");
  return client.financialState.findFirst({
    where: { businessId: tenantId },
    orderBy: { stateVersion: "desc" },
  });
}

/** A specific historical state. Tenant-scoped: an id alone is not authorisation. */
export async function getFinancialStateVersion(
  client: FinancialStateClient,
  tenantId: string,
  stateVersion: number
): Promise<FinancialState | null> {
  if (!tenantId) throw new Error("getFinancialStateVersion requires a tenantId.");
  return client.financialState.findFirst({
    where: { businessId: tenantId, stateVersion },
  });
}

/**
 * Store a computed snapshot as the tenant's next state, unless it is identical
 * to the current one.
 *
 * Returns `unchanged: true` and the existing row when the content hash matches,
 * which is the common case for a periodic recompute.
 */
export async function materializeFinancialState(
  client: FinancialStateClient,
  tenantId: string,
  snapshot: FinancialStateSnapshot
): Promise<MaterializeResult> {
  if (!tenantId) throw new Error("materializeFinancialState requires a tenantId.");

  for (let attempt = 0; attempt < MAX_VERSION_ATTEMPTS; attempt++) {
    const latest = await getLatestFinancialState(client, tenantId);

    if (latest && latest.stateHash === snapshot.stateHash) {
      // Same reality. Do not advance the version, do not write a row.
      return { state: latest, created: false, unchanged: true };
    }

    const nextVersion = (latest?.stateVersion ?? 0) + 1;

    try {
      const state = await client.financialState.create({
        data: {
          businessId: tenantId,
          stateVersion: nextVersion,
          stateHash: snapshot.stateHash,
          asOf: new Date(snapshot.asOf),
          cashPosition: snapshot.cashPosition,
          receivables: snapshot.receivables,
          payables: snapshot.payables,
          expectedInflows: snapshot.expectedInflows,
          expectedOutflows: snapshot.expectedOutflows,
          activeCommitments: snapshot.activeCommitments,
          requiredBuffer: snapshot.requiredBuffer,
          projectedMinimumBalance: snapshot.projectedMinimumBalance,
          riskState: snapshot.riskState,
          // Written out field by field rather than cast, so a change to the
          // summary shape is a compile error here instead of silent JSON drift.
          reconciliation: snapshot.reconciliation
            ? {
                total: snapshot.reconciliation.total,
                reconciled: snapshot.reconciliation.reconciled,
                conflicts: snapshot.reconciliation.conflicts,
                missing: snapshot.reconciliation.missing,
                unknown: snapshot.reconciliation.unknown,
              }
            : Prisma.JsonNull,
          detail: {
            components: snapshot.components,
            horizonDays: snapshot.horizonDays,
          },
          evidenceRefs: snapshot.evidenceRefs,
        },
      });

      logger.info("STATE_UPDATED", {
        businessId: tenantId,
        financialStateId: state.id,
        stateVersion: state.stateVersion,
        riskState: state.riskState,
      });

      return { state, created: true, unchanged: false };
    } catch (err) {
      // Someone else took this version number. Re-read and decide again: their
      // state may be identical to ours, in which case there is nothing to write.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  throw new Error(
    `Could not materialise financial state for ${tenantId} after ${MAX_VERSION_ATTEMPTS} attempts.`
  );
}
