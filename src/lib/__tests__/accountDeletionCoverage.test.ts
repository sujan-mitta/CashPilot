import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Imported from the data module, not the deletion logic: the logic needs a
// database client and this test does not.
import { BUSINESS_CHILD_TABLES } from "../../../scripts/lib/businessChildTables";

/**
 * Deleting an account must leave nothing behind, in ANY table.
 *
 * WHY THIS TEST AND NOT JUST CAREFUL CODE
 *
 * Every deletion in this project's history left something: a user removed while
 * their business stayed unreachable; a business removed while a dozen child
 * tables kept pointing at it. Each was found afterwards rather than prevented,
 * because the list of tables to clear was maintained by hand and the schema
 * kept growing past it.
 *
 * So the list is checked against the schema itself. Add a model with a
 * businessId and this fails until the deletion covers it — which is the only
 * way "we delete everything" stays true a month from now.
 */

const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

/** Every model carrying a businessId column. */
function modelsWithBusinessId(): string[] {
  const models: string[] = [];
  const blocks = schema.split(/\nmodel\s+/).slice(1);
  for (const block of blocks) {
    const name = block.split(/\s|\{/)[0];
    const body = block.slice(0, block.indexOf("\n}"));
    if (/^\s*businessId\s+String/m.test(body)) models.push(name);
  }
  return models;
}

/** Models the database itself clears, so the script need not. */
function cascadesFromBusiness(): string[] {
  const cascading: string[] = [];
  const blocks = schema.split(/\nmodel\s+/).slice(1);
  for (const block of blocks) {
    const name = block.split(/\s|\{/)[0];
    const body = block.slice(0, block.indexOf("\n}"));
    if (/business\s+Business\s+@relation\([^)]*onDelete:\s*Cascade/.test(body)) cascading.push(name);
  }
  return cascading;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

describe("The deletion covers every table that references a business", () => {
  it("misses nothing in the schema", () => {
    const covered = new Set<string>(BUSINESS_CHILD_TABLES);
    const cascaded = new Set(cascadesFromBusiness().map(lower));

    const uncovered = modelsWithBusinessId()
      .map(lower)
      .filter((m) => !covered.has(m) && !cascaded.has(m));

    // If this fails, a model was added with a businessId and deleting an
    // account would now leave its rows behind, pointing at a business that no
    // longer exists.
    expect(uncovered).toEqual([]);
  });

  it("finds a real set of models to check against", () => {
    // Guards the guard: a regex that silently matched nothing would make the
    // test above pass forever while proving nothing.
    expect(modelsWithBusinessId().length).toBeGreaterThan(10);
  });
});

describe("Order matters, and is recorded", () => {
  it("clears children before the parents they reference", () => {
    // Widened to string[] so the helper can take plain names — the tuple's
    // literal type would otherwise reject them at compile time.
    const order: string[] = [...BUSINESS_CHILD_TABLES];
    const before = (a: string, b: string) => order.indexOf(a) < order.indexOf(b);

    // Each of these is a foreign key that would refuse the delete if the order
    // were reversed. They are the pairs that actually caught me out.
    expect(before("evidence", "claim")).toBe(true);
    expect(before("decisionEvent", "decision")).toBe(true);
    expect(before("paymentRecovery", "transaction")).toBe(true);
    expect(before("agentAction", "strategy")).toBe(true);
    expect(before("counterpartyAlias", "counterparty")).toBe(true);
    expect(before("transaction", "counterparty")).toBe(true);
    expect(before("invoice", "counterparty")).toBe(true);
  });

  it("lists each table exactly once", () => {
    // A duplicate would be harmless; an omission caused by an editing slip
    // would not, and this catches the shape of that mistake.
    const order = [...BUSINESS_CHILD_TABLES];
    expect(new Set(order).size).toBe(order.length);
  });
});
