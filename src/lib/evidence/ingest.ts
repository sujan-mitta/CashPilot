import {
  recordClaimWithEvidence,
  type ClaimEvidenceClient,
  type ClaimDescriptor,
  type EvidenceDescriptor,
  type ClaimWithEvidenceResult,
} from "./store";

/**
 * Phase 2 - derive Claims + Evidence from the existing domain rows.
 *
 * These are the first "sources": the invoice/transaction/payout tables the app
 * already maintains. The mappers are PURE (row -> descriptors) so they are
 * trivially testable; the ingest* wrappers persist via the idempotent store.
 *
 * Nothing calls these in production yet (Phase 2 is additive). A one-off
 * backfill runner over existing rows is a follow-up, and requires the Phase 2
 * migration to be applied first.
 *
 * Claim typing is deliberate (spec §13): an invoice is a CONTRACTUAL assertion,
 * a settled transaction is ACTUAL, a failed expected inflow is CONTRADICTED, a
 * pending one is EXPECTED. We never store a prediction as a fact.
 */

export interface InvoiceRow {
  id: string;
  customerName: string;
  amount: number; // paise
  dueDate: Date;
  status: "PAID" | "OVERDUE" | "PENDING";
}

export interface TransactionRow {
  id: string;
  amount: number; // paise
  type: "INFLOW" | "OUTFLOW";
  status: "SUCCESS" | "FAILED" | "PENDING";
  description?: string | null;
  expectedDate: Date;
}

export interface PayoutRow {
  id: string;
  vendor: string;
  amount: number; // paise
  scheduledDate: Date;
  criticality: "HIGH" | "MEDIUM" | "LOW";
  status: "SCHEDULED" | "PAID" | "RESCHEDULED" | "PAUSED";
}

export interface DerivedClaim {
  claim: ClaimDescriptor;
  evidence: EvidenceDescriptor[];
}

/** An invoice asserts a contractual obligation with a due date. */
export function deriveFromInvoice(inv: InvoiceRow, observedAt: Date): DerivedClaim {
  return {
    claim: {
      claimType: "CONTRACTUAL",
      subjectType: "INVOICE",
      subjectId: inv.id,
      amount: inv.amount,
      effectiveAt: inv.dueDate,
      assertion: {
        customerName: inv.customerName,
        amount: inv.amount,
        dueDate: inv.dueDate.toISOString(),
        status: inv.status,
      },
    },
    evidence: [
      {
        sourceType: "ERP",
        sourceRecordId: inv.id,
        evidenceType: "ERP_INVOICE",
        observedAt,
        effectiveAt: inv.dueDate,
      },
    ],
  };
}

/** A transaction's claim type follows its settlement status. */
export function deriveFromTransaction(tx: TransactionRow, observedAt: Date): DerivedClaim {
  const claimType =
    tx.status === "SUCCESS" ? "ACTUAL" : tx.status === "FAILED" ? "CONTRADICTED" : "EXPECTED";
  return {
    claim: {
      claimType,
      subjectType: "TRANSACTION",
      subjectId: tx.id,
      amount: tx.amount,
      effectiveAt: tx.expectedDate,
      assertion: {
        type: tx.type,
        amount: tx.amount,
        status: tx.status,
        expectedDate: tx.expectedDate.toISOString(),
        description: tx.description ?? null,
      },
    },
    evidence: [
      {
        sourceType: "BANK",
        sourceRecordId: tx.id,
        evidenceType: "BANK_TRANSACTION",
        observedAt,
        effectiveAt: tx.expectedDate,
      },
    ],
  };
}

/** A payout is a contractual outflow obligation until it actually settles. */
export function deriveFromPayout(po: PayoutRow, observedAt: Date): DerivedClaim {
  const claimType = po.status === "PAID" ? "ACTUAL" : "CONTRACTUAL";
  return {
    claim: {
      claimType,
      subjectType: "PAYOUT",
      subjectId: po.id,
      amount: po.amount,
      effectiveAt: po.scheduledDate,
      assertion: {
        vendor: po.vendor,
        amount: po.amount,
        scheduledDate: po.scheduledDate.toISOString(),
        criticality: po.criticality,
        status: po.status,
      },
    },
    evidence: [
      {
        sourceType: "ERP",
        sourceRecordId: po.id,
        evidenceType: "ERP_PAYOUT",
        observedAt,
        effectiveAt: po.scheduledDate,
      },
    ],
  };
}

export function ingestInvoice(
  client: ClaimEvidenceClient,
  tenantId: string,
  inv: InvoiceRow,
  now: Date = new Date()
): Promise<ClaimWithEvidenceResult> {
  const { claim, evidence } = deriveFromInvoice(inv, now);
  return recordClaimWithEvidence(client, tenantId, claim, evidence, now);
}

export function ingestTransaction(
  client: ClaimEvidenceClient,
  tenantId: string,
  tx: TransactionRow,
  now: Date = new Date()
): Promise<ClaimWithEvidenceResult> {
  const { claim, evidence } = deriveFromTransaction(tx, now);
  return recordClaimWithEvidence(client, tenantId, claim, evidence, now);
}

export function ingestPayout(
  client: ClaimEvidenceClient,
  tenantId: string,
  po: PayoutRow,
  now: Date = new Date()
): Promise<ClaimWithEvidenceResult> {
  const { claim, evidence } = deriveFromPayout(po, now);
  return recordClaimWithEvidence(client, tenantId, claim, evidence, now);
}
