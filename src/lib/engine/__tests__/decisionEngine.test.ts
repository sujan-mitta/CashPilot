import { describe, it, expect } from "vitest";
import { generateStrategies, StrategyResult } from "../strategyEngine";
import { scoreAllStrategies, ScoredStrategy, SCORING_CONFIG } from "../scorer";
import { addDays } from "date-fns";

// Helper to generate template forecast days
function makeForecast(minBalance: number, deficitDays: number): any[] {
  const days = [];
  const today = new Date();
  for (let i = 0; i < 14; i++) {
    const isDeficitDay = i < deficitDays;
    days.push({
      date: addDays(today, i),
      openingBalance: 1000000,
      expectedInflows: 0,
      expectedOutflows: 0,
      closingBalance: isDeficitDay ? minBalance : 1000000,
    });
  }
  return days;
}

describe("CashPilot Decision Engine Auditing (Tests 1-14)", () => {
  // TEST 1 — NO DEFICIT
  it("Test 1: Baseline has no deficit, DO_NOTHING ranks first and is recommended", () => {
    const baseMovements = [
      { date: addDays(new Date(), 1), inflows: 5000000, outflows: 1000000, description: "Normal" }
    ];
    const library = { recoverFailedPayments: 0, prioritizeCollections: 0, reschedulePayout: 0, pauseExpense: 0 };
    const strategies = generateStrategies(10000000, baseMovements, library);
    const scored = scoreAllStrategies(strategies);

    expect(scored[0].name).toBe("DO_NOTHING");
    expect(scored[0].recommended).toBe(true);
  });

  // TEST 2 — SMALL TEMPORARY DEFICIT
  it("Test 2: Small temporary deficit is resolved by interventions which outrank DO_NOTHING", () => {
    const today = new Date();
    const baseMovements = [
      { date: addDays(today, 3), inflows: 0, outflows: 2000000, description: "Outflow" }
    ];
    // Baseline currentCash = 1500000, minBalance goes to -500000 (deficit of 500000) on Day 3
    // Library has recovery of 600000 on Day 2 which resolves it (balance stays positive)
    const library = {
      recoverFailedPayments: 600000,
      prioritizeCollections: 0,
      reschedulePayout: 0,
      pauseExpense: 0
    };
    const strategies = generateStrategies(1500000, baseMovements, library, today);
    const scored = scoreAllStrategies(strategies);

    // RECOVER_ONLY resolved the deficit, so it is Tier I and must outrank DO_NOTHING (Tier II)
    const recoverOnly = scored.find(s => s.name === "RECOVER_ONLY")!;
    const doNothing = scored.find(s => s.name === "DO_NOTHING")!;

    expect(recoverOnly.score).toBeGreaterThanOrEqual(60);
    expect(doNothing.score).toBeLessThan(60);
    expect(scored[0].name).toBe("RECOVER_ONLY");
  });

  // TEST 3 — LARGE SHORT DEFICIT
  it("Test 3: Large short deficit is resolved by Full Intervention which outranks other strategies", () => {
    const today = new Date();
    const baseMovements = [
      { date: addDays(today, 1), inflows: 0, outflows: 5000000, description: "Packaging Co Payout" },
      { date: addDays(today, 2), inflows: 0, outflows: 1500000, description: "SaaS Expense" }
    ];
    const library = {
      recoverFailedPayments: 2000000,
      prioritizeCollections: 2000000,
      reschedulePayout: 5000000,
      pauseExpense: 1500000
    };
    const strategies = generateStrategies(1000000, baseMovements, library, today);
    const scored = scoreAllStrategies(strategies);

    // Full Intervention reduces/resolves the deficit best, so it must rank top
    expect(scored[0].name).toBe("FULL_INTERVENTION");
  });

  // TEST 4 — SMALL LONG DEFICIT
  it("Test 4: Small long deficit ranks strategies based on deficit duration minimization", () => {
    const s1: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [],
      projectedBalance: -10000,
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: -10000, minimumBalanceDay: 1 },
      forecast: makeForecast(-10000, 10), // 10 days in deficit
    };
    const s2: StrategyResult = {
      name: "RECOVER_AND_COLLECT",
      actions: [],
      projectedBalance: -10000,
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: -10000, minimumBalanceDay: 1 },
      forecast: makeForecast(-10000, 2), // only 2 days in deficit
    };

    const scored = scoreAllStrategies([s1, s2]);
    // s2 has fewer deficit days, so it must outrank s1
    expect(scored[0].name).toBe("RECOVER_AND_COLLECT");
  });

  // TEST 5 — LARGE LONG DEFICIT
  it("Test 5: Large long deficit is heavily penalized, maintaining correct ranking", () => {
    const s1: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: -50000000,
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: -50000000, minimumBalanceDay: 1 },
      forecast: makeForecast(-50000000, 14),
    };
    const scored = scoreAllStrategies([s1]);
    expect(scored[0].score).toBe(12); // Minimum deficit reduction, but base score of 12 for no disruption/risk
  });

  // TEST 6 — DEFICIT ELIMINATION VS ZERO BUFFER
  it("Test 6: Strategy resolving deficit (leaving ₹1) outranks strategy leaving deficit", () => {
    const s1: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [],
      projectedBalance: 100, // ₹1 (paise) - deficit resolved
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: 1, crisisDay: null, minimumBalance: 100, minimumBalanceDay: 1 },
      forecast: makeForecast(100, 0),
    };
    const s2: StrategyResult = {
      name: "RECOVER_AND_COLLECT",
      actions: [],
      projectedBalance: -100, // Deficit persists
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: -100, minimumBalanceDay: 1 },
      forecast: makeForecast(-100, 1),
    };

    const scored = scoreAllStrategies([s1, s2]);
    expect(scored[0].name).toBe("RECOVER_ONLY");
    expect(scored[0].score).toBeGreaterThanOrEqual(60);
    expect(scored[1].score).toBeLessThan(60);
  });

  // TEST 7 — PARTIAL IMPROVEMENT VS FULL ELIMINATION
  it("Test 7: Full elimination outranks partial improvement, even if partial has less disruption", () => {
    const fullElim: StrategyResult = {
      name: "FULL_INTERVENTION",
      actions: [{ type: "RESCHEDULE_PAYOUT", amount: 100000, label: "Reschedule" }], // High disruption
      projectedBalance: 100000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 100000, minimumBalanceDay: 1 },
      forecast: makeForecast(100000, 0),
    };
    const partial: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [], // Zero disruption
      projectedBalance: -100000,
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: -100000, minimumBalanceDay: 1 },
      forecast: makeForecast(-100000, 1),
    };

    const scored = scoreAllStrategies([fullElim, partial]);
    expect(scored[0].name).toBe("FULL_INTERVENTION");
    expect(scored[0].score).toBeGreaterThanOrEqual(60);
  });

  // TEST 8 — DELAYED BENEFIT
  it("Test 8: Delayed benefit action discounts confidence correctly using decay factors", () => {
    const today = new Date();
    const baseMovements = [
      { date: addDays(today, 10), inflows: 0, outflows: 2000000, description: "Outflow" }
    ];
    const library = {
      recoverFailedPayments: 3000000, // Day 2
      prioritizeCollections: 0,
      reschedulePayout: 0,
      pauseExpense: 0
    };
    const strategies = generateStrategies(1000000, baseMovements, library, today);
    const scored = scoreAllStrategies(strategies);

    const recover = scored.find(s => s.name === "RECOVER_ONLY")!;
    // Confidence decayed: Day 2 offset
    const expectedDecay = Math.round(SCORING_CONFIG.RECOVER_FAILED_PAYMENTS_CONFIDENCE * Math.pow(SCORING_CONFIG.DECAY_RATE, 2));
    expect(recover.scoring.executionConfidence).toBe(expectedDecay);
  });

  // TEST 9 — SCALE INVARIANCE
  it("Test 9: Scaling all cash figures preserves strategy rankings identically (Scale Invariance)", () => {
    const generateRankings = (multiplier: number) => {
      const today = new Date();
      const baseMovements = [
        { date: addDays(today, 1), inflows: 0, outflows: 500000 * multiplier, description: "Outflow" }
      ];
      const library = {
        recoverFailedPayments: 300000 * multiplier,
        prioritizeCollections: 400000 * multiplier,
        reschedulePayout: 0,
        pauseExpense: 0
      };
      const strategies = generateStrategies(300000 * multiplier, baseMovements, library, today);
      const scored = scoreAllStrategies(strategies);
      return scored.map(s => s.name);
    };

    const rank1x = generateRankings(1);
    const rank10x = generateRankings(10);
    const rank100x = generateRankings(100);

    expect(rank1x).toEqual(rank10x);
    expect(rank1x).toEqual(rank100x);
  });

  // TEST 10 — MISSING DATA
  it("Test 10: Missing action library amounts resolves to baseline fallback values", () => {
    const today = new Date();
    const baseMovements = [
      { date: addDays(today, 1), inflows: 0, outflows: 1000000, description: "Outflow" }
    ];
    // Library has 0/missing for all recovery values
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 0,
      pauseExpense: 0
    };
    const strategies = generateStrategies(500000, baseMovements, library, today);
    const scored = scoreAllStrategies(strategies);

    // All strategies are identical since action amounts are 0, so DO_NOTHING should rank top deterministically
    expect(scored[0].name).toBe("DO_NOTHING");
  });

  // TEST 11 — DOMINATED STRATEGY
  it("Test 11: Dominated strategy never outranks the dominating strategy", () => {
    const dominant: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [],
      projectedBalance: 200000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 200000, minimumBalanceDay: 1 },
      forecast: makeForecast(200000, 0),
    };
    const dominated: StrategyResult = {
      name: "RECOVER_AND_COLLECT",
      actions: [],
      projectedBalance: 100000, // Lower buffer, same actions/disruption
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 100000, minimumBalanceDay: 1 },
      forecast: makeForecast(100000, 0),
    };

    const scored = scoreAllStrategies([dominated, dominant]);
    // dominant must outrank dominated
    expect(scored[0].name).toBe("RECOVER_ONLY");
  });

  // TEST 12 — IDENTICAL STRATEGIES
  it("Test 12: Identical strategies resolve deterministically using fallback sorting keys", () => {
    const s1: StrategyResult = {
      name: "RECOVER_AND_COLLECT",
      actions: [],
      projectedBalance: 100000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 100000, minimumBalanceDay: 1 },
      forecast: makeForecast(100000, 0),
    };
    const s2: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [],
      projectedBalance: 100000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 100000, minimumBalanceDay: 1 },
      forecast: makeForecast(100000, 0),
    };

    const scored = scoreAllStrategies([s1, s2]);
    // Both have identical scores, but "RECOVER_AND_COLLECT" is alphabetically prior to "RECOVER_ONLY"
    expect(scored[0].name).toBe("RECOVER_AND_COLLECT");
    expect(scored[1].name).toBe("RECOVER_ONLY");
  });

  // TEST 13 — EXTREME NUMERIC VALUES
  it("Test 13: Extremely large monetary figures do not crash the scorer and scale stably", () => {
    const s1: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 999999999999,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 999999999999, minimumBalanceDay: 1 },
      forecast: makeForecast(999999999999, 0),
    };
    const scored = scoreAllStrategies([s1]);
    expect(scored[0].score).toBe(100);
  });

  // TEST 14 — DO NOTHING BASELINE
  it("Test 14: All candidates compare appropriately against the DO_NOTHING baseline", () => {
    const today = new Date();
    const baseMovements = [
      { date: addDays(today, 3), inflows: 0, outflows: 2000000, description: "Outflow" }
    ];
    const library = {
      recoverFailedPayments: 100000, // Small partial recovery on Day 2
      prioritizeCollections: 0,
      reschedulePayout: 0,
      pauseExpense: 0
    };
    const strategies = generateStrategies(500000, baseMovements, library, today);
    const scored = scoreAllStrategies(strategies);

    const recover = scored.find(s => s.name === "RECOVER_ONLY")!;
    // recover reduces the deficit, so it should rank higher than DO_NOTHING
    expect(recover.scoring.rank).toBeLessThan(scored.find(s => s.name === "DO_NOTHING")!.scoring.rank!);
  });
});
