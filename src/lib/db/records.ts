import type { DecisionStatus } from "../../../generated/prisma/client";

/**
 * Structural shapes for the records the engine reads.
 *
 * The engine is deliberately typed against the FIELDS IT USES rather than
 * against PrismaClient. Three reasons:
 *
 *  1. It makes the read surface visible. A reader that declares only
 *     `findMany` cannot write, and that is checked rather than trusted.
 *  2. The base client, a transaction client, and a test fake all satisfy the
 *     same interface, so tests exercise the real signature instead of `any`.
 *  3. A schema change that removes a field the engine depends on becomes a
 *     compile error here, at the boundary, instead of `undefined` arriving in
 *     the middle of an arithmetic expression.
 *
 * Dates are `Date | string` because a value that has round-tripped through Json
 * arrives as a string, and every consumer already re-wraps with `new Date()`.
 * They are NOT nullable: the schema declares both columns NOT NULL. Engine code
 * still guards against a missing date, because these records also arrive from
 * Json snapshots and fixtures, but such a record is malformed by definition and
 * is excluded rather than defaulted.
 */

export interface PayoutRecord {
  id: string;
  amount: number;
  scheduledDate: Date | string;
  status: string;
  vendor?: string | null;
  criticality?: string | null;
}

export interface TransactionRecord {
  id: string;
  amount: number;
  type: string;
  status: string;
  expectedDate: Date | string;
  description?: string | null;
}

/**
 * A read-only view of the two tables cash-position logic depends on.
 *
 * Both properties are optional: unit tests routinely supply a partial client,
 * and the engine's contract is to degrade to a stated low-confidence result
 * rather than throw when a table is unavailable.
 */
export interface FindManyArgs {
  where?: Record<string, unknown>;
  orderBy?: unknown;
  take?: number;
  skip?: number;
}

export interface FinancialRecordReader {
  transaction?: {
    findMany(args?: FindManyArgs): Promise<TransactionRecord[]>;
  };
  payout?: {
    findMany(args?: FindManyArgs): Promise<PayoutRecord[]>;
  };
}

export interface BusinessRecord {
  id: string;
  currentCash?: number | null;
}

/** Adds the business row to the financial reader, for context fingerprinting. */
export interface DecisionContextReader extends FinancialRecordReader {
  business: {
    findUnique(args: { where: { id: string } }): Promise<BusinessRecord | null>;
  };
}

/** The decision fields the state machine reads before deciding a transition. */
export interface DecisionRow {
  id: string;
  businessId: string;
  status: DecisionStatus;
  approvalSnapshot?: unknown;
  executionSnapshot?: unknown;
  [field: string]: unknown;
}

/**
 * The write surface the decision state machine needs.
 *
 * `$transaction` is optional on purpose. A transaction client does not have it,
 * and that absence is exactly how transitionDecision detects that it is already
 * inside someone else's transaction and should not open a second one.
 */
export interface DecisionWriter {
  decision?: {
    findFirst(args: { where: Record<string, unknown> }): Promise<DecisionRow | null>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  decisionEvent?: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  $transaction?: <T>(fn: (tx: DecisionWriter) => Promise<T>) => Promise<T>;
}
