import { describe, it, expect } from "vitest";
import { settlementsSincePlan } from "../WhereYouStand";

/**
 * Money that arrived AFTER the plan on screen was built.
 *
 * A plan is reasoned out from a snapshot of the ledger. If a payment lands
 * afterwards, every figure behind it has moved — and the steps above still show
 * green ticks, inviting an operator to approve a plan built on numbers that no
 * longer hold. That is a real mistake rather than a cosmetic one.
 *
 * The test is a timestamp comparison, which is exactly the point: it names the
 * cause with certainty instead of warning vaguely that something is out of date.
 */

const planTime = "2026-09-01T10:00:00.000Z";

const settlement = (id: string, at: string, amount = 100) => ({
  id,
  amount,
  description: `Payment ${id}`,
  settledAt: at,
});

describe("Only settlements after the plan count", () => {
  it("finds one that landed later", () => {
    const r = settlementsSincePlan([settlement("a", "2026-09-01T11:00:00.000Z")], planTime);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("a");
  });

  it("ignores one that landed before", () => {
    // The plan already accounted for it; it is not news.
    const r = settlementsSincePlan([settlement("a", "2026-09-01T09:00:00.000Z")], planTime);
    expect(r).toHaveLength(0);
  });

  it("separates a mixed list correctly", () => {
    const r = settlementsSincePlan(
      [
        settlement("before", "2026-09-01T08:00:00.000Z"),
        settlement("after", "2026-09-01T12:00:00.000Z"),
        settlement("also-after", "2026-09-02T00:00:00.000Z"),
      ],
      planTime
    );
    expect(r.map((x) => x.id)).toEqual(["after", "also-after"]);
  });

  it("treats a settlement at the exact plan time as not after it", () => {
    // Ambiguous either way; the conservative reading is that the plan saw it,
    // because raising a false staleness warning teaches people to ignore them.
    expect(settlementsSincePlan([settlement("a", planTime)], planTime)).toHaveLength(0);
  });
});

describe("It stays quiet when it cannot know", () => {
  it("reports nothing when there is no plan time", () => {
    // A page not showing a plan has no plan to invalidate.
    const s = [settlement("a", "2026-09-01T11:00:00.000Z")];
    expect(settlementsSincePlan(s, null)).toHaveLength(0);
    expect(settlementsSincePlan(s, undefined)).toHaveLength(0);
  });

  it("reports nothing for an unparseable plan time", () => {
    expect(settlementsSincePlan([settlement("a", "2026-09-01T11:00:00.000Z")], "nonsense")).toHaveLength(0);
  });

  it("skips a settlement whose own timestamp is unreadable", () => {
    // Better to miss one warning than to claim a plan is stale on the strength
    // of a date nobody can parse.
    const r = settlementsSincePlan(
      [settlement("bad", "not-a-date"), settlement("good", "2026-09-01T11:00:00.000Z")],
      planTime
    );
    expect(r.map((x) => x.id)).toEqual(["good"]);
  });

  it("handles an empty list", () => {
    expect(settlementsSincePlan([], planTime)).toEqual([]);
  });

  it("accepts a Date as well as a string", () => {
    const r = settlementsSincePlan(
      [settlement("a", "2026-09-01T11:00:00.000Z")],
      new Date(planTime)
    );
    expect(r).toHaveLength(1);
  });
});
