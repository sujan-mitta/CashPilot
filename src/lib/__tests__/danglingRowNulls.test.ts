import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A row that references nothing cannot be a leftover.
 *
 * WHAT HAPPENED
 *
 * Deleting the last account removed every user, business and child row
 * correctly — and then the script's own verifier announced "LEFTOVERS FOUND -
 * this is a bug in the deletion order" over 50 webhookDeliveryAttempt rows.
 * Every one of them had a NULL businessId: deliveries rejected for a bad
 * signature or an unknown token, which by design belong to no business and are
 * the audit trail of that rejection.
 *
 * `notIn` matched them, because NULL is not "in" a list of live ids. The
 * deletion was clean; the check was wrong.
 *
 * WHY THIS IS WORTH A TEST
 *
 * A verifier that cries wolf is worse than no verifier. The next person to see
 * that message would learn to wave it through, and the real leftover it exists
 * to catch would go with it.
 *
 * WebhookDeliveryAttempt is the only model whose businessId is nullable, so the
 * schema is checked too: if another nullable one is added, this fails until its
 * dangling check is written to match.
 */

const root = process.cwd();
const schema = readFileSync(join(root, "prisma", "schema.prisma"), "utf8");
const script = readFileSync(join(root, "scripts", "deleteAccount.ts"), "utf8");

/** Models whose businessId may be NULL, and so can never dangle. */
function nullableBusinessIdModels(): string[] {
  const models: string[] = [];
  for (const block of schema.split(/\nmodel\s+/).slice(1)) {
    const name = block.split(/\s|\{/)[0];
    const body = block.slice(0, block.indexOf("\n}"));
    if (/^\s*businessId\s+String\?/m.test(body)) models.push(name);
  }
  return models;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

describe("The dangling-row check tolerates rows that reference nothing", () => {
  it("excludes NULL for every nullable businessId", () => {
    for (const model of nullableBusinessIdModels().map(lower)) {
      // The check for this model must constrain businessId to non-null before
      // asking whether it points at a live business.
      const line = script
        .split("\n")
        .find((l) => l.includes(`prisma.${model}.count`) && l.includes("businessId"));

      expect(line, `no dangling check found for ${model}`).toBeDefined();
      expect(line, `${model}: NULL businessId would be reported as a leftover`).toContain("not: null");
    }
  });

  it("finds the nullable model it is guarding", () => {
    // Guards the guard: a regex matching nothing would make the test above
    // pass forever while checking nothing at all.
    expect(nullableBusinessIdModels()).toContain("WebhookDeliveryAttempt");
  });

  it("does not weaken the check for non-nullable models", () => {
    // `not: null` on a required column would be noise, and copying it around
    // would hide a genuinely nullable one later.
    const transactionLine = script
      .split("\n")
      .find((l) => l.includes("prisma.transaction.count") && l.includes("businessId"));
    expect(transactionLine).toBeDefined();
    expect(transactionLine).not.toContain("not: null");
  });
});
