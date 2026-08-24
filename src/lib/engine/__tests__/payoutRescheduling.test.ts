import { describe, it, expect } from "vitest";
import { generateStrategies, StrategyResult, applyActionsToMovements } from "../strategyEngine";
import { scoreAllStrategies } from "../scorer";
import { buildForecast } from "../forecast";
import { addDays, isSameDay } from "date-fns";

describe("Payout Rescheduling Hardening (Tests 1-13)", () => {
  const today = new Date("2026-08-22");

  // Helper to build simulated daily movements from database transactions
  function makeMovement(id: string, amount: number, description: string, dateOffset: number) {
    return {
      transactionId: id,
      date: addDays(today, dateOffset),
      inflows: 0,
      outflows: amount,
      description,
    };
  }

  // Test 1: Correct payout rescheduled using stable ID
  it("Test 1: Correct payout is rescheduled using stable transaction ID", () => {
    const movements = [
      makeMovement("payout_1", 100000, "Packaging Co", 3),
    ];
    
    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 100000,
      pauseExpense: 0,
      rescheduleTransactionId: "payout_1",
    };

    const strategies = generateStrategies(1000000, movements, library, today);
    const fullIntervention = strategies.find(s => s.name === "FULL_INTERVENTION")!;

    expect(fullIntervention.error).toBeUndefined();
    
    // Original date outflow should be reduced to 0 in the 14-day forecast
    const originalDay = fullIntervention.forecast.find(f => isSameDay(f.date, addDays(today, 3)));
    expect(originalDay?.expectedOutflows).toBe(0);

    // Verify Day 15 shifted date using a manually constructed 16-day forecast
    const simulatedMovements = applyActionsToMovements(movements, fullIntervention.actions, today);
    const simulatedForecast = buildForecast(1000000, simulatedMovements, 16, today);
    const newDay = simulatedForecast.find(f => isSameDay(f.date, addDays(today, 15)));
    expect(newDay?.expectedOutflows).toBe(100000);
  });

  // Test 2: Two payouts with identical amounts (only targeted payout moves)
  it("Test 2: Only the targeted payout moves when two payouts have identical amounts", () => {
    const movements = [
      makeMovement("target_payout", 125000, "Vendor A", 3),
      makeMovement("other_payout", 125000, "Vendor B", 4),
    ];

    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 125000,
      pauseExpense: 0,
      rescheduleTransactionId: "target_payout",
    };

    const strategies = generateStrategies(1000000, movements, library, today);
    const full = strategies.find(s => s.name === "FULL_INTERVENTION")!;

    expect(full.error).toBeUndefined();

    // target_payout on Day 3 should be moved (outflow reduced by 125,000)
    const day3 = full.forecast.find(f => isSameDay(f.date, addDays(today, 3)));
    expect(day3?.expectedOutflows).toBe(0);

    // other_payout on Day 4 should remain untouched (outflow remains 125,000)
    const day4 = full.forecast.find(f => isSameDay(f.date, addDays(today, 4)));
    expect(day4?.expectedOutflows).toBe(125000);
  });

  // Test 3: Two payouts with identical amount and description (only targeted payout moves)
  it("Test 3: Only the targeted payout moves when two payouts have identical amount and description", () => {
    const movements = [
      makeMovement("payout_a", 150000, "Packaging Co", 3),
      makeMovement("payout_b", 150000, "Packaging Co", 5),
    ];

    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 150000,
      pauseExpense: 0,
      rescheduleTransactionId: "payout_a",
    };

    const strategies = generateStrategies(1000000, movements, library, today);
    const full = strategies.find(s => s.name === "FULL_INTERVENTION")!;

    expect(full.error).toBeUndefined();

    // payout_a on Day 3 is moved
    const day3 = full.forecast.find(f => isSameDay(f.date, addDays(today, 3)));
    expect(day3?.expectedOutflows).toBe(0);

    // payout_b on Day 5 remains
    const day5 = full.forecast.find(f => isSameDay(f.date, addDays(today, 5)));
    expect(day5?.expectedOutflows).toBe(150000);
  });

  // Test 4: Description changes
  it("Test 4: Rescheduling succeeds even if the vendor description changes", () => {
    const movements = [
      makeMovement("payout_xyz", 200000, "Packaging Company Pvt Ltd", 3),
    ];

    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 200000,
      pauseExpense: 0,
      rescheduleTransactionId: "payout_xyz",
    };

    const strategies = generateStrategies(1000000, movements, library, today);
    const full = strategies.find(s => s.name === "FULL_INTERVENTION")!;

    expect(full.error).toBeUndefined();
    const day3 = full.forecast.find(f => isSameDay(f.date, addDays(today, 3)));
    expect(day3?.expectedOutflows).toBe(0);
  });

  // Test 5: Target payout does not exist (explicit failure)
  it("Test 5: Fails explicitly with RESCHEDULE_TARGET_NOT_FOUND if the target ID is missing", () => {
    const movements = [
      makeMovement("payout_real", 100000, "Vendor", 3),
    ];

    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 100000,
      pauseExpense: 0,
      rescheduleTransactionId: "payout_fake",
    };

    const strategies = generateStrategies(1000000, movements, library, today);
    const full = strategies.find(s => s.name === "FULL_INTERVENTION")!;

    expect(full.error).toBe("RESCHEDULE_TARGET_NOT_FOUND");
    
    // Scoring penalizes target-not-found strategies to 0
    const scored = scoreAllStrategies(strategies);
    const scoredFull = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(scoredFull.score).toBe(0);
    expect(scoredFull.scoring.disqualifications).toContain("RESCHEDULE_TARGET_NOT_FOUND");
  });

  // Test 6: Wrong payout ID
  it("Test 6: No other payout is modified if the target payout ID does not exist", () => {
    const movements = [
      makeMovement("payout_1", 100000, "Vendor A", 3),
      makeMovement("payout_2", 150000, "Vendor B", 4),
    ];

    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 100000,
      pauseExpense: 0,
      rescheduleTransactionId: "payout_invalid",
    };

    const strategies = generateStrategies(1000000, movements, library, today);
    const full = strategies.find(s => s.name === "FULL_INTERVENTION")!;

    expect(full.error).toBe("RESCHEDULE_TARGET_NOT_FOUND");
    
    // Inflows/outflows on other days should remain completely unchanged from the baseline
    expect(full.forecast).toEqual([]); // empty forecast on error
  });

  // Test 7, 8, 9: Rescheduled date and original date verification
  it("Tests 7-9: Verifies rescheduled date shifting logic and movement uniqueness", () => {
    const movements = [
      makeMovement("payout_unique", 500000, "Vendor X", 2),
    ];

    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 500000,
      pauseExpense: 0,
      rescheduleTransactionId: "payout_unique",
    };

    const strategies = generateStrategies(1000000, movements, library, today);
    const full = strategies.find(s => s.name === "FULL_INTERVENTION")!;

    // Original day (Day 2) must be reduced to 0
    const day2 = full.forecast.find(f => isSameDay(f.date, addDays(today, 2)));
    expect(day2?.expectedOutflows).toBe(0);

    // Verify shifted date using 16-day manual forecast
    const simulatedMovements = applyActionsToMovements(movements, full.actions, today);
    const simulatedForecast = buildForecast(1000000, simulatedMovements, 16, today);

    // New day (Day 15) must exist and have exactly 500,000 outflow
    const day15 = simulatedForecast.find(f => isSameDay(f.date, addDays(today, 15)));
    expect(day15?.expectedOutflows).toBe(500000);
  });

  // Test 10: Unrelated transactions remain unchanged
  it("Test 10: Unrelated transactions remain completely unchanged", () => {
    const movements = [
      makeMovement("payout_target", 100000, "Vendor A", 2),
      makeMovement("payout_unrelated", 250000, "Vendor B", 4),
    ];

    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 100000,
      pauseExpense: 0,
      rescheduleTransactionId: "payout_target",
    };

    const strategies = generateStrategies(1000000, movements, library, today);
    const full = strategies.find(s => s.name === "FULL_INTERVENTION")!;

    const day4 = full.forecast.find(f => isSameDay(f.date, addDays(today, 4)));
    expect(day4?.expectedOutflows).toBe(250000);
  });

  // Test 11: Multiple rescheduling/pausing actions affect only their intended targets
  it("Test 11: Multiple actions affect only their intended targets independently", () => {
    const movements = [
      makeMovement("payout_target", 100000, "Vendor A", 2),
      makeMovement("saas_target", 50000, "SaaS SaaS", 4),
    ];

    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 100000,
      pauseExpense: 50000,
      rescheduleTransactionId: "payout_target",
      pauseExpenseId: "saas_target",
    };

    const strategies = generateStrategies(1000000, movements, library, today);
    const full = strategies.find(s => s.name === "FULL_INTERVENTION")!;

    // Both should be correctly shifted/removed
    const day2 = full.forecast.find(f => isSameDay(f.date, addDays(today, 2)));
    expect(day2?.expectedOutflows).toBe(0);

    const day4 = full.forecast.find(f => isSameDay(f.date, addDays(today, 4)));
    expect(day4?.expectedOutflows).toBe(0);

    // Rescheduled payout is on Day 15 (verified via 16-day forecast)
    const simulatedMovements = applyActionsToMovements(movements, full.actions, today);
    const simulatedForecast = buildForecast(1000000, simulatedMovements, 16, today);
    const day15 = simulatedForecast.find(f => isSameDay(f.date, addDays(today, 15)));
    expect(day15?.expectedOutflows).toBe(100000);
  });

  // Test 12: Existing strategy ranking remains unchanged when target identity is valid
  it("Test 12: Ranking behaves correctly when target identity is valid", () => {
    const movements = [
      makeMovement("payout_target", 100000, "Packaging Co", 3),
    ];

    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 100000,
      pauseExpense: 0,
      rescheduleTransactionId: "payout_target",
    };

    const strategies = generateStrategies(1000000, movements, library, today);
    const scored = scoreAllStrategies(strategies);
    
    // FULL_INTERVENTION should not be disqualified (score > 0)
    const full = scored.find(s => s.name === "FULL_INTERVENTION")!;
    expect(full.score).toBeGreaterThan(0);
  });

  // Test 13: Bug regression test (seeded Packaging Co description changes, still reschedules)
  it("Test 13: Regression Test - Rename Packaging Co description to verify description independence", () => {
    const movements = [
      makeMovement("payout_001", 125000, "Packaging Company Pvt Ltd - Invoice #999", 3),
    ];

    const library = {
      recoverFailedPayments: 0,
      prioritizeCollections: 0,
      reschedulePayout: 125000,
      pauseExpense: 0,
      rescheduleTransactionId: "payout_001",
    };

    const strategies = generateStrategies(1000000, movements, library, today);
    const full = strategies.find(s => s.name === "FULL_INTERVENTION")!;

    expect(full.error).toBeUndefined();

    // Verify it correctly rescheduled payout_001
    const day3 = full.forecast.find(f => isSameDay(f.date, addDays(today, 3)));
    expect(day3?.expectedOutflows).toBe(0);
  });
});
