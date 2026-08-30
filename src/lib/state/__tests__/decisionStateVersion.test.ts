import { describe, it, expect, vi } from "vitest";
import { getLatestFinancialState } from "../store";

/**
 * A decision must record the financial state it was computed against.
 *
 * Without it the freshness gate has nothing to compare, so it classifies every
 * decision as NOT_TRACKED and the state half of the gate is inert. Recording
 * the version is what arms it.
 *
 * The safety argument for doing this now, ahead of any automatic
 * materialisation, is that the value is null until a state exists — which is
 * every tenant today. A null version reads as NOT_TRACKED, exactly the
 * behaviour decisions already have. So the change can only ever turn an
 * unverifiable decision into a verifiable one; it cannot start refusing
 * something that would previously have passed.
 *
 * These cover the selection rule the route depends on. The route's own wiring
 * is exercised by the strategies route suite.
 */

/** A minimal FinancialState row — only the fields the selection reads. */
const row = (stateVersion: number, businessId = "biz-A") => ({
  id: `fs_${stateVersion}`,
  businessId,
  stateVersion,
});

function clientWith(rows: ReturnType<typeof row>[]) {
  return {
    financialState: {
      findFirst: vi.fn(async (args: { where: { businessId: string }; orderBy?: unknown }) => {
        const scoped = rows
          .filter((r) => r.businessId === args.where.businessId)
          .sort((a, b) => b.stateVersion - a.stateVersion);
        return scoped[0] ?? null;
      }),
    },
  } as never;
}

describe("Selecting the state version a decision is computed against", () => {
  it("is null when no state has ever been materialised", async () => {
    // Today's reality for every tenant. The gate reads null as NOT_TRACKED, so
    // decisions behave exactly as they do now.
    const state = await getLatestFinancialState(clientWith([]), "biz-A");
    expect(state?.stateVersion ?? null).toBeNull();
  });

  it("selects the highest version, not the first row returned", async () => {
    const state = await getLatestFinancialState(clientWith([row(1), row(3), row(2)]), "biz-A");
    expect(state?.stateVersion).toBe(3);
  });

  it("never reads another tenant's state", async () => {
    // A decision stamped with a version belonging to a different business would
    // be compared against the wrong ground on every later freshness check.
    const rows = [row(9, "biz-B"), row(2, "biz-A")];
    const state = await getLatestFinancialState(clientWith(rows), "biz-A");

    expect(state?.stateVersion).toBe(2);
    expect(state?.businessId).toBe("biz-A");
  });

  it("returns null for a tenant with no state even when others have one", async () => {
    const state = await getLatestFinancialState(clientWith([row(9, "biz-B")]), "biz-A");
    expect(state).toBeNull();
  });

  it("refuses to run without a tenant", async () => {
    // An unscoped read here would silently stamp decisions with whatever state
    // happened to sort first across the whole table.
    await expect(getLatestFinancialState(clientWith([row(1)]), "")).rejects.toThrow(/tenantId/i);
  });
});
