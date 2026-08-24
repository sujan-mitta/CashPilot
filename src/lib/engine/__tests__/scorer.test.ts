import { describe, it, expect } from "vitest";
import { scoreAllStrategies } from "../scorer";
import { StrategyResult } from "../strategyEngine";

describe("Scorer Engine", () => {
  it("caps strategy scores below 60 if they do not resolve the deficit (Tier II)", () => {
    const mockStrategies: StrategyResult[] = [
      {
        name: "RECOVER_ONLY",
        actions: [
          {
            type: "RECOVER_FAILED_PAYMENTS",
            amount: 24000000,
            label: "Recover failed payment",
          },
        ],
        projectedBalance: -18000000,
        riskLevel: "HIGH",
        runway: {
          firstDayBelowSafety: 1,
          crisisDay: 2,
          minimumBalance: -18000000,
          minimumBalanceDay: 2,
        },
        forecast: [],
      },
    ];

    const scored = scoreAllStrategies(mockStrategies);
    expect(scored.length).toBe(1);
    expect(scored[0].score).toBeLessThan(60);
  });

  it("marks the highest-scoring strategy as recommended", () => {
    const mockStrategies: StrategyResult[] = [
      {
        name: "DO_NOTHING",
        actions: [],
        projectedBalance: -42000000,
        riskLevel: "HIGH",
        runway: {
          firstDayBelowSafety: 1,
          crisisDay: 2,
          minimumBalance: -42000000,
          minimumBalanceDay: 2,
        },
        forecast: [],
      },
      {
        name: "RECOVER_AND_COLLECT",
        actions: [
          {
            type: "RECOVER_FAILED_PAYMENTS",
            amount: 24000000,
            label: "Recover failed payment",
          },
          {
            type: "PRIORITIZE_COLLECTIONS",
            amount: 44000000,
            label: "Prioritize collection",
          },
        ],
        projectedBalance: 26000000,
        riskLevel: "LOW",
        runway: {
          firstDayBelowSafety: null,
          crisisDay: null,
          minimumBalance: 26000000,
          minimumBalanceDay: 2,
        },
        forecast: [],
      },
    ];

    const scored = scoreAllStrategies(mockStrategies);
    expect(scored.length).toBe(2);

    const recommended = scored.find((s) => s.recommended);
    expect(recommended).toBeDefined();
    expect(recommended!.name).toBe("RECOVER_AND_COLLECT");
  });

  it("applies time-decay to execution confidence of actions scheduled in the future", () => {
    const mockStrategies: StrategyResult[] = [
      {
        name: "FULL_INTERVENTION",
        actions: [
          {
            type: "RESCHEDULE_PAYOUT", // base confidence 80, scheduled Day 8
            amount: 100000,
            label: "Reschedule payout",
          },
        ],
        projectedBalance: 30000000,
        riskLevel: "LOW",
        runway: {
          firstDayBelowSafety: null,
          crisisDay: null,
          minimumBalance: 30000000,
          minimumBalanceDay: 2,
        },
        forecast: [],
      },
    ];

    const scored = scoreAllStrategies(mockStrategies);
    // Base confidence is 80. Decayed confidence should be 80 * 0.96^8 = 57.7 (rounds to 58)
    expect(scored[0].scoring.executionConfidence).toBe(58);
  });

  it("calculates relative deficit reduction accurately against the baseline", () => {
    const mockStrategies: StrategyResult[] = [
      {
        name: "DO_NOTHING",
        actions: [],
        projectedBalance: -20000,
        riskLevel: "HIGH",
        runway: {
          firstDayBelowSafety: 1,
          crisisDay: 2,
          minimumBalance: -20000,
          minimumBalanceDay: 2,
        },
        forecast: [],
      },
      {
        name: "RECOVER_ONLY",
        actions: [],
        projectedBalance: -10000,
        riskLevel: "HIGH",
        runway: {
          firstDayBelowSafety: 1,
          crisisDay: 2,
          minimumBalance: -10000,
          minimumBalanceDay: 2,
        },
        forecast: [], // 50% relative deficit reduction
      },
    ];

    const scored = scoreAllStrategies(mockStrategies);
    // RECOVER_ONLY reduces deficit from 20000 to 10000 (50% reduction)
    const rec = scored.find(s => s.name === "RECOVER_ONLY")!;
    expect(rec.scoring.deficitElimination).toBe(50);
  });
});
