import { Prisma } from "../../../generated/prisma/client";
import { logger } from "@/lib/observability";
import { calculateLiquiditySafetyRequirement } from "@/lib/engine/liquiditySafety";
import {
  backfillInvoiceCounterparties,
  backfillPayoutCounterparties,
  type CounterpartyBackfillClient,
} from "@/lib/entities/store";
import {
  ingestInvoice,
  ingestTransaction,
  ingestPayout,
  type InvoiceRow,
  type TransactionRow,
  type PayoutRow,
} from "@/lib/evidence/ingest";
import type { ClaimEvidenceClient } from "@/lib/evidence/store";
import { runReconciliation, type ReconciliationRunClient } from "@/lib/evidence/reconciliationRun";
import { computeFinancialState, type ReconciliationSummary } from "@/lib/state/financialState";
import { materializeFinancialState, type FinancialStateClient } from "@/lib/state/store";

/**
 * The one entry point that actually RUNS the unified financial brain.
 *
 * Phases 1-10 each landed as an additive library with no caller, which was the
 * right way to build them and the wrong way to leave them: the entity
 * resolution, claim/evidence ingest, cross-source reconciliation and state
 * materialisation were all implemented, tested, and invoked by nothing. This is
 * what invokes them, in the only order that makes sense:
 *
 *   1. ENTITIES     - resolve customers and suppliers, so history has an owner
 *   2. CLAIMS       - derive claims + evidence from the domain rows
 *   3. RECONCILE    - cross-check sources, write consistency back to evidence
 *   4. STATE        - materialise the unified state, carrying the rollup from 3
 *
 * Each stage feeds the next, which is why the order is fixed rather than
 * convenient: claims about an invoice are more useful once the invoice has a
 * counterparty, and the state's reconciliation summary is a product of stage 3.
 *
 * ## Safety
 *
 * Every stage is idempotent, so this is safe to re-run and safe to interrupt -
 * a second run resumes rather than duplicating. It is NOT wrapped in one
 * transaction on purpose: a full-tenant sync can be long, and holding a write
 * transaction across it would block the money path. Partial progress is a
 * correct intermediate state here precisely because each stage is idempotent.
 *
 * Nothing here moves money, calls a provider, or changes an existing financial
 * value. It writes to the additive tables and to the two derived columns on
 * Evidence, and it links `counterpartyId`, which no engine code reads.
 */

export type BrainSyncClient = CounterpartyBackfillClient &
  ClaimEvidenceClient &
  ReconciliationRunClient &
  FinancialStateClient &
  Pick<Prisma.TransactionClient, "transaction" | "business">;

export interface BrainSyncOptions {
  now?: Date;
  /** Skip a stage. Useful for a first cautious run. */
  skipEntities?: boolean;
  skipClaims?: boolean;
  skipReconciliation?: boolean;
  skipState?: boolean;
  /** Compute everything but write nothing that is not already idempotent. */
  dryRunReconciliation?: boolean;
}

export interface BrainSyncResult {
  businessId: string;
  entities: {
    customersLinked: number;
    suppliersLinked: number;
    created: number;
    unresolved: number;
    mergeSuggestions: number;
  } | null;
  claims: {
    invoices: number;
    transactions: number;
    payouts: number;
    claimsCreated: number;
    evidenceCreated: number;
  } | null;
  reconciliation: ReconciliationSummary | null;
  evidenceRescored: number;
  state: {
    stateVersion: number;
    riskState: string;
    created: boolean;
    unchanged: boolean;
  } | null;
}

/**
 * Bring a tenant's unified financial brain up to date with its ledger.
 *
 * Tenant-scoped throughout (spec §47): every read and every write carries the
 * businessId, and the stages it delegates to enforce it again themselves.
 */
export async function syncFinancialBrain(
  client: BrainSyncClient,
  tenantId: string,
  options: BrainSyncOptions = {}
): Promise<BrainSyncResult> {
  if (!tenantId) throw new Error("syncFinancialBrain requires a tenantId.");
  const now = options.now ?? new Date();

  const [business, invoices, transactions, payouts] = await Promise.all([
    client.business.findUnique({ where: { id: tenantId } }),
    client.invoice.findMany({ where: { businessId: tenantId } }),
    client.transaction.findMany({ where: { businessId: tenantId } }),
    client.payout.findMany({ where: { businessId: tenantId } }),
  ]);

  if (!business) throw new Error(`No business ${tenantId}.`);

  const result: BrainSyncResult = {
    businessId: tenantId,
    entities: null,
    claims: null,
    reconciliation: null,
    evidenceRescored: 0,
    state: null,
  };

  // --- 1. Entities --------------------------------------------------------
  // Names first, so every later stage can attribute what it records. A
  // near-match is never merged automatically; suggestions are counted and
  // reported for a human (see entities/resolver.ts).
  if (!options.skipEntities) {
    const customers = await backfillInvoiceCounterparties(
      client,
      tenantId,
      invoices.map((i) => ({ id: i.id, name: i.customerName }))
    );
    const suppliers = await backfillPayoutCounterparties(
      client,
      tenantId,
      payouts.map((p) => ({ id: p.id, name: p.vendor }))
    );

    result.entities = {
      customersLinked: customers.linked,
      suppliersLinked: suppliers.linked,
      created: customers.createdCounterparties + suppliers.createdCounterparties,
      unresolved: customers.unresolved.length + suppliers.unresolved.length,
      mergeSuggestions: customers.mergeSuggestions.length + suppliers.mergeSuggestions.length,
    };
  }

  // --- 2. Claims + evidence ----------------------------------------------
  // The domain rows are the first "source". Claim TYPE follows the row's own
  // status, so a prediction is never recorded as a fact (spec §13).
  if (!options.skipClaims) {
    let claimsCreated = 0;
    let evidenceCreated = 0;

    for (const inv of invoices) {
      const r = await ingestInvoice(client, tenantId, toInvoiceRow(inv), now);
      if (r.claimCreated) claimsCreated++;
      evidenceCreated += r.evidenceCreated;
    }
    for (const t of transactions) {
      const r = await ingestTransaction(client, tenantId, toTransactionRow(t), now);
      if (r.claimCreated) claimsCreated++;
      evidenceCreated += r.evidenceCreated;
    }
    for (const p of payouts) {
      const r = await ingestPayout(client, tenantId, toPayoutRow(p), now);
      if (r.claimCreated) claimsCreated++;
      evidenceCreated += r.evidenceCreated;
    }

    result.claims = {
      invoices: invoices.length,
      transactions: transactions.length,
      payouts: payouts.length,
      claimsCreated,
      evidenceCreated,
    };
  }

  // --- 3. Cross-source reconciliation ------------------------------------
  // Also re-derives evidence confidence now that cross-source agreement is
  // measurable, which is the dimension Phase 3 had to leave null.
  if (!options.skipReconciliation) {
    const recon = await runReconciliation(client, tenantId, {
      now,
      dryRun: options.dryRunReconciliation,
    });
    result.reconciliation = recon.summary;
    result.evidenceRescored = recon.evidenceUpdated;
  }

  // --- 4. Unified financial state ----------------------------------------
  if (!options.skipState) {
    // The buffer comes from the engine's own calculation, never a local rule.
    const safety = await calculateLiquiditySafetyRequirement(tenantId, client, now);

    const snapshot = computeFinancialState({
      currentCash: business.currentCash,
      transactions,
      invoices,
      payouts,
      requiredBuffer: safety.requiredBuffer,
      today: now,
      reconciliation: result.reconciliation,
    });

    const stored = await materializeFinancialState(client, tenantId, snapshot);
    result.state = {
      stateVersion: stored.state.stateVersion,
      riskState: stored.state.riskState,
      created: stored.created,
      unchanged: stored.unchanged,
    };
  }

  logger.info("BRAIN_SYNC_COMPLETED", {
    businessId: tenantId,
    entitiesCreated: result.entities?.created ?? null,
    mergeSuggestions: result.entities?.mergeSuggestions ?? null,
    claimsCreated: result.claims?.claimsCreated ?? null,
    conflicts: result.reconciliation?.conflicts ?? null,
    missing: result.reconciliation?.missing ?? null,
    evidenceRescored: result.evidenceRescored,
    stateVersion: result.state?.stateVersion ?? null,
  });

  return result;
}

/**
 * The mappers below narrow a Prisma row to the structural shape each ingest
 * function declares. Written out rather than cast so a schema change that drops
 * a field these depend on is a compile error here, at the boundary.
 */
function toInvoiceRow(i: {
  id: string;
  customerName: string;
  amount: number;
  dueDate: Date;
  status: string;
}): InvoiceRow {
  return {
    id: i.id,
    customerName: i.customerName,
    amount: i.amount,
    dueDate: i.dueDate,
    status: i.status as InvoiceRow["status"],
  };
}

function toTransactionRow(t: {
  id: string;
  amount: number;
  type: string;
  status: string;
  description: string | null;
  expectedDate: Date;
}): TransactionRow {
  return {
    id: t.id,
    amount: t.amount,
    type: t.type as TransactionRow["type"],
    status: t.status as TransactionRow["status"],
    description: t.description,
    expectedDate: t.expectedDate,
  };
}

function toPayoutRow(p: {
  id: string;
  vendor: string;
  amount: number;
  scheduledDate: Date;
  criticality: string;
  status: string;
}): PayoutRow {
  return {
    id: p.id,
    vendor: p.vendor,
    amount: p.amount,
    scheduledDate: p.scheduledDate,
    criticality: p.criticality as PayoutRow["criticality"],
    status: p.status as PayoutRow["status"],
  };
}
