import { describe, it, expect } from "vitest";
import { isPlanStale } from "../planStaleness";

/**
 * Whether the completed steps are still telling the truth.
 *
 * A green tick is the strongest available signal that nothing is wrong. After a
 * payment lands, the figures those steps were reasoned from have moved, and the
 * tick becomes an invitation to approve a plan built on superseded numbers.
 *
 * The timestamp comparison is tested elsewhere. What is tested HERE is the
 * lookup that reaches it — because a failure of that shape is invisible:
 * nothing errors, no warning is drawn, and the steps stay reassuringly green
 * forever.
 */

const PLAN_AT = "2026-09-01T10:00:00.000Z";

const standing = (settledAt: string) => ({
  received: [{ id: "r1", amount: 100, description: "Recovered", settledAt }],
});

const plans = [
  { id: "plan-a", createdAt: PLAN_AT },
  { id: "plan-b", createdAt: "2026-09-01T20:00:00.000Z" },
];

describe("The plan the steps actually describe", () => {
  it("is stale when money arrived after it was built", () => {
    expect(isPlanStale(standing("2026-09-01T11:00:00.000Z"), plans, "plan-a")).toBe(true);
  });

  it("is not stale when the money predates it", () => {
    expect(isPlanStale(standing("2026-09-01T09:00:00.000Z"), plans, "plan-a")).toBe(false);
  });

  it("judges the SELECTED plan, not simply the first one", () => {
    // The whole point of the lookup. A payment at 11:00 is after plan-a and
    // before plan-b; reading the wrong plan reverses the answer.
    const s = standing("2026-09-01T11:00:00.000Z");
    expect(isPlanStale(s, plans, "plan-a")).toBe(true);
    expect(isPlanStale(s, plans, "plan-b")).toBe(false);
  });
});

describe("Every unknown resolves to 'not stale'", () => {
  const s = standing("2026-09-01T11:00:00.000Z");

  it("says nothing when no plan is selected", () => {
    expect(isPlanStale(s, plans, null)).toBe(false);
    expect(isPlanStale(s, plans, undefined)).toBe(false);
  });

  it("says nothing when the selected plan is not in the cache", () => {
    // The selection and the cache have drifted apart. We cannot know what that
    // plan was built from, so we cannot claim it is out of date.
    expect(isPlanStale(s, plans, "plan-missing")).toBe(false);
  });

  it("says nothing when the plan has no creation time", () => {
    expect(isPlanStale(s, [{ id: "plan-a" }], "plan-a")).toBe(false);
  });

  it("says nothing without standing data or plans", () => {
    expect(isPlanStale(null, plans, "plan-a")).toBe(false);
    expect(isPlanStale(undefined, plans, "plan-a")).toBe(false);
    expect(isPlanStale(s, null, "plan-a")).toBe(false);
    expect(isPlanStale(s, [], "plan-a")).toBe(false);
  });

  it("says nothing when no money has arrived at all", () => {
    expect(isPlanStale({ received: [] }, plans, "plan-a")).toBe(false);
  });
});

describe("Why it errs quiet", () => {
  it("never claims staleness on incomplete information", () => {
    // A false warning trains people to ignore the true ones, which costs more
    // than an occasional missed one. Every degraded input below is a case where
    // being wrong loudly would be worse than being silent.
    const degraded: Array<Parameters<typeof isPlanStale>> = [
      [null, null, null],
      [{ received: [] }, plans, "plan-a"],
      [standing("2026-09-01T11:00:00.000Z"), [{ id: "x" }], "x"],
      [standing("not-a-date"), plans, "plan-a"],
    ];
    for (const args of degraded) {
      expect(isPlanStale(...args)).toBe(false);
    }
  });
});
