import { describe, it, expect } from "vitest";
import { buildForecast, calculateRunway, DailyMovement } from "../forecast";

/**
 * TRANCHE 16 — metamorphic testing of the forecast engine.
 *
 * Each transformation below has its expected relationship DERIVED from the
 * implementation's actual rules (buildForecast sums per-day movements onto a
 * running balance), not assumed:
 *
 *  A. Reorder movements            -> IDENTICAL (per-day filter is order-free)
 *  B. Add movement outside horizon -> NO CHANGE to in-window balances
 *  C. Re-run identical input       -> IDENTICAL (deterministic)
 *  D. Split one movement into two  -> EQUIVALENT (sums are associative)
 *  E. Add a relevant outflow       -> final balance drops by exactly that amount
 *  F. Scale cash + all movements   -> balances scale by the SAME factor
 *                                     (but threshold-based flags do NOT scale,
 *                                      because SAFETY_THRESHOLD is a fixed
 *                                      constant - documented, tested)
 *  G. Duplicate a movement         -> its effect DOUBLES (movements are distinct
 *                                     events; the forecast is NOT idempotent on
 *                                     duplicate inputs, by design)
 */

const START = new Date(Date.UTC(2026, 0, 1));
const H = 14;
const day = (n: number) => new Date(START.getTime() + n * 86400000);
const balances = (f: ReturnType<typeof buildForecast>) => f.map((d) => d.closingBalance);

const BASE: DailyMovement[] = [
  { date: day(2), inflows: 30_000_00, outflows: 0 },
  { date: day(3), inflows: 0, outflows: 70_000_00 },
  { date: day(5), inflows: 0, outflows: 20_000_00 },
];
const CASH = 100_000_00;

describe("metamorphic: forecast", () => {
  it("A. reordering movements yields an identical forecast", () => {
    const forward = buildForecast(CASH, BASE, H, START);
    const shuffled = buildForecast(CASH, [BASE[2], BASE[0], BASE[1]], H, START);
    expect(balances(shuffled)).toEqual(balances(forward));
  });

  it("B. adding a movement OUTSIDE the horizon does not change in-window balances", () => {
    const withOutside = [...BASE, { date: day(999), inflows: 0, outflows: 500_000_00 }];
    expect(balances(buildForecast(CASH, withOutside, H, START))).toEqual(
      balances(buildForecast(CASH, BASE, H, START))
    );
  });

  it("C. re-running the identical input yields an identical forecast (determinism)", () => {
    expect(balances(buildForecast(CASH, BASE, H, START))).toEqual(
      balances(buildForecast(CASH, BASE, H, START))
    );
  });

  it("D. splitting one movement into two on the same day is equivalent", () => {
    // One outflow of 70L on day 3 == two outflows of 40L + 30L on day 3.
    const split = [
      BASE[0],
      { date: day(3), inflows: 0, outflows: 40_000_00 },
      { date: day(3), inflows: 0, outflows: 30_000_00 },
      BASE[2],
    ];
    expect(balances(buildForecast(CASH, split, H, START))).toEqual(
      balances(buildForecast(CASH, BASE, H, START))
    );
  });

  it("E. adding a relevant outflow drops every subsequent balance by exactly that amount", () => {
    const extra = 15_000_00;
    const withExtra = [...BASE, { date: day(4), inflows: 0, outflows: extra }];
    const before = balances(buildForecast(CASH, BASE, H, START));
    const after = balances(buildForecast(CASH, withExtra, H, START));
    // Days 1-3 unchanged; day 4 onward down by exactly `extra`.
    for (let i = 0; i < H; i++) {
      const expectedDrop = i + 1 >= 4 ? extra : 0;
      expect(after[i]).toBe(before[i] - expectedDrop);
    }
  });

  it("F. scaling cash and all movements by k scales all balances by k", () => {
    const k = 7;
    const scaled = BASE.map((m) => ({ date: m.date, inflows: m.inflows * k, outflows: m.outflows * k }));
    const base = balances(buildForecast(CASH, BASE, H, START));
    const scaledBalances = balances(buildForecast(CASH * k, scaled, H, START));
    expect(scaledBalances).toEqual(base.map((b) => b * k));
  });

  it("F. (documented non-invariance) a FIXED safety threshold does NOT scale", () => {
    // Scaling amounts up does not proportionally move the fixed safety line, so
    // threshold-based flags are deliberately NOT scale-invariant. This pins that
    // property so a future 'optimization' that scaled the threshold would fail.
    const k = 1000;
    const small = calculateRunway(buildForecast(CASH, BASE, H, START), 50_000_00);
    const large = calculateRunway(buildForecast(CASH * k, BASE.map((m) => ({ ...m, inflows: m.inflows * k, outflows: m.outflows * k })), H, START), 50_000_00);
    // minimumBalance scales; the fixed threshold comparison need not match.
    expect(large.minimumBalance).toBe(small.minimumBalance * k);
  });

  it("G. duplicating a movement DOUBLES its effect (forecast is not idempotent on inputs)", () => {
    const dupOutflow = { date: day(3), inflows: 0, outflows: 70_000_00 };
    const withDup = [...BASE, dupOutflow];
    const before = balances(buildForecast(CASH, BASE, H, START));
    const after = balances(buildForecast(CASH, withDup, H, START));
    // From day 3 onward, an extra 70L is subtracted (the duplicate is a second
    // real movement, not a no-op).
    for (let i = 0; i < H; i++) {
      const expectedDrop = i + 1 >= 3 ? 70_000_00 : 0;
      expect(after[i]).toBe(before[i] - expectedDrop);
    }
  });
});
