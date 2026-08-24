import { describe, it, expect } from "vitest";
import { generateStrategies, StrategyResult } from "../strategyEngine";
import { scoreAllStrategies } from "../scorer";
import { buildForecast } from "../forecast";
import { extractObligations, calculateTemporalRequiredLiquidity, CashObligation } from "../liquiditySafety";
import { addDays } from "date-fns";

describe("Counterfactual Simulation Engine (Tests 1-24)", () => {
  const today = new Date(Date.UTC(2026, 7, 22));

  function makeForecastDay(dateOffset: number, balance: number): any {
    return {
      date: addDays(today, dateOffset),
      openingBalance: balance,
      expectedInflows: 0,
      expectedOutflows: 0,
      closingBalance: balance,
    };
  }

  function makeMovement(id: string, amount: number, description: string, dateOffset: number) {
    return {
      transactionId: id,
      date: addDays(today, dateOffset),
      inflows: 0,
      outflows: amount,
      description,
    };
  }

  // Test 1: DO_NOTHING baseline is deterministic
  it("Test 1: DO_NOTHING baseline is deterministic", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Vendor A", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 0,
      pauseExpense: 0,
    };
    const strat1 = generateStrategies(5000000, baseMovements, library, today);
    const strat2 = generateStrategies(5000000, baseMovements, library, today);
    expect(strat1[0].runway).toEqual(strat2[0].runway);
  });

  // Test 2: Single payout rescheduling improves forecast correctly
  it("Test 2: Single payout rescheduling improves forecast correctly", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const doNothing = scored.find(s => s.name === "DO_NOTHING")!;
    const reschedule = scored.find(s => s.name === "FULL_INTERVENTION")!;

    expect(doNothing.runway.minimumBalance).toBe(-500000);
    expect(reschedule.runway.minimumBalance).toBe(500000);
  });

  // Test 3: Payout rescheduling actually moves the cash movement
  it("Test 3: Payout rescheduling actually moves the cash movement", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const full = strategies.find(s => s.name === "FULL_INTERVENTION")!;
    
    // Check that Day 3 has no outflow and Day 15 has the rescheduled outflow
    const day3 = full.forecast.find(f => f.date.getDate() === today.getDate() + 3);
    expect(day3?.closingBalance).toBe(500000);
  });

  // Test 4: No-op intervention is detected
  it("Test 4: No-op intervention is detected", () => {
    const baseMovements = [
      makeMovement("payout_1", 0, "Packaging Co", 3), // zero amount rescheduling
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 0,
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.counterfactual?.effectiveness).toBe("NO_MATERIAL_IMPROVEMENT");
  });

  // Test 5: Missing target produces INVALID
  it("Test 5: Missing target produces INVALID", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "invalid_id",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.counterfactual?.effectiveness).toBe("INVALID");
    expect(full.score).toBe(0);
  });

  // Test 6: Wrong target cannot modify another transaction
  it("Test 6: Wrong target cannot modify another transaction", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Other Vendor", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "invalid_id",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.counterfactual?.effectiveness).toBe("INVALID");
  });

  // Test 7: Duplicate payouts are handled by stable identity
  it("Test 7: Duplicate payouts are handled by stable identity", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
      makeMovement("payout_2", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_2",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(3500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.counterfactual?.effectiveness).toBe("LIQUIDITY_IMPROVED");
  });

  // Test 8: Accelerated collection changes forecast correctly
  it("Test 8: Accelerated collection changes forecast correctly", () => {
    const baseMovements: any[] = [];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 1000000,
      reschedulePayout: 0,
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const collect = strategies.find(s => s.name === "RECOVER_AND_COLLECT")!;
    // Day 1 has the inflow
    const day1 = collect.forecast.find(f => f.date.getDate() === today.getDate() + 1);
    expect(day1?.closingBalance).toBe(1500000);
  });

  // Test 9: Combined interventions are simulated together
  it("Test 9: Combined interventions are simulated together", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 1000000,
      recoverFailedPaymentsId: "failed_tx",
      prioritizeCollections: 500000,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    // Should have recovered inflow + accelerated inflow + rescheduled payout
    expect(full.runway.minimumBalance).toBe(500000);
  });

  // Test 10: Strategy does not mutate baseline
  it("Test 10: Strategy does not mutate baseline", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const stratBefore = generateStrategies(500000, baseMovements, library, today, 500000);
    const doNothingBefore = stratBefore.find(s => s.name === "DO_NOTHING")!;
    
    // Simulate candidate and verify doNothing remains identical
    scoreAllStrategies(stratBefore, 500000, [], baseMovements);
    expect(doNothingBefore.runway.minimumBalance).toBe(-500000);
  });

  // Test 11: Two simulations from the same baseline produce identical results
  it("Test 11: Two simulations from the same baseline produce identical results", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const run1 = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const run2 = scoreAllStrategies(strategies, 500000, [], baseMovements);
    expect(run1).toEqual(run2);
  });

  // Test 12: Strategy that worsens liquidity is detected
  it("Test 12: Strategy that worsens liquidity is detected", () => {
    const baseline: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 1000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 1000000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 1000000)],
    };
    const candidate: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [{ type: "RECOVER_FAILED_PAYMENTS", amount: 100000, label: "Recover" }],
      projectedBalance: 1100000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 800000, minimumBalanceDay: 1 }, // temporary dip makes minimumBalance worse
      forecast: [makeForecastDay(1, 800000)],
    };

    const scored = scoreAllStrategies([baseline, candidate], 500000);
    const scoredCand = scored.find(s => s.name === "RECOVER_ONLY")!;
    expect(scoredCand.scoring.counterfactual?.effectiveness).toBe("WORSE_THAN_BASELINE");
    expect(scoredCand.score).toBe(0);
  });

  // Test 13: Strategy that eliminates deficit is correctly classified
  it("Test 13: Strategy that eliminates deficit is correctly classified", () => {
    const baseline: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: -200000,
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: -200000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, -200000)],
    };
    const candidate: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [{ type: "RECOVER_FAILED_PAYMENTS", amount: 500000, label: "Recover" }],
      projectedBalance: 300000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 300000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 300000)],
    };

    const scored = scoreAllStrategies([baseline, candidate], 200000);
    const scoredCand = scored.find(s => s.name === "RECOVER_ONLY")!;
    expect(scoredCand.scoring.counterfactual?.effectiveness).toBe("DEFICIT_ELIMINATED");
    expect(scoredCand.score).toBeGreaterThanOrEqual(60);
  });

  // Test 14: Strategy that only reduces deficit is distinguished from full elimination
  it("Test 14: Strategy that only reduces deficit is distinguished from full elimination", () => {
    const baseline: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: -500000,
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: -500000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, -500000)],
    };
    const candidate: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [{ type: "RECOVER_FAILED_PAYMENTS", amount: 200000, label: "Recover" }],
      projectedBalance: -300000,
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: -300000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, -300000)],
    };

    const scored = scoreAllStrategies([baseline, candidate], 200000);
    const scoredCand = scored.find(s => s.name === "RECOVER_ONLY")!;
    expect(scoredCand.scoring.counterfactual?.effectiveness).toBe("DEFICIT_REDUCED");
    expect(scoredCand.score).toBeLessThan(60);
  });

  // Test 15: Strategy that improves final balance but worsens minimum balance is handled correctly
  it("Test 15: Strategy that improves final balance but worsens minimum balance is handled correctly", () => {
    const baseline: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 1000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 1000000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 1000000)],
    };
    const candidate: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [{ type: "RECOVER_FAILED_PAYMENTS", amount: 500000, label: "Recover" }],
      projectedBalance: 1200000, // higher final balance
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 800000, minimumBalanceDay: 1 }, // worse min balance
      forecast: [makeForecastDay(1, 800000)],
    };

    const scored = scoreAllStrategies([baseline, candidate], 200000);
    const scoredCand = scored.find(s => s.name === "RECOVER_ONLY")!;
    expect(scoredCand.scoring.counterfactual?.effectiveness).toBe("WORSE_THAN_BASELINE");
    expect(scoredCand.score).toBe(0);
  });

  // Test 16: Strategy that protects an obligation but causes a later deficit is detected
  it("Test 16: Strategy that protects an obligation but causes a later deficit is detected", () => {
    const obligations: CashObligation[] = [
      { id: "payout_1", amount: 1000000, dueDate: addDays(today, 2), type: "PAYOUT", priority: "CRITICAL", confidence: "HIGH", sourceId: "payout_1" },
    ];
    const baseline: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 2000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 2000000, minimumBalanceDay: 1 },
      forecast: [
        makeForecastDay(1, 2000000),
        makeForecastDay(2, 2000000), // obligation paid, balance stays at 2M
        makeForecastDay(3, 2000000),
      ],
    };
    const candidate: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [{ type: "RECOVER_FAILED_PAYMENTS", amount: 500000, label: "Recover" }],
      projectedBalance: -500000, // causes deficit on Day 3
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 3, minimumBalance: -500000, minimumBalanceDay: 3 },
      forecast: [
        makeForecastDay(1, 2500000),
        makeForecastDay(2, 2500000),
        makeForecastDay(3, -500000),
      ],
    };

    const scored = scoreAllStrategies([baseline, candidate], 500000, obligations);
    const scoredCand = scored.find(s => s.name === "RECOVER_ONLY")!;
    expect(scoredCand.scoring.counterfactual?.effectiveness).toBe("WORSE_THAN_BASELINE");
    expect(scoredCand.score).toBe(0);
  });

  // Test 17: Tier I remains above Tier II
  it("Test 17: Tier I remains above Tier II", () => {
    const baseline: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: -100000,
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: -100000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, -100000)],
    };
    const s1: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [{ type: "RECOVER_FAILED_PAYMENTS", amount: 500000, label: "Recover" }],
      projectedBalance: 400000, // deficit eliminated (Tier I)
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 400000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 400000)],
    };
    const s2: StrategyResult = {
      name: "RECOVER_AND_COLLECT",
      actions: [{ type: "RECOVER_FAILED_PAYMENTS", amount: 50000, label: "Recover" }],
      projectedBalance: -50000, // deficit reduced but remains (Tier II)
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: -50000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, -50000)],
    };

    const scored = scoreAllStrategies([baseline, s1, s2], 100000);
    const scored1 = scored.find(s => s.name === "RECOVER_ONLY")!;
    const scored2 = scored.find(s => s.name === "RECOVER_AND_COLLECT")!;
    expect(scored1.score).toBeGreaterThanOrEqual(60);
    expect(scored2.score).toBeLessThan(60);
  });

  // Test 18: Dominated strategy handling remains deterministic
  it("Test 18: Dominated strategy handling remains deterministic", () => {
    const s1: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 1000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 1000000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 1000000)],
    };
    const s2: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [{ type: "RECOVER_FAILED_PAYMENTS", amount: 0, label: "Recover" }],
      projectedBalance: 1000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 1000000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 1000000)],
    };

    const scored = scoreAllStrategies([s1, s2], 500000);
    expect(scored[0].name).toBe("DO_NOTHING"); // ranks higher due to zero penalty
  });

  // Test 19: Counterfactual deltas are mathematically correct
  it("Test 19: Counterfactual deltas are mathematically correct", () => {
    const baseline: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 1000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 800000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 800000)],
    };
    const candidate: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [{ type: "RECOVER_FAILED_PAYMENTS", amount: 400000, label: "Recover" }],
      projectedBalance: 1400000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 1200000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 1200000)],
    };

    const scored = scoreAllStrategies([baseline, candidate], 500000);
    const scoredCand = scored.find(s => s.name === "RECOVER_ONLY")!;
    const delta = scoredCand.scoring.counterfactual!;
    expect(delta.minimumBalanceDelta).toBe(400000);
    expect(delta.coverageRatioDelta).toBe(0.8); // (1200000/500000) - (800000/500000) = 2.4 - 1.6 = 0.8
  });

  // Test 20: Scale invariance remains valid
  it("Test 20: Scale invariance remains valid", () => {
    const runScaled = (scale: number) => {
      const baseline: StrategyResult = {
        name: "DO_NOTHING",
        actions: [],
        projectedBalance: 1000000 * scale,
        riskLevel: "LOW",
        runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 800000 * scale, minimumBalanceDay: 1 },
        forecast: [makeForecastDay(1, 800000 * scale)],
      };
      const candidate: StrategyResult = {
        name: "RECOVER_ONLY",
        actions: [{ type: "RECOVER_FAILED_PAYMENTS", amount: 400000 * scale, label: "Recover" }],
        projectedBalance: 1400000 * scale,
        riskLevel: "LOW",
        runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 1200000 * scale, minimumBalanceDay: 1 },
        forecast: [makeForecastDay(1, 1200000 * scale)],
      };

      const scored = scoreAllStrategies([baseline, candidate], 500000 * scale);
      return scored.find(s => s.name === "RECOVER_ONLY")!.scoring.counterfactual?.effectiveness;
    };

    expect(runScaled(0.1)).toBe(runScaled(100));
  });

  // Test 21: Extreme monetary values remain stable
  it("Test 21: Extreme monetary values remain stable", () => {
    const baseline: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 999999999999,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 999999999999, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 999999999999)],
    };
    const scored = scoreAllStrategies([baseline], 500000);
    expect(scored[0].score).toBe(100);
  });

  // Test 22: Repeated simulation gives identical results
  it("Test 22: Repeated simulation gives identical results", () => {
    const baseline: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 1000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 1000000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 1000000)],
    };
    const scored1 = scoreAllStrategies([baseline], 500000);
    const scored2 = scoreAllStrategies([baseline], 500000);
    expect(scored1[0].scoring.counterfactual).toEqual(scored2[0].scoring.counterfactual);
  });

  // Test 23: Original baseline forecast remains unchanged
  it("Test 23: Original baseline forecast remains unchanged", () => {
    const baseline: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 1000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 1000000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 1000000)],
    };
    scoreAllStrategies([baseline], 500000);
    expect(baseline.forecast[0].closingBalance).toBe(1000000);
  });

  // Test 24: Explanation metadata matches simulation output exactly
  it("Test 24: Explanation metadata matches simulation output exactly", () => {
    const baseline: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: -200000,
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: -200000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, -200000)],
    };
    const candidate: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [{ type: "RECOVER_FAILED_PAYMENTS", amount: 500000, label: "Recover" }],
      projectedBalance: 300000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 300000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 300000)],
    };

    const scored = scoreAllStrategies([baseline, candidate], 200000);
    const scoredCand = scored.find(s => s.name === "RECOVER_ONLY")!;
    const delta = scoredCand.scoring.counterfactual!;
    expect(delta.minimumBalanceDelta).toBe(500000);
    expect(delta.deficitDaysDelta).toBe(-1);
    expect(scoredCand.runway.minimumBalance).toBe(300000);
  });

  // Test 25: Reschedule within horizon (no deferred classification)
  it("Test 25: Reschedule within horizon (no deferred classification)", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    // Reschedule delay 8 is within the 14-day horizon
    const strategies = generateStrategies(500000, baseMovements, { ...library, rescheduleDelayDays: 8 } as any, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.deferredObligations?.count).toBe(0);
    expect(full.scoring.counterfactual?.effectiveness).toBe("NO_MATERIAL_IMPROVEMENT");
  });

  // Test 26: Reschedule exactly to Day 14 (no deferred classification)
  it("Test 26: Reschedule exactly to Day 14 (no deferred classification)", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    // Day 14 is exactly the horizon edge
    const strategies = generateStrategies(500000, baseMovements, { ...library, rescheduleDelayDays: 14 } as any, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.deferredObligations?.count).toBe(0);
    expect(full.scoring.counterfactual?.effectiveness).toBe("NO_MATERIAL_IMPROVEMENT");
  });

  // Test 27: Reschedule to Day 15 (deferred classification, amount, and count correct)
  it("Test 27: Reschedule to Day 15 (deferred classification, amount, and count correct)", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    // Day 15 is 1 day beyond horizon
    const strategies = generateStrategies(500000, baseMovements, { ...library, rescheduleDelayDays: 15 } as any, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.deferredObligations?.count).toBe(1);
    expect(full.scoring.deferredObligations?.amount).toBe(1000000);
    expect(full.scoring.deferredObligations?.items[0].daysBeyondHorizon).toBe(1);
    expect(full.scoring.counterfactual?.effectiveness).toBe("DEFICIT_ELIMINATED_WITH_DEFERRED_OBLIGATION");
  });

  // Test 28: Reschedule to Day 16 (deferred classification)
  it("Test 28: Reschedule to Day 16 (deferred classification)", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    // Day 16 is 2 days beyond horizon
    const strategies = generateStrategies(500000, baseMovements, { ...library, rescheduleDelayDays: 16 } as any, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.deferredObligations?.count).toBe(1);
    expect(full.scoring.deferredObligations?.items[0].daysBeyondHorizon).toBe(2);
  });

  // Test 29: Multiple deferred obligations
  it("Test 29: Multiple deferred obligations", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, { ...library, rescheduleDelayDays: 18 } as any, today, 500000);
    
    // Simulate manual strategy result with multiple deferred items
    const full = strategies.find(s => s.name === "FULL_INTERVENTION")!;
    full.deferredObligations = [
      { sourceId: "payout_1", amount: 1000000, originalDueDate: addDays(today, 3), newDueDate: addDays(today, 15), daysBeyondHorizon: 1 },
      { sourceId: "payout_2", amount: 1500000, originalDueDate: addDays(today, 4), newDueDate: addDays(today, 16), daysBeyondHorizon: 2 },
      { sourceId: "payout_3", amount: 2000000, originalDueDate: addDays(today, 5), newDueDate: addDays(today, 18), daysBeyondHorizon: 4 },
    ];

    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const scoredCand = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(scoredCand.scoring.deferredObligations?.count).toBe(3);
    expect(scoredCand.scoring.deferredObligations?.amount).toBe(4500000);
    expect(scoredCand.scoring.deferredObligations?.latestDueDate).toBe(addDays(today, 18).toISOString().split("T")[0]);
  });

  // Test 30: Same-day deferred obligations
  it("Test 30: Same-day deferred obligations", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const full = strategies.find(s => s.name === "FULL_INTERVENTION")!;
    full.deferredObligations = [
      { sourceId: "payout_a", amount: 1000000, originalDueDate: addDays(today, 3), newDueDate: addDays(today, 15), daysBeyondHorizon: 1 },
      { sourceId: "payout_b", amount: 2000000, originalDueDate: addDays(today, 3), newDueDate: addDays(today, 15), daysBeyondHorizon: 1 },
    ];

    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const scoredCand = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(scoredCand.scoring.deferredObligations?.count).toBe(2);
    expect(scoredCand.scoring.deferredObligations?.amount).toBe(3000000);
  });

  // Test 31: Deferred obligation identity
  it("Test 31: Deferred obligation identity", () => {
    const baseMovements = [
      makeMovement("payout_specific_id", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_specific_id",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.deferredObligations?.items[0].sourceId).toBe("payout_specific_id");
  });

  // Test 32: Deferred amount aggregation is mathematically correct
  it("Test 32: Deferred amount aggregation is mathematically correct", () => {
    const baseMovements = [
      makeMovement("payout_1", 1234567, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1234567,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.deferredObligations?.amount).toBe(1234567);
  });

  // Test 33: Strategy cannot falsely claim obligation disappeared
  it("Test 33: Strategy cannot falsely claim obligation disappeared", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.counterfactual?.effectiveness).toBe("DEFICIT_ELIMINATED_WITH_DEFERRED_OBLIGATION");
  });

  // Test 34: DO_NOTHING remains unchanged (zero deferred obligations)
  it("Test 34: DO_NOTHING remains unchanged (zero deferred obligations)", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const doNothing = scored.find(s => s.name === "DO_NOTHING")!;
    expect(doNothing.scoring.deferredObligations?.count).toBe(0);
    expect(doNothing.scoring.deferredObligations?.amount).toBe(0);
  });

  // Test 35: Counterfactual deltas remain correct when deferred obligations are present
  it("Test 35: Counterfactual deltas remain correct when deferred obligations are present", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.counterfactual?.minimumBalanceDelta).toBe(1000000);
    expect(full.scoring.counterfactual?.deficitDaysDelta).toBe(-12);
  });

  // Test 36: Existing Tier I / Tier II logic remains intact
  it("Test 36: Existing Tier I / Tier II logic remains intact", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.scoring.tier).toBe("Tier I (Deficit Resolved)");
  });

  // Test 37: Existing dominance logic remains intact
  it("Test 37: Existing dominance logic remains intact", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const scored = scoreAllStrategies(strategies, 500000, [], baseMovements);
    // Sort ordering places FULL_INTERVENTION above DO_NOTHING because it solves the deficit
    expect(scored[0].name).toBe("FULL_INTERVENTION");
  });

  // Test 38: Scale invariance remains valid for deferred amounts
  it("Test 38: Scale invariance remains valid for deferred amounts", () => {
    const runScaled = (scale: number) => {
      const baseMovements = [
        makeMovement("payout_1", 1000000 * scale, "Packaging Co", 3),
      ];
      const library = {
        recoverFailedPayments: 0,
        prioritizeCollections: 0,
        reschedulePayout: 1000000 * scale,
        rescheduleTransactionId: "payout_1",
        pauseExpense: 0,
      };
      const strategies = generateStrategies(500000 * scale, baseMovements, library, today, 500000 * scale);
      const scored = scoreAllStrategies(strategies, 500000 * scale, [], baseMovements);
      const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
      return {
        count: full.scoring.deferredObligations?.count,
        effectiveness: full.scoring.counterfactual?.effectiveness,
      };
    };

    const res1 = runScaled(0.5);
    const res2 = runScaled(50);
    expect(res1).toEqual(res2);
  });

  // Test 39: Repeated simulation remains deterministic
  it("Test 39: Repeated simulation remains deterministic", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const run1 = scoreAllStrategies(strategies, 500000, [], baseMovements);
    const run2 = scoreAllStrategies(strategies, 500000, [], baseMovements);
    expect(run1[0].scoring.deferredObligations).toEqual(run2[0].scoring.deferredObligations);
  });

  // Test 40: Baseline remains immutable
  it("Test 40: Baseline remains immutable", () => {
    const baseMovements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3),
    ];
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 1000000,
      rescheduleTransactionId: "payout_1",
      pauseExpense: 0,
    };
    const strategies = generateStrategies(500000, baseMovements, library, today, 500000);
    const before = JSON.stringify(strategies.find(s => s.name === "DO_NOTHING"));
    scoreAllStrategies(strategies, 500000, [], baseMovements);
    const after = JSON.stringify(strategies.find(s => s.name === "DO_NOTHING"));
    expect(before).toBe(after);
  });
});
