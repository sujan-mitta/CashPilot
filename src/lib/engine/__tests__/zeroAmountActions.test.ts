import { describe, it, expect } from "vitest";
import { addDays } from "date-fns";
import { generateStrategies } from "../strategyEngine";
import { isExecutableAction } from "../actionEligibility";

/**
 * The planner must never offer an action worth nothing.
 *
 * WHAT HAPPENED
 *
 * A business recovered its only failed payment. The next plan still contained
 * "Orchestrate recovery links for failed customer payments" for Rs 0, because
 * the strategy templates list their actions unconditionally and the library
 * value had simply computed to zero.
 *
 * Execution refused the plan — correctly, since it cannot distinguish a planner
 * that computed zero from a request body edited down to zero — and the refusal
 * was total. The plan's other action, a real Rs 4,40,000 collection, could not
 * be run either. The operator saw "Plan approved and awaiting execution" above
 * a button that could only ever fail.
 *
 * This is the fourth bug of one shape: the planner proposing something the
 * executor will not accept. The other three are recorded in actionEligibility.
 */

const today = new Date();
const movements = [
  { date: addDays(today, 1), inflows: 0, outflows: 1_000_000, description: "Outflow" },
];

/** Every amount real except the one under test. */
const library = {
  recoverFailedPayments: 2_400_000,
  prioritizeCollections: 4_400_000,
  reschedulePayout: 9_000_000,
  pauseExpense: 1_500_000,
};

describe("A planned action always moves money", () => {
  it("emits no zero-amount action when there is nothing left to recover", () => {
    const strategies = generateStrategies(
      500_000,
      movements,
      { ...library, recoverFailedPayments: 0 },
      today
    );

    const zero = strategies.flatMap((s) =>
      s.actions.filter((a) => a.amount <= 0).map((a) => `${s.name}/${a.type}`)
    );

    // The exact plan that could not be executed: RECOVER_AND_COLLECT carrying a
    // recovery worth nothing alongside a collection worth Rs 4,40,000.
    expect(zero).toEqual([]);
  });

  it("keeps the actions that DO move money in the same plan", () => {
    // The failure mode being prevented is not "drop the plan" but "drop the
    // dead action" — the collection is still worth doing.
    const strategies = generateStrategies(
      500_000,
      movements,
      { ...library, recoverFailedPayments: 0 },
      today
    );

    const rac = strategies.find((s) => s.name === "RECOVER_AND_COLLECT");
    expect(rac?.actions.map((a) => a.type)).toEqual(["PRIORITIZE_COLLECTIONS"]);
  });

  it("does not offer a stripped-empty strategy as a rival to DO_NOTHING", () => {
    // RECOVER_ONLY has one action. With nothing to recover it has none, which
    // makes it DO_NOTHING under a different name — two identical futures for
    // the operator to choose between.
    const strategies = generateStrategies(
      500_000,
      movements,
      { ...library, recoverFailedPayments: 0 },
      today
    );

    expect(strategies.map((s) => s.name)).not.toContain("RECOVER_ONLY");
    expect(strategies.filter((s) => s.actions.length === 0)).toHaveLength(1);
  });

  it("still offers every strategy when every amount is real", () => {
    // Guards the guard: a filter that dropped everything would satisfy the
    // assertions above while destroying the product.
    const strategies = generateStrategies(500_000, movements, library, today);

    expect(strategies.map((s) => s.name)).toEqual([
      "DO_NOTHING",
      "RECOVER_ONLY",
      "RECOVER_AND_COLLECT",
      "FULL_INTERVENTION",
    ]);
  });

  it("keeps the baseline even though it has no actions by design", () => {
    const strategies = generateStrategies(
      500_000,
      movements,
      { recoverFailedPayments: 0, prioritizeCollections: 0, reschedulePayout: 0, pauseExpense: 0 },
      today
    );

    // Everything else is empty and therefore duplicative; the baseline is the
    // one strategy whose emptiness is the point.
    expect(strategies.map((s) => s.name)).toEqual(["DO_NOTHING"]);
  });
});

describe("The rule itself", () => {
  it("rejects zero and negative, accepts a real amount", () => {
    expect(isExecutableAction({ amount: 1 })).toBe(true);
    expect(isExecutableAction({ amount: 0 })).toBe(false);
    // A negative action would score as an improvement while making the
    // position worse.
    expect(isExecutableAction({ amount: -100 })).toBe(false);
  });
});
