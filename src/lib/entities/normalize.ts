/**
 * Phase 4 - deterministic name normalisation and similarity (spec §8).
 *
 * The problem: "ABC Ltd", "ABC LIMITED", "ABC Industries Pvt Ltd" and "ABC-IND"
 * arrive from four different sources and may or may not be one customer.
 *
 * The approach is deliberately split in two, because the two halves carry very
 * different risk:
 *
 *   normalizeEntityName()  - a CANONICAL FORM. Two names with the same
 *                            normalised form are treated as the same entity
 *                            automatically. This must only collapse differences
 *                            that are *notational* (case, punctuation, legal
 *                            form, spacing) and never differences that could be
 *                            two real companies.
 *
 *   nameSimilarity()       - a SUGGESTION score. Never used to merge anything on
 *                            its own; it only ranks near-matches for a human to
 *                            confirm.
 *
 * Similarity is token-overlap, NOT edit distance. Edit distance is the classic
 * wrong tool here: "Alpha Traders" and "Alpha Trading" are one character apart
 * per token yet may be different legal entities, while "Infosys" and "Infosys
 * Technologies" are far apart in edits and usually the same. Token overlap also
 * has the property we actually want - it is stable, explainable and symmetric,
 * so a resolution decision can be justified to a user (spec §58).
 */

/**
 * Legal-form and organisational-suffix tokens. Removing these is what makes
 * "ABC Ltd" == "ABC LIMITED" == "ABC Pvt Ltd". They are stripped only as whole
 * tokens, so "Cointreau" never loses a "co".
 */
const LEGAL_TOKENS: ReadonlySet<string> = new Set([
  "ltd",
  "limited",
  "pvt",
  "private",
  "inc",
  "incorporated",
  "llp",
  "llc",
  "plc",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "ag",
  "bv",
  "nv",
  "sa",
  "srl",
  "spa",
  "oy",
  "ab",
  "as",
  "pte",
  "sdn",
  "bhd",
]);

/**
 * Collapse a raw source name to a canonical key.
 *
 * Steps, in order: unicode-fold accents, lowercase, expand "&" to "and", turn
 * every non-alphanumeric run into a single space, then drop legal-form tokens.
 *
 * Returns "" only when the name contains no alphanumeric character at all -
 * the caller must treat that as unresolvable rather than as an entity, because
 * every blank name would otherwise collide into one bogus counterparty.
 */
export function normalizeEntityName(raw: string): string {
  if (typeof raw !== "string") return "";

  const folded = raw
    .normalize("NFKD")
    // Strip combining accents so "Café" and "Cafe" are one name.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (folded === "") return "";

  const tokens = folded.split(" ").filter(Boolean);
  const withoutLegal = tokens.filter((t) => !LEGAL_TOKENS.has(t));

  // A name made ENTIRELY of legal tokens ("Ltd", "The Company") would normalise
  // to "" and collide with every other such name. Keep the un-stripped form
  // instead: it is a worse key, but a wrong-but-distinct key beats a collision.
  if (withoutLegal.length === 0) return tokens.join(" ");

  return withoutLegal.join(" ");
}

/** Normalised tokens of a raw name. Empty array for an unresolvable name. */
export function nameTokens(raw: string): string[] {
  const normalized = normalizeEntityName(raw);
  return normalized === "" ? [] : normalized.split(" ");
}

/**
 * Token-set (Jaccard) similarity of two ALREADY-NORMALISED names, in [0,1].
 *
 * 1 means identical token sets; 0 means no shared token. Symmetric, and 0 for
 * an empty input rather than 1, so two unresolvable names never look identical.
 */
export function nameSimilarity(normalizedA: string, normalizedB: string): number {
  if (!normalizedA || !normalizedB) return 0;

  const a = new Set(normalizedA.split(" ").filter(Boolean));
  const b = new Set(normalizedB.split(" ").filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
