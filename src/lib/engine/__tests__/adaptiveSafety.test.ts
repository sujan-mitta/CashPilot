import { describe, it, expect, vi } from "vitest";
import { calculateLiquiditySafetyRequirement } from "../liquiditySafety";
import { generateStrategies, StrategyResult } from "../strategyEngine";
import { scoreAllStrategies, SCORING_CONFIG } from "../scorer";
import { addDays } from "date-fns";

describe("Adaptive Liquidity Safety Buffer (Tests 1-12)", () => {
  const businessId = "test-business";
  const today = new Date("2026-08-22");

  // Helper to mock Prisma transactions and payouts
  function createMockPrisma(historical: any[], projectedTx: any[], projectedPayouts: any[]) {
    return {
      transaction: {
        findMany: vi.fn().mockImplementation((args) => {
          const isHistorical = args.where.status === "SUCCESS";
          return Promise.resolve(isHistorical ? historical : projectedTx);
        }),
      },
      payout: {
        findMany: vi.fn().mockResolvedValue(projectedPayouts),
      },
    };
  }

  // TEST 1: Small business with low average outflows
  it("Test 1: Small business safety buffer scales and applies absolute minimum floor correctly", async () => {
    // Average daily outflow is ₹100 paise (historical) and zero projected
    const mockPrisma = createMockPrisma(
      [{ amount: 3000, type: "OUTFLOW", status: "SUCCESS", expectedDate: today }], // ₹30 total -> ₹1/day average
      [],
      []
    );

    const safety = await calculateLiquiditySafetyRequirement(businessId, mockPrisma, today);
    
    // Safety buffer should hit the absolute floor of ₹50,000 (5,000,000 paise)
    expect(safety.absoluteFloorApplied).toBe(true);
    expect(safety.requiredBuffer).toBe(SCORING_CONFIG.SAFETY_BUFFER_MIN_FLOOR);
  });

  // TEST 2: Large business with high average outflows
  it("Test 2: Large business safety buffer scales above absolute floor and does not reuse legacy static threshold", async () => {
    // Average daily historical outflow is ₹5.0L (1,500,000,000 paise total / 30 days = 50,000,000 paise/day)
    // Projected daily outflow is ₹5.0L (700,000,000 paise total / 14 days = 50,000,000 paise/day)
    const mockPrisma = createMockPrisma(
      [{ amount: 1500000000, type: "OUTFLOW", status: "SUCCESS", expectedDate: today }],
      [{ amount: 700000000, type: "OUTFLOW", status: "PENDING", expectedDate: today }],
      []
    );

    const safety = await calculateLiquiditySafetyRequirement(businessId, mockPrisma, today);
    
    // Average daily outflow = 50,000,000 paise (₹5.0L). 3 days coverage = 150,000,000 paise (₹15.0L)
    expect(safety.absoluteFloorApplied).toBe(false);
    expect(safety.requiredBuffer).toBe(150000000); // ₹15.0L, which is higher than the legacy ₹2.5L
    expect(safety.requiredBuffer).not.toBe(SCORING_CONFIG.SAFETY_THRESHOLD);
  });

  // TEST 3: Scale invariance
  it("Test 3: Strategy ranking remains scale invariant when multiplying all cash values", async () => {
    const runScaledScenarios = async (multiplier: number) => {
      // Scale historical and projected values
      const mockPrisma = createMockPrisma(
        [{ amount: 300000000 * multiplier, type: "OUTFLOW", status: "SUCCESS", expectedDate: today }],
        [{ amount: 140000000 * multiplier, type: "OUTFLOW", status: "PENDING", expectedDate: today }],
        []
      );

      const safety = await calculateLiquiditySafetyRequirement(businessId, mockPrisma, today);

      const s1: StrategyResult = {
        name: "RECOVER_ONLY",
        actions: [],
        projectedBalance: 60000000 * multiplier,
        riskLevel: "LOW",
        runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 60000000 * multiplier, minimumBalanceDay: 1 },
        forecast: [],
      };

      const s2: StrategyResult = {
        name: "FULL_INTERVENTION",
        actions: [{ type: "RESCHEDULE_PAYOUT", amount: 100000 * multiplier, label: "Reschedule" }],
        projectedBalance: 120000000 * multiplier,
        riskLevel: "LOW",
        runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 120000000 * multiplier, minimumBalanceDay: 1 },
        forecast: [],
      };

      const scored = scoreAllStrategies([s1, s2], safety.requiredBuffer);
      return scored.map(s => s.name);
    };

    const rank1x = await runScaledScenarios(1);
    const rank10x = await runScaledScenarios(10);
    const rank100x = await runScaledScenarios(100);

    expect(rank1x).toEqual(rank10x);
    expect(rank1x).toEqual(rank100x);
  });

  // TEST 4: No historical data
  it("Test 4: Fallback to 100% projected scheduled outflows when no historical data exists", async () => {
    // 0 historical, ₹1.4L projected over 14 days (10,000 paise/day)
    const mockPrisma = createMockPrisma(
      [],
      [{ amount: 140000, type: "OUTFLOW", status: "PENDING", expectedDate: today }],
      []
    );

    const safety = await calculateLiquiditySafetyRequirement(businessId, mockPrisma, today);
    expect(safety.methodology).toContain("No historical outflow data available");
    expect(safety.confidence).toBe("MEDIUM");
    expect(safety.dataWarnings.length).toBeGreaterThan(0);
  });

  // TEST 5: No outflows
  it("Test 5: Zero outflows results in safety buffer floor without divide-by-zero or NaN errors", async () => {
    const mockPrisma = createMockPrisma([], [], []);
    const safety = await calculateLiquiditySafetyRequirement(businessId, mockPrisma, today);

    expect(safety.requiredBuffer).toBe(SCORING_CONFIG.SAFETY_BUFFER_MIN_FLOOR);
    expect(safety.averageDailyOutflow).toBe(0);
    expect(safety.confidence).toBe("LOW");
  });

  // TEST 6: One extreme outlier
  it("Test 6: Single outlier triggers warnings but preserves deterministic calculations", async () => {
    // Historical transaction is ₹30.0L (extreme compared to regular ₹1,000 paise)
    const mockPrisma = createMockPrisma(
      [
        { amount: 300000000, type: "OUTFLOW", status: "SUCCESS", expectedDate: today },
        { amount: 1000, type: "OUTFLOW", status: "SUCCESS", expectedDate: today }
      ],
      [],
      []
    );

    const safety = await calculateLiquiditySafetyRequirement(businessId, mockPrisma, today);
    expect(safety.dataWarnings).toContain("Large historical transaction outlier detected; safety buffer may be slightly elevated.");
    expect(safety.confidence).toBe("MEDIUM");
  });

  // TEST 7: Negative balance strategy vs positive but below safety-buffer strategy
  it("Test 7: Solvent strategy below safety-buffer is Tier I while negative balance strategy is Tier II", () => {
    const safetyBuffer = 10000000; // ₹1.0L buffer

    const solventBelowBuffer: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [],
      projectedBalance: 5000000, // ₹50,000 (positive, but below buffer)
      riskLevel: "MEDIUM",
      runway: { firstDayBelowSafety: 1, crisisDay: null, minimumBalance: 5000000, minimumBalanceDay: 1 },
      forecast: [],
    };

    const insolvent: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: -1000, // Insolvent
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 1, minimumBalance: -1000, minimumBalanceDay: 1 },
      forecast: [
        { date: today, openingBalance: 1000, expectedInflows: 0, expectedOutflows: 2000, closingBalance: -1000 }
      ],
    };

    const scored = scoreAllStrategies([solventBelowBuffer, insolvent], safetyBuffer);
    
    const s1 = scored.find(s => s.name === "RECOVER_ONLY")!;
    const s2 = scored.find(s => s.name === "DO_NOTHING")!;

    expect(s1.score).toBeGreaterThanOrEqual(60); // Tier I
    expect(s1.scoring.tier).toBe("Tier I (Deficit Resolved)");
    expect(s1.scoring.safetyStatus).toBe("BELOW_SAFETY_BUFFER");

    expect(s2.score).toBeLessThan(60); // Tier II
    expect(s2.scoring.tier).toBe("Tier II (Deficit Persists)");
  });

  // TEST 8: Two solvent strategies differentiation
  it("Test 8: Differentiates two solvent strategies based on their coverage ratios", () => {
    const safetyBuffer = 10000000; // ₹1.0L

    const meetsBuffer: StrategyResult = {
      name: "RECOVER_AND_COLLECT",
      actions: [],
      projectedBalance: 12000000, // ₹1.2L (meets buffer)
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 12000000, minimumBalanceDay: 1 },
      forecast: [],
    };

    const barelySolvent: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [],
      projectedBalance: 1000000, // ₹10,000 (barely positive)
      riskLevel: "MEDIUM",
      runway: { firstDayBelowSafety: 1, crisisDay: null, minimumBalance: 1000000, minimumBalanceDay: 1 },
      forecast: [],
    };

    const scored = scoreAllStrategies([meetsBuffer, barelySolvent], safetyBuffer);
    
    const highCover = scored.find(s => s.name === "RECOVER_AND_COLLECT")!;
    const lowCover = scored.find(s => s.name === "RECOVER_ONLY")!;

    expect(highCover.score).toBeGreaterThan(lowCover.score);
    expect(highCover.scoring.bufferCoverageRatio).toBe(1.2);
    expect(highCover.scoring.safetyStatus).toBe("MEETS_SAFETY_BUFFER");

    expect(lowCover.scoring.bufferCoverageRatio).toBe(0.1);
    expect(lowCover.scoring.safetyStatus).toBe("BELOW_SAFETY_BUFFER");
  });

  // TEST 9: No deficit baseline
  it("Test 9: DO_NOTHING wins when there are no projected deficits", () => {
    const baseMovements = [
      { date: addDays(new Date(), 1), inflows: 5000000, outflows: 1000000, description: "Normal" }
    ];
    const library = { recoverFailedPayments: 0, prioritizeCollections: 0, reschedulePayout: 0, pauseExpense: 0 };
    const strategies = generateStrategies(10000000, baseMovements, library);
    const scored = scoreAllStrategies(strategies, 2000000);

    expect(scored[0].name).toBe("DO_NOTHING");
    expect(scored[0].recommended).toBe(true);
  });

  // TEST 10: Identical strategies
  it("Test 10: Identical strategies resolve deterministically using stable alphabetical fallback keys", () => {
    const s1: StrategyResult = {
      name: "RECOVER_AND_COLLECT",
      actions: [],
      projectedBalance: 100000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 100000, minimumBalanceDay: 1 },
      forecast: [],
    };
    const s2: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [],
      projectedBalance: 100000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 100000, minimumBalanceDay: 1 },
      forecast: [],
    };

    const scored = scoreAllStrategies([s1, s2], 50000);
    expect(scored[0].name).toBe("RECOVER_AND_COLLECT"); // R alphabetically prior to RECOVER_ONLY
  });

  // TEST 11: Extreme monetary values
  it("Test 11: Stably handles extreme cash values without Infinity, NaN, or overflow crashes", () => {
    const safetyBuffer = 99999999999999;
    const s1: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 99999999999999,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 99999999999999, minimumBalanceDay: 1 },
      forecast: [],
    };
    const scored = scoreAllStrategies([s1], safetyBuffer);
    expect(scored[0].score).toBe(100);
    expect(scored[0].scoring.bufferCoverageRatio).toBe(1);
    expect(Number.isFinite(scored[0].score)).toBe(true);
  });

  // TEST 12: Configuration parameter changes
  it("Test 12: Predictably responds to changes in SCORING_CONFIG settings", async () => {
    const mockPrisma = createMockPrisma(
      [{ amount: 3000000, type: "OUTFLOW", status: "SUCCESS", expectedDate: today }], // ₹30,000 total -> ₹1,000/day
      [],
      []
    );

    // Initial config: 3 days coverage
    const initialSafety = await calculateLiquiditySafetyRequirement(businessId, mockPrisma, today);
    expect(initialSafety.requiredBuffer).toBe(SCORING_CONFIG.SAFETY_BUFFER_MIN_FLOOR); // Floor hits (1000 * 3 = 3000 < 5,000,000)

    // Dynamically change coverage days to 6000 days to cross the absolute floor
    SCORING_CONFIG.SAFETY_BUFFER_COVERAGE_DAYS = 6000;
    const customSafety = await calculateLiquiditySafetyRequirement(businessId, mockPrisma, today);
    expect(customSafety.requiredBuffer).toBe(420000000); // 70,000 paise/day average * 6000 days = 420,000,000 paise (₹4.2L)
    expect(customSafety.absoluteFloorApplied).toBe(false);

    // Restore config default
    SCORING_CONFIG.SAFETY_BUFFER_COVERAGE_DAYS = 3;
  });
});
