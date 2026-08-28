import { Prisma } from "../../../generated/prisma/client";
import { logger } from "@/lib/observability";
import { FINANCIAL_CONFIG } from "@/lib/engine/financialConfig";
import {
  computePaymentBehavior,
  type PaymentBehavior,
  type PaymentObservation,
  type BehaviorOptions,
} from "./paymentBehavior";

/**
 * B-11 - assemble payment behaviour per counterparty from settled invoices.
 *
 * The model in `paymentBehavior.ts` is pure and takes observations as
 * arguments. This is the half that reads them out of the database: settled
 * invoices (B-10 gave them a `paidAt`) grouped by the canonical counterparty
 * (P4 gave them a `counterpartyId`).
 *
 * Both of those are required. An invoice with no `paidAt` is not an
 * observation - we do not know when the money arrived - and an invoice with no
 * `counterpartyId` cannot be attributed to anyone. Neither is guessed at; they
 * are simply excluded, and the exclusions are reported so an operator can see
 * how much history is going unused.
 */

export type BehaviorClient = Pick<Prisma.TransactionClient, "invoice">;

export interface LoadBehaviorOptions extends BehaviorOptions {
  /** How far back to read history. Defaults to the configured behaviour window. */
  lookbackDays?: number;
  /** Safety bound on rows read in one pass. */
  maxInvoices?: number;
}

export interface BehaviorLoadResult {
  /** Behaviour keyed by canonical counterparty id. */
  byCounterparty: Map<string, PaymentBehavior>;
  /** Settled invoices actually used. */
  observationsUsed: number;
  /** Settled invoices skipped because they carry no counterparty link (B-4). */
  skippedUnlinked: number;
  /** Counterparties with history but not enough of it to act on. */
  counterpartiesWithoutOpinion: number;
}

/** Rows read this deep in one pass; beyond it the oldest history is dropped. */
const DEFAULT_MAX_INVOICES = 5000;

/**
 * Load payment behaviour for every counterparty this tenant has settled
 * history for.
 *
 * Tenant-scoped at the query (spec §47). Returns an empty map rather than
 * throwing when there is no history - "we do not know how this customer pays"
 * is a normal state, not an error.
 *
 * Grouping is by `Invoice.counterpartyId` directly. That is correct even after
 * a merge, because `mergeCounterparties` relinks the losing entity's invoices
 * to the survivor in the same transaction, so a stored link always points at a
 * live entity.
 */
export async function loadPaymentBehavior(
  client: BehaviorClient,
  tenantId: string,
  options: LoadBehaviorOptions = {}
): Promise<BehaviorLoadResult> {
  if (!tenantId) throw new Error("loadPaymentBehavior requires a tenantId.");

  const now = options.now ?? new Date();
  const lookbackDays = options.lookbackDays ?? FINANCIAL_CONFIG.BEHAVIOR_HISTORY_LOOKBACK_DAYS;
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const invoices = await client.invoice.findMany({
    where: {
      businessId: tenantId,
      status: "PAID",
      // Both are required for an invoice to be an observation at all. Filtering
      // in the query rather than in memory keeps the read bounded by useful
      // rows instead of by every invoice the tenant has ever had.
      paidAt: { not: null, gte: since },
    },
    select: { id: true, amount: true, dueDate: true, paidAt: true, counterpartyId: true },
    orderBy: { paidAt: "desc" },
    take: options.maxInvoices ?? DEFAULT_MAX_INVOICES,
  });

  const grouped = new Map<string, PaymentObservation[]>();
  let skippedUnlinked = 0;

  for (const inv of invoices) {
    if (!inv.counterpartyId) {
      // Settled, but not attributable to anyone. Counted, never guessed at.
      skippedUnlinked++;
      continue;
    }
    if (!inv.paidAt || !inv.dueDate) continue;

    const list = grouped.get(inv.counterpartyId) ?? [];
    list.push({
      id: inv.id,
      amount: inv.amount,
      dueDate: inv.dueDate,
      paidDate: inv.paidAt,
    });
    grouped.set(inv.counterpartyId, list);
  }

  const byCounterparty = new Map<string, PaymentBehavior>();
  let observationsUsed = 0;
  let counterpartiesWithoutOpinion = 0;

  for (const [counterpartyId, observations] of grouped) {
    const behavior = computePaymentBehavior(observations, { ...options, now });
    byCounterparty.set(counterpartyId, behavior);
    observationsUsed += observations.length;
    if (behavior.sufficiency !== "SUFFICIENT") counterpartiesWithoutOpinion++;
  }

  logger.info("BEHAVIOR_MODEL_BUILT", {
    businessId: tenantId,
    counterparties: byCounterparty.size,
    observationsUsed,
    skippedUnlinked,
    counterpartiesWithoutOpinion,
    lookbackDays,
  });

  return { byCounterparty, observationsUsed, skippedUnlinked, counterpartiesWithoutOpinion };
}
