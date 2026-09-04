import { describe, it, expect } from "vitest";
import { scoreAllStrategies, SCORING_CONFIG } from "../scorer";
import { StrategyResult } from "../strategyEngine";
import { ForecastDay } from "../forecast";

/**
 * TRANCHE 13 — strategy scoring correctness.
 *
 * Documented from the implementation (scorer.ts), NOT invented:
 *  - score is clamped and rounded: 0 for worse-than-baseline, else within its
 *    tier band, always Math.min/Math.max bounded -> integer in [0, 100].
 *  - ranking tie-breaks deterministically: score, then minimumBalance, then
 *    deficit days, then disruption penalty, then name.localeCompare. Because
 *    the final tie-break is the (unique) name, ranking does NOT depend on the
 *    order strategies arrive in.
 *  - recommended === (rank 1). Exactly one when the set is non-empty.
 *
 * These are asserted over seeded-random strategy sets for reproducibility.
 */

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACTION_TYPES = [
  "RECOVER_FAILED_PAYMENTS",
  "PRIORITIZE_COLLECTIONS",
  "PAUSE_EXPENSE",
  "RESCHEDULE_PAYOUT",
] as const;

function makeForecast(minBalance: number, deficitDays: number): ForecastDay[] {
  const days: ForecastDay[] = [];
  const start = new Date(Date.UTC(2026, 0, 1));
  for (let i = 1; i <= 14; i++) {
    const closing = i <= deficitDays ? -Math.abs(minBalance) : Math.abs(minBalance) + i;
    days.push({
      date: new Date(start.getTime() + i * 86400000),
      openingBalance: closing,
      expectedInflows: 0,
      expectedOutflows: 0,
      closingBalance: closing,
    });
  }
  return days;
}

function randomStrategies(rng: () => number): StrategyResult[] {
  const names = ["DO_NOTHING", "RECOVER_ONLY", "RECOVER_AND_COLLECT", "FULL_INTERVENTION", "DEFER_ONLY"];
  const count = 1 + Math.floor(rng() * names.length);
  const chosen = names.slice(0, count);
  return chosen.map((rawName) => {
    const name = rawName as StrategyResult["name"];
    const minBalance = Math.floor((rng() - 0.4) * 50_000_000);
    const deficitDays = Math.floor(rng() * 8);
    const nActions = name === "DO_NOTHING" ? 0 : 1 + Math.floor(rng() * 3);
    return {
      name,
      actions: Array.from({ length: nActions }, () => ({
        type: ACTION_TYPES[Math.floor(rng() * ACTION_TYPES.length)],
        amount: Math.floor(rng() * 30_000_000),
        label: "act",
      })),
      projectedBalance: minBalance,
      riskLevel: "HIGH" as const,
      runway: {
        firstDayBelowSafety: deficitDays > 0 ? 1 : null,
        crisisDay: deficitDays > 0 ? 1 : null,
        minimumBalance: minBalance,
        minimumBalanceDay: 2,
      },
      forecast: makeForecast(minBalance, deficitDays),
    };
  });
}

describe("scoring invariants (property-based)", () => {
  it("every score is a finite integer in [0, 100]", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const scored = scoreAllStrategies(randomStrategies(mulberry32(seed)));
      for (const s of scored) {
        expect(Number.isFinite(s.score), `seed ${seed}`).toBe(true);
        expect(Number.isInteger(s.score), `seed ${seed}`).toBe(true);
        expect(s.score, `seed ${seed}`).toBeGreaterThanOrEqual(0);
        expect(s.score, `seed ${seed}`).toBeLessThanOrEqual(100);
        expect(Number.isNaN(s.score)).toBe(false);
      }
    }
  });

  it("identical input yields identical scores AND identical ranking (determinism)", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const a = scoreAllStrategies(randomStrategies(mulberry32(seed)));
      const b = scoreAllStrategies(randomStrategies(mulberry32(seed)));
      expect(a.map((s) => [s.name, s.score, s.scoring.rank])).toEqual(
        b.map((s) => [s.name, s.score, s.scoring.rank])
      );
    }
  });

  it("ranking does NOT depend on input order (order-independence)", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const strategies = randomStrategies(mulberry32(seed));
      const forward = scoreAllStrategies(strategies);
      const reversed = scoreAllStrategies([...strategies].reverse());
      // Same name -> same rank, regardless of the order they were passed in.
      const rankByName = (r: typeof forward) => Object.fromEntries(r.map((s) => [s.name, s.scoring.rank]));
      expect(rankByName(forward), `seed ${seed}`).toEqual(rankByName(reversed));
    }
  });

  it("exactly one strategy is recommended, and it is rank 1", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const scored = scoreAllStrategies(randomStrategies(mulberry32(seed)));
      const recommended = scored.filter((s) => s.recommended);
      expect(recommended, `seed ${seed}`).toHaveLength(1);
      expect(recommended[0].scoring.rank).toBe(1);
    }
  });

  it("ranks are a contiguous 1..N permutation", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const scored = scoreAllStrategies(randomStrategies(mulberry32(seed)));
      const ranks = scored.map((s) => s.scoring.rank).sort((x, y) => (x ?? 0) - (y ?? 0));
      expect(ranks, `seed ${seed}`).toEqual(scored.map((_, i) => i + 1));
    }
  });

  /**
   * The recommendation is the best plan that GETS YOU HOME, which is not always
   * the highest-scoring one.
   *
   * This asserted the recommended strategy had the top score outright. That was
   * a true description of the old ordering and a wrong description of what the
   * engine is for: score weighs disruption, and a plan carrying three actions
   * and a deferred obligation can score below a gentler plan that leaves the
   * business under its safety floor. Recommending the gentler one is how an
   * operator came to approve and execute a plan the next screen described as
   * Rs 1,68,571 short.
   *
   * So the invariant is stated per safety class, which is stricter than the
   * original within each class and no longer wrong across them.
   */
  // The floor the product reports and the engine now ranks against — not the
  // per-day temporal requirement behind safetyStatus.
  const clears = (s: ReturnType<typeof scoreAllStrategies>[number]) =>
    s.runway.minimumBalance >= SCORING_CONFIG.SAFETY_THRESHOLD;

  it("the recommended strategy is the best of its safety class", () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const scored = scoreAllStrategies(randomStrategies(mulberry32(seed)));
      const rec = scored.find((s) => s.recommended)!;

      // Nothing in the same class may beat it on score.
      for (const s of scored) {
        if (clears(s) === clears(rec)) {
          expect(rec.score, `seed ${seed}`).toBeGreaterThanOrEqual(s.score);
        }
      }
    }
  });

  it("never recommends a plan short of the floor when one reaches it", () => {
    // The property that was actually broken. Without it the engine can rank a
    // safe plan second and call an unsafe one the recommendation.
    let sawBothClasses = false;
    for (let seed = 1; seed <= 1000; seed++) {
      const scored = scoreAllStrategies(randomStrategies(mulberry32(seed)));
      const rec = scored.find((s) => s.recommended)!;
      const anyClears = scored.some(clears);
      if (anyClears && scored.some((s) => !clears(s))) sawBothClasses = true;
      if (anyClears) expect(clears(rec), `seed ${seed}`).toBe(true);
    }
    // Guards the guard: a generator producing only one class would make the
    // assertion above vacuous.
    expect(sawBothClasses).toBe(true);
  });
});

describe("scoring edge cases (explicit)", () => {
  it("a single strategy is trivially recommended with a valid score", () => {
    const scored = scoreAllStrategies(randomStrategies(mulberry32(7)).slice(0, 1));
    expect(scored).toHaveLength(1);
    expect(scored[0].recommended).toBe(true);
    expect(scored[0].score).toBeGreaterThanOrEqual(0);
  });

  it("an empty strategy set yields an empty result, not a crash", () => {
    expect(scoreAllStrategies([])).toEqual([]);
  });

  it("all-equal strategies still produce a stable, unique ranking via name tie-break", () => {
    const base = randomStrategies(mulberry32(42))[0];
    const clones = ["ALPHA", "BRAVO", "CHARLIE"].map((name) => ({ ...base, name: name as StrategyResult["name"] }));
    const scored = scoreAllStrategies(clones);
    // Equal on every metric -> tie broken by name; ranks are unique 1,2,3.
    const ranks = scored.map((s) => s.scoring.rank).sort();
    expect(ranks).toEqual([1, 2, 3]);
    // ALPHA sorts first alphabetically among equals.
    expect(scored.find((s) => (s.name as string) === "ALPHA")!.scoring.rank).toBe(1);
  });
});
