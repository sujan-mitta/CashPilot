/**
 * Shared manifest for the PGlite -> Neon cutover.
 *
 * Export, import and verify all read this one list so they cannot drift apart.
 * If a table is added to the schema and not added here, `assertManifestCovers`
 * fails loudly rather than silently skipping it during a migration - a silent
 * skip would move a financial database and quietly leave rows behind.
 */

/**
 * Every model, in an order where a row's parents already exist.
 *
 * Foreign keys make the order load-bearing: Strategy -> Business,
 * AgentAction -> Strategy, ExecutionIntent -> AgentAction, and so on. The
 * implicit many-to-many join table `_BusinessToUser` is handled separately
 * because Prisma exposes no model for it.
 */
export const TABLE_ORDER = [
  // Stage 1 - roots, no outbound FKs
  "Business",
  "User",
  // Stage 2 - direct children of Business
  "Transaction",
  "Invoice",
  "Payout",
  "CashForecast",
  "Strategy",
  // Stage 3 - depend on stage 2
  "PaymentRecovery", // -> Transaction
  "Decision", // -> Strategy, Business
  "AgentAction", // -> Strategy
  // Stage 4 - depend on stage 3
  "ExecutionIntent", // -> Business, Strategy, AgentAction
  "DecisionEvent", // -> Decision
  // Stage 5 - standalone infrastructure
  "ProcessedEvent",
  "WebhookDeliveryAttempt",
] as const;

export type TableName = (typeof TABLE_ORDER)[number];

/** Prisma delegate name for a model (lowercase first letter). */
export const delegateFor = (t: string): string => t.charAt(0).toLowerCase() + t.slice(1);

/**
 * The implicit relation table behind `Business.users` / `User.businesses`.
 * Prisma has no delegate for it, so it is copied with raw SQL.
 */
export const JOIN_TABLE = "_BusinessToUser";

/**
 * Fails if the live database contains a public table this manifest does not
 * cover. Better to stop than to migrate a financial database incompletely.
 */
export function assertManifestCovers(actualTables: string[]): void {
  const known = new Set<string>([...TABLE_ORDER, JOIN_TABLE, "_prisma_migrations"]);
  // `events` is created by the local `prisma dev` query-insights feature, not
  // by our schema, and is deliberately not migrated.
  known.add("events");

  const unexpected = actualTables.filter((t) => !known.has(t));
  if (unexpected.length > 0) {
    throw new Error(
      `Manifest does not cover these tables: ${unexpected.join(", ")}. ` +
        `Add them to TABLE_ORDER (in FK-safe position) before migrating.`
    );
  }
}
