import { Prisma, Counterparty, CounterpartyType } from "../../../generated/prisma/client";
import { logger } from "@/lib/observability";
import {
  resolveCounterpartyName,
  isAutomaticMatch,
  type ResolutionDecision,
  type ResolveOptions,
} from "./resolver";

/**
 * Phase 4 - idempotent persistence for canonical counterparties (spec §8).
 *
 * Resolution is read-mostly and must be safe to run repeatedly: ingesting the
 * same invoice ten times, or re-syncing a source, must converge on ONE entity.
 * Every write here is therefore create-or-resolve, and every query is scoped by
 * `businessId` (spec §47) - the resolver itself cannot enforce tenancy, so the
 * boundary lives in this file.
 *
 * Nothing in the existing engine reads counterparties yet: Phase 4 is additive
 * in exactly the way Phases 1-3 were.
 */

export type CounterpartyClient = Pick<
  Prisma.TransactionClient,
  "counterparty" | "counterpartyAlias"
>;

/** Merging has to relink the rows that pointed at the losing entity. */
export type CounterpartyMergeClient = CounterpartyClient &
  Pick<Prisma.TransactionClient, "invoice" | "payout">;

/** Backfill links existing Invoice/Payout rows to the entities it resolves. */
export type CounterpartyBackfillClient = CounterpartyClient &
  Pick<Prisma.TransactionClient, "invoice" | "payout">;

const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/** A merge chain longer than this is a data bug, not a deep hierarchy. */
const MAX_MERGE_DEPTH = 16;

export interface ResolveCounterpartyInput {
  type: CounterpartyType;
  /** The name exactly as the source wrote it. */
  rawName: string;
  /** Where the spelling came from: "ERP" | "BANK" | "RAZORPAY" | "USER" | ... */
  sourceType: string;
}

export interface ResolveCounterpartyOptions extends ResolveOptions {
  /**
   * When resolution finds no *safe* match, create a new entity (default true).
   *
   * Note what this deliberately does NOT do: a CANDIDATE or AMBIGUOUS outcome
   * still creates a SEPARATE entity rather than joining the near-match. Keeping
   * two spellings apart is trivially reversible by a merge; joining two real
   * companies is not (see resolver.ts). The near-matches come back on the
   * decision so a human can confirm the merge.
   */
  autoCreate?: boolean;
}

export interface ResolveCounterpartyResult {
  /** Null when the name was unresolvable, or when autoCreate was disabled. */
  counterparty: Counterparty | null;
  decision: ResolutionDecision;
  /** True when this call created the entity. */
  created: boolean;
}

/**
 * Follow `mergedIntoId` to the surviving entity.
 *
 * Merged rows are kept forever (spec §46), so any stored counterparty id may
 * point at a superseded identity; every read path funnels through here. Throws
 * on a cycle rather than looping, because silently returning a merged-away
 * entity would attach new financial history to a dead identity.
 */
export async function resolveCanonicalCounterparty(
  client: CounterpartyClient,
  tenantId: string,
  counterpartyId: string
): Promise<Counterparty | null> {
  const seen = new Set<string>();
  let currentId: string | null = counterpartyId;

  for (let depth = 0; depth < MAX_MERGE_DEPTH; depth++) {
    if (currentId === null) return null;
    if (seen.has(currentId)) {
      throw new Error(`Counterparty merge cycle detected at ${currentId}.`);
    }
    seen.add(currentId);

    // Tenant scoping is part of the lookup, not a post-hoc check.
    const row: Counterparty | null = await client.counterparty.findFirst({
      where: { id: currentId, businessId: tenantId },
    });
    if (!row) return null;
    if (!row.mergedIntoId) return row;
    currentId = row.mergedIntoId;
  }

  throw new Error(`Counterparty merge chain exceeded ${MAX_MERGE_DEPTH} hops from ${counterpartyId}.`);
}

/**
 * Resolve a raw source name to a canonical counterparty, creating one when the
 * name is genuinely new.
 *
 * Idempotent on (businessId, type, normalizedName): the same name resolves to
 * the same entity on every call, including under concurrency - a losing insert
 * hits the unique constraint and re-reads the winner rather than failing.
 */
export async function resolveCounterparty(
  client: CounterpartyClient,
  tenantId: string,
  input: ResolveCounterpartyInput,
  options: ResolveCounterpartyOptions = {}
): Promise<ResolveCounterpartyResult> {
  if (!tenantId) throw new Error("resolveCounterparty requires a tenantId.");
  if (!input.sourceType) throw new Error("resolveCounterparty requires a sourceType.");

  const autoCreate = options.autoCreate ?? true;

  // Scoped to this tenant AND this type. Merged-away entities are excluded so a
  // resolution can never return a superseded identity.
  const [known, aliases] = await Promise.all([
    client.counterparty.findMany({
      where: { businessId: tenantId, type: input.type, mergedIntoId: null },
      select: { id: true, displayName: true, normalizedName: true },
    }),
    client.counterpartyAlias.findMany({
      where: { businessId: tenantId, type: input.type },
      select: { counterpartyId: true, normalizedName: true },
    }),
  ]);

  const decision = resolveCounterpartyName(input.rawName, known, aliases, options);

  if (decision.method === "UNRESOLVABLE") {
    logger.info("ENTITY_UNRESOLVABLE", {
      businessId: tenantId,
      type: input.type,
      sourceType: input.sourceType,
    });
    return { counterparty: null, decision, created: false };
  }

  if (isAutomaticMatch(decision.method) && decision.matchedId) {
    // An alias can point at an entity that was later merged; follow the chain.
    const canonical = await resolveCanonicalCounterparty(client, tenantId, decision.matchedId);
    if (canonical) {
      if (decision.method === "EXACT") {
        // Record the spelling so the next lookup is a single indexed alias hit.
        await ensureAlias(client, tenantId, canonical.id, input, decision.normalizedName, "EXACT");
      }
      logger.info("ENTITY_RESOLVED", {
        businessId: tenantId,
        counterpartyId: canonical.id,
        type: input.type,
        method: decision.method,
        sourceType: input.sourceType,
      });
      return { counterparty: canonical, decision, created: false };
    }
    // The alias pointed at nothing readable for this tenant - fall through and
    // treat the name as new rather than returning a match we cannot verify.
  }

  if (decision.candidates.length > 0) {
    // Surfaced, never applied. A human confirms the merge (spec §34).
    logger.info("ENTITY_MERGE_SUGGESTED", {
      businessId: tenantId,
      type: input.type,
      method: decision.method,
      candidateIds: decision.candidates.map((c) => c.id),
      topSimilarity: decision.candidates[0].similarity,
    });
  }

  if (!autoCreate) {
    return { counterparty: null, decision, created: false };
  }

  const created = await createCounterparty(client, tenantId, input, decision.normalizedName);
  if (created.created) {
    await ensureAlias(client, tenantId, created.counterparty.id, input, decision.normalizedName, "NEW");
    logger.info("ENTITY_CREATED", {
      businessId: tenantId,
      counterpartyId: created.counterparty.id,
      type: input.type,
      sourceType: input.sourceType,
    });
  }
  return { counterparty: created.counterparty, decision, created: created.created };
}

/**
 * Create the entity, resolving the concurrent-insert race by reading the winner.
 * The unique constraint - not a prior read - is what guarantees one entity.
 */
async function createCounterparty(
  client: CounterpartyClient,
  tenantId: string,
  input: ResolveCounterpartyInput,
  normalizedName: string
): Promise<{ counterparty: Counterparty; created: boolean }> {
  try {
    const counterparty = await client.counterparty.create({
      data: {
        businessId: tenantId,
        type: input.type,
        displayName: input.rawName.trim(),
        normalizedName,
      },
    });
    return { counterparty, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await client.counterparty.findUnique({
      where: {
        businessId_type_normalizedName: {
          businessId: tenantId,
          type: input.type,
          normalizedName,
        },
      },
    });
    // Unique violation with nothing to read means we tripped a different
    // constraint than the identity we expected. Do not call that idempotent.
    if (!existing) throw err;
    return { counterparty: existing, created: false };
  }
}

/** Idempotently record a normalised spelling -> entity mapping. */
async function ensureAlias(
  client: CounterpartyClient,
  tenantId: string,
  counterpartyId: string,
  input: ResolveCounterpartyInput,
  normalizedName: string,
  matchMethod: string
): Promise<void> {
  try {
    await client.counterpartyAlias.create({
      data: {
        businessId: tenantId,
        counterpartyId,
        type: input.type,
        rawName: input.rawName.trim(),
        normalizedName,
        sourceType: input.sourceType,
        matchMethod,
      },
    });
  } catch (err) {
    // Already recorded (or won by a concurrent writer): that is the intended
    // end state. Anything else is a real failure and must surface.
    if (!isUniqueViolation(err)) throw err;
  }
}

export interface MergeResult {
  /** The surviving entity. */
  target: Counterparty;
  aliasesMoved: number;
  invoicesRelinked: number;
  payoutsRelinked: number;
}

/**
 * Merge `sourceId` into `targetId` after a human confirmed they are the same
 * company (spec §34: user confirmation is evidence).
 *
 * The losing row is NOT deleted - it is marked `mergedIntoId` so the history of
 * what CashPilot believed stays auditable (spec §46). Its spellings become
 * aliases of the survivor, so every future lookup of the old name resolves
 * forward, and rows that referenced it are relinked.
 *
 * Pass a `$transaction` client: this is a multi-statement mutation. It is
 * ordered so that a crash part-way still converges (aliases are repointed
 * before the loser is marked merged, so the old name resolves to the survivor
 * either way), but only a transaction makes it atomic.
 */
export async function mergeCounterparties(
  client: CounterpartyMergeClient,
  tenantId: string,
  sourceId: string,
  targetId: string,
  now: Date = new Date()
): Promise<MergeResult> {
  if (!tenantId) throw new Error("mergeCounterparties requires a tenantId.");
  if (sourceId === targetId) throw new Error("Cannot merge a counterparty into itself.");

  const [source, target] = await Promise.all([
    client.counterparty.findFirst({ where: { id: sourceId, businessId: tenantId } }),
    client.counterparty.findFirst({ where: { id: targetId, businessId: tenantId } }),
  ]);

  // A missing row here is either a bad id or another tenant's entity; both must
  // fail identically so the error cannot be used to probe for existence.
  if (!source) throw new Error("Merge source counterparty not found for this tenant.");
  if (!target) throw new Error("Merge target counterparty not found for this tenant.");
  if (source.type !== target.type) {
    throw new Error("Cannot merge counterparties of different types.");
  }
  if (source.mergedIntoId) throw new Error("Merge source has already been merged.");
  if (target.mergedIntoId) {
    throw new Error("Merge target has already been merged; merge into the surviving entity.");
  }

  // Point every spelling of the loser at the survivor. Alias uniqueness is per
  // (tenant, type, normalizedName), and the loser's names are by construction
  // different from the survivor's, so this cannot collide.
  const moved = await client.counterpartyAlias.updateMany({
    where: { businessId: tenantId, counterpartyId: sourceId },
    data: { counterpartyId: targetId, matchMethod: "MERGE" },
  });

  // The loser's own canonical name may never have been aliased (it was its own
  // identity). Record it, so a future EXACT lookup of that name resolves forward.
  try {
    await client.counterpartyAlias.create({
      data: {
        businessId: tenantId,
        counterpartyId: targetId,
        type: target.type,
        rawName: source.displayName,
        normalizedName: source.normalizedName,
        sourceType: "USER",
        matchMethod: "MERGE",
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  // Relink referencing rows. updateMany with businessId in the filter, never
  // update-by-id: an id alone would let a leaked id write across tenants.
  const invoices = await client.invoice.updateMany({
    where: { businessId: tenantId, counterpartyId: sourceId },
    data: { counterpartyId: targetId },
  });
  const payouts = await client.payout.updateMany({
    where: { businessId: tenantId, counterpartyId: sourceId },
    data: { counterpartyId: targetId },
  });

  await client.counterparty.updateMany({
    where: { id: sourceId, businessId: tenantId },
    data: { mergedIntoId: targetId, mergedAt: now },
  });

  logger.info("ENTITY_MERGED", {
    businessId: tenantId,
    sourceCounterpartyId: sourceId,
    targetCounterpartyId: targetId,
    aliasesMoved: moved.count,
    invoicesRelinked: invoices.count,
    payoutsRelinked: payouts.count,
  });

  return {
    target,
    aliasesMoved: moved.count,
    invoicesRelinked: invoices.count,
    payoutsRelinked: payouts.count,
  };
}

export interface BackfillRow {
  id: string;
  /** `Invoice.customerName` or `Payout.vendor`. */
  name: string;
}

export interface BackfillResult {
  linked: number;
  /** Rows whose name could not be resolved to any entity. Never guessed at. */
  unresolved: string[];
  /** Entities created during the backfill. */
  createdCounterparties: number;
  /** Rows where a near-match was found and a human should confirm a merge. */
  mergeSuggestions: Array<{ rowId: string; rawName: string; candidateIds: string[] }>;
}

/**
 * Link existing Invoice rows to canonical customers.
 *
 * Read-then-link only: `customerName` is never rewritten, and the engine does
 * not read `counterpartyId`, so a partial or repeated backfill changes no
 * financial behaviour. Safe to re-run - resolution is idempotent and the link
 * is set to the same value.
 */
export function backfillInvoiceCounterparties(
  client: CounterpartyBackfillClient,
  tenantId: string,
  rows: BackfillRow[],
  options: ResolveCounterpartyOptions = {}
): Promise<BackfillResult> {
  return backfill(client, tenantId, "CUSTOMER", rows, "invoice", options);
}

/** Link existing Payout rows to canonical suppliers. See the invoice variant. */
export function backfillPayoutCounterparties(
  client: CounterpartyBackfillClient,
  tenantId: string,
  rows: BackfillRow[],
  options: ResolveCounterpartyOptions = {}
): Promise<BackfillResult> {
  return backfill(client, tenantId, "SUPPLIER", rows, "payout", options);
}

async function backfill(
  client: CounterpartyBackfillClient,
  tenantId: string,
  type: CounterpartyType,
  rows: BackfillRow[],
  table: "invoice" | "payout",
  options: ResolveCounterpartyOptions
): Promise<BackfillResult> {
  const result: BackfillResult = {
    linked: 0,
    unresolved: [],
    createdCounterparties: 0,
    mergeSuggestions: [],
  };

  // Sequential on purpose: resolution reads the entity set it is also writing
  // to, so concurrent rows for the same new name would race on every insert.
  // Backfills are bounded by a tenant's customer count, not its row count.
  for (const row of rows) {
    const { counterparty, decision, created } = await resolveCounterparty(
      client,
      tenantId,
      { type, rawName: row.name, sourceType: "ERP" },
      options
    );

    if (created) result.createdCounterparties++;
    if (decision.candidates.length > 0) {
      result.mergeSuggestions.push({
        rowId: row.id,
        rawName: row.name,
        candidateIds: decision.candidates.map((c) => c.id),
      });
    }

    if (!counterparty) {
      result.unresolved.push(row.id);
      continue;
    }

    // Tenant-scoped write: an id on its own is not authorisation.
    const updated =
      table === "invoice"
        ? await client.invoice.updateMany({
            where: { id: row.id, businessId: tenantId },
            data: { counterpartyId: counterparty.id },
          })
        : await client.payout.updateMany({
            where: { id: row.id, businessId: tenantId },
            data: { counterpartyId: counterparty.id },
          });

    result.linked += updated.count;
  }

  logger.info("ENTITY_BACKFILL_COMPLETED", {
    businessId: tenantId,
    type,
    rows: rows.length,
    linked: result.linked,
    createdCounterparties: result.createdCounterparties,
    unresolved: result.unresolved.length,
    mergeSuggestions: result.mergeSuggestions.length,
  });

  return result;
}
