import { describe, it, expect } from "vitest";
import { generateStrategies, StrategyResult } from "../strategyEngine";
import { scoreAllStrategies } from "../scorer";
import { buildForecast } from "../forecast";
import { extractObligations, calculateTemporalRequiredLiquidity, CashObligation } from "../liquiditySafety";
import { addDays, isSameDay } from "date-fns";
import { PayoutRecord } from "../../db/records";

describe("Obligation-Aware Liquidity & Temporal Risk Engine (Tests 1-20)", () => {
  const today = new Date("2026-08-22");

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

  // 1. No obligations fallback
  it("Test 1: Fallback behaves like legacy model when there are no obligations", () => {
    const forecast = [
      makeForecastDay(1, 1000000),
      makeForecastDay(2, 800000),
    ];
    const movements = [
      makeMovement("tx_1", 200000, "Regular", 1),
    ];
    const safetyThreshold = 500000;

    const res = calculateTemporalRequiredLiquidity(forecast, movements, [], safetyThreshold, today);

    // Required liquidity should equal operational safety threshold on all days
    expect(res.requiredLiquidityByDay).toEqual([safetyThreshold, safetyThreshold]);
    expect(res.criticalObligationsCount).toBe(0);
    expect(res.criticalObligationsProtected).toBe(true);
  });

  // 2. Single obligation handling
  it("Test 2: Single critical obligation increases temporal required liquidity before due date", () => {
    const forecast = [
      makeForecastDay(1, 2000000),
      makeForecastDay(2, 2000000),
      makeForecastDay(3, 1000000), // Outflow happens here
    ];
    const movements = [
      makeMovement("payout_1", 1000000, "Critical Vendor", 3),
    ];
    const obligations: CashObligation[] = [
      {
        id: "payout_1",
        amount: 1000000,
        dueDate: addDays(today, 3),
        type: "PAYOUT",
        priority: "CRITICAL",
        confidence: "HIGH",
        sourceId: "payout_1",
      },
    ];
    const safetyThreshold = 500000;

    const res = calculateTemporalRequiredLiquidity(forecast, movements, obligations, safetyThreshold, today);

    // On Day 1 and 2, we need safetyThreshold + obligationAmount (500k + 1000k = 1500k)
    expect(res.requiredLiquidityByDay[0]).toBe(1500000);
    expect(res.requiredLiquidityByDay[1]).toBe(1500000);
    // On Day 3 (after payment), required liquidity returns to safetyThreshold
    expect(res.requiredLiquidityByDay[2]).toBe(500000);
  });

  // 3. Multiple obligations
  it("Test 3: Correctly tracks multiple upcoming obligations across the horizon", () => {
    const forecast = [
      makeForecastDay(1, 3000000),
      makeForecastDay(2, 3000000),
      makeForecastDay(3, 2000000), // payout_1
      makeForecastDay(4, 2000000),
      makeForecastDay(5, 500000),  // payout_2
    ];
    const movements = [
      makeMovement("payout_1", 1000000, "Vendor A", 3),
      makeMovement("payout_2", 1500000, "Vendor B", 5),
    ];
    const obligations: CashObligation[] = [
      { id: "payout_1", amount: 1000000, dueDate: addDays(today, 3), type: "PAYOUT", priority: "CRITICAL", confidence: "HIGH", sourceId: "payout_1" },
      { id: "payout_2", amount: 1500000, dueDate: addDays(today, 5), type: "PAYOUT", priority: "CRITICAL", confidence: "HIGH", sourceId: "payout_2" },
    ];
    const safetyThreshold = 500000;

    const res = calculateTemporalRequiredLiquidity(forecast, movements, obligations, safetyThreshold, today);

    // On Day 1, we must cover both obligations (500k + 1000k + 1500k = 3000k)
    expect(res.requiredLiquidityByDay[0]).toBe(3000000);
    // On Day 4, only Vendor B remains (500k + 1500k = 2000k)
    expect(res.requiredLiquidityByDay[3]).toBe(2000000);
  });

  // 4. Same-day obligations
  it("Test 4: Correctly aggregates multiple obligations falling due on the same day", () => {
    const forecast = [
      makeForecastDay(1, 4000000),
      makeForecastDay(2, 1500000),
    ];
    const movements = [
      makeMovement("payout_1", 1000000, "Vendor A", 2),
      makeMovement("payout_2", 1500000, "Vendor B", 2),
    ];
    const obligations: CashObligation[] = [
      { id: "payout_1", amount: 1000000, dueDate: addDays(today, 2), type: "PAYOUT", priority: "CRITICAL", confidence: "HIGH", sourceId: "payout_1" },
      { id: "payout_2", amount: 1500000, dueDate: addDays(today, 2), type: "PAYOUT", priority: "CRITICAL", confidence: "HIGH", sourceId: "payout_2" },
    ];
    const safetyThreshold = 500000;

    const res = calculateTemporalRequiredLiquidity(forecast, movements, obligations, safetyThreshold, today);

    // Day 1 must cover both: 500k + 1000k + 1500k = 3000k
    expect(res.requiredLiquidityByDay[0]).toBe(3000000);
  });

  // 5. Lumpy payroll temporal risk warning
  it("Test 5: Captures high temporal risk for a lumpy payroll obligation", () => {
    const forecast = [
      makeForecastDay(1, 2500000),
      makeForecastDay(2, 500000), // payroll due here
    ];
    const movements = [
      makeMovement("payroll_1", 2000000, "Payroll", 2),
    ];
    const obligations: CashObligation[] = [
      { id: "payroll_1", amount: 2000000, dueDate: addDays(today, 2), type: "PAYROLL", priority: "CRITICAL", confidence: "HIGH", sourceId: "payroll_1" },
    ];
    const safetyThreshold = 500000;

    const res = calculateTemporalRequiredLiquidity(forecast, movements, obligations, safetyThreshold, today);

    expect(res.criticalObligationsAmount).toBe(2000000);
    expect(res.firstCriticalDate).toBe(addDays(today, 2).toISOString().split("T")[0]);
  });

  // 6. Double-counting prevention
  it("Test 6: Prevents double-counting by excluding matching outflows during temporal calculations", () => {
    const forecast = [
      makeForecastDay(1, 2000000),
      makeForecastDay(2, 2000000),
      makeForecastDay(3, 1000000),
    ];
    const movements = [
      makeMovement("payout_1", 1000000, "Packaging Co", 3), // mapped to daily movement
    ];
    const obligations: CashObligation[] = [
      { id: "payout_1", amount: 1000000, dueDate: addDays(today, 3), type: "PAYOUT", priority: "CRITICAL", confidence: "HIGH", sourceId: "payout_1" },
    ];
    const safetyThreshold = 500000;

    const res = calculateTemporalRequiredLiquidity(forecast, movements, obligations, safetyThreshold, today);

    // If double counted: required = 500k + 1000k - (-1000k) = 2500k
    // If correctly deduplicated: required = 500k + 1000k - 0 = 1500k
    expect(res.requiredLiquidityByDay[0]).toBe(1500000);
  });

  // 7. Obligation outside forecast horizon ignore
  it("Test 7: Ignores obligations scheduled beyond the 14-day horizon window", () => {
    const forecast = [
      makeForecastDay(1, 1000000),
    ];
    const movements = [
      makeMovement("payout_1", 1000000, "Late Obligation", 20),
    ];
    const obligations: CashObligation[] = [
      { id: "payout_1", amount: 1000000, dueDate: addDays(today, 20), type: "PAYOUT", priority: "CRITICAL", confidence: "HIGH", sourceId: "payout_1" },
    ];
    const safetyThreshold = 500000;

    const res = calculateTemporalRequiredLiquidity(forecast, movements, obligations, safetyThreshold, today);

    expect(res.requiredLiquidityByDay[0]).toBe(safetyThreshold);
    expect(res.criticalObligationsCount).toBe(0);
  });

  // 8. Day 1 timing accuracy
  it("Test 8: Evaluates Day 1 obligations with correct temporal logic", () => {
    const forecast = [
      makeForecastDay(1, 500000),
    ];
    const movements = [
      makeMovement("payout_1", 1000000, "Immediate Payout", 1),
    ];
    const obligations: CashObligation[] = [
      { id: "payout_1", amount: 1000000, dueDate: addDays(today, 1), type: "PAYOUT", priority: "CRITICAL", confidence: "HIGH", sourceId: "payout_1" },
    ];
    const safetyThreshold = 500000;

    const res = calculateTemporalRequiredLiquidity(forecast, movements, obligations, safetyThreshold, today);

    // Day 1 obligation is paid on Day 1, so closing balance required is just safetyThreshold
    expect(res.requiredLiquidityByDay[0]).toBe(500000);
  });

  // 9. Day 14 timing accuracy
  it("Test 9: Evaluates Day 14 obligations correctly at the horizon boundary", () => {
    const forecast = Array.from({ length: 14 }, (_, i) => makeForecastDay(i + 1, 1000000));
    const movements = [
      makeMovement("payout_1", 1000000, "Boundary Payout", 14),
    ];
    const obligations: CashObligation[] = [
      { id: "payout_1", amount: 1000000, dueDate: addDays(today, 14), type: "PAYOUT", priority: "CRITICAL", confidence: "HIGH", sourceId: "payout_1" },
    ];
    const safetyThreshold = 500000;

    const res = calculateTemporalRequiredLiquidity(forecast, movements, obligations, safetyThreshold, today);

    expect(res.requiredLiquidityByDay[0]).toBe(1500000);
    expect(res.requiredLiquidityByDay[12]).toBe(1500000); // Day 13 closing must cover it
    expect(res.requiredLiquidityByDay[13]).toBe(500000);  // Day 14 closing (after payment) returns to safetyThreshold
  });

  // 10. Missing due date warning/exclude
  it("Test 10: Safely ignores database payouts missing scheduled dates", () => {
    // scheduledDate is NOT NULL in the schema; this models a Json snapshot or an
    // import, the only sources that can carry a missing date.
    const rawPayouts = [
      { id: "payout_bad", amount: 100000, vendor: "Bad Payout", status: "SCHEDULED", criticality: "HIGH", scheduledDate: null } as unknown as PayoutRecord,
    ];

    const obligations = extractObligations(rawPayouts, [], today);
    expect(obligations.length).toBe(0);
  });

  // 10b. A malformed row must not take a well-formed one down with it. Excluding
  // an obligation understates required liquidity, so the exclusion has to be
  // surgical rather than batch-wide.
  it("Test 10b: Excludes only the undated obligation from a mixed batch", () => {
    const rawPayouts = [
      { id: "payout_bad", amount: 100000, vendor: "Bad Payout", status: "SCHEDULED", criticality: "HIGH", scheduledDate: null } as unknown as PayoutRecord,
      {
        id: "payout_good",
        amount: 250000,
        vendor: "Good Payout",
        status: "SCHEDULED",
        criticality: "HIGH",
        scheduledDate: addDays(today, 5),
      } as PayoutRecord,
    ];

    const obligations = extractObligations(rawPayouts, [], today);
    expect(obligations.length).toBe(1);
    expect(obligations[0].sourceId).toBe("payout_good");
    expect(obligations[0].amount).toBe(250000);
  });

  // 11. Zero amount validation
  it("Test 11: Safely processes zero-value payouts without throwing", () => {
    const rawPayouts = [
      { id: "payout_zero", amount: 0, vendor: "Zero", status: "SCHEDULED", criticality: "HIGH", scheduledDate: today },
    ];

    const obligations = extractObligations(rawPayouts, [], today);
    expect(obligations.length).toBe(0); // 0 amount criticals are excluded
  });

  // 12. Negative amount ignoring
  it("Test 12: Excludes payouts with negative amounts", () => {
    const rawPayouts = [
      { id: "payout_neg", amount: -50000, vendor: "Neg", status: "SCHEDULED", criticality: "HIGH", scheduledDate: today },
    ];

    const obligations = extractObligations(rawPayouts, [], today);
    expect(obligations.length).toBe(0);
  });

  // 13. Large obligation stability
  it("Test 13: Stably resolves extremely large obligations without numeric crashes", () => {
    const forecast = [
      makeForecastDay(1, 100000),
      makeForecastDay(2, 100000),
    ];
    const movements = [
      makeMovement("payout_huge", 99999999999999, "Huge", 2),
    ];
    const obligations: CashObligation[] = [
      { id: "payout_huge", amount: 99999999999999, dueDate: addDays(today, 2), type: "PAYOUT", priority: "CRITICAL", confidence: "HIGH", sourceId: "payout_huge" },
    ];

    const res = calculateTemporalRequiredLiquidity(forecast, movements, obligations, 50000, today);
    expect(res.requiredLiquidityByDay[0]).toBeGreaterThan(99999999999);
  });

  // 14. Strategy protecting obligation (high score)
  it("Test 14: Strategy that protects critical obligations receives high ranking", () => {
    const obligations: CashObligation[] = [
      { id: "payout_payroll", amount: 1000000, dueDate: addDays(today, 3), type: "PAYROLL", priority: "CRITICAL", confidence: "HIGH", sourceId: "payout_payroll" },
    ];

    // Strategy A keeps balance high on Day 3
    const sA: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [],
      projectedBalance: 2000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 2000000, minimumBalanceDay: 1 },
      forecast: [
        makeForecastDay(1, 2000000),
        makeForecastDay(2, 2000000),
        makeForecastDay(3, 1500000), // above 0, protected!
      ],
    };

    const scored = scoreAllStrategies([sA], 500000, obligations);
    expect(scored[0].scoring.safetyStatus).toBe("EXCEEDS_SAFETY_BUFFER");
    expect(scored[0].score).toBeGreaterThanOrEqual(60);
  });

  // 15. Strategy missing obligation (penalized/risk flagged)
  it("Test 15: Strategy failing to protect critical obligation is flagged as CRITICAL_OBLIGATION_RISK", () => {
    const obligations: CashObligation[] = [
      { id: "payout_payroll", amount: 2000000, dueDate: addDays(today, 3), type: "PAYROLL", priority: "CRITICAL", confidence: "HIGH", sourceId: "payout_payroll" },
    ];

    // Strategy B falls below 0 on Day 3 due to payroll
    const sB: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: -50000,
      riskLevel: "HIGH",
      runway: { firstDayBelowSafety: 1, crisisDay: 3, minimumBalance: -50000, minimumBalanceDay: 3 },
      forecast: [
        makeForecastDay(1, 1000000),
        makeForecastDay(2, 1000000),
        makeForecastDay(3, -50000), // breached!
      ],
    };

    const scored = scoreAllStrategies([sB], 500000, obligations);
    expect(scored[0].scoring.safetyStatus).toBe("DEFICIT");
    expect(scored[0].scoring.criticalObligations?.protected).toBe(false);
  });

  // 16. Temporal ranking inversion (prefers earlier preservation)
  it("Test 16: Prefers strategies preserving earlier cash balances under identical final balances", () => {
    const sA: StrategyResult = {
      name: "RECOVER_AND_COLLECT",
      actions: [],
      projectedBalance: 1000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 800000, minimumBalanceDay: 2 },
      forecast: [
        makeForecastDay(1, 900000),
        makeForecastDay(2, 800000),
        makeForecastDay(3, 1000000),
      ],
    };

    const sB: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [],
      projectedBalance: 1000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 500000, minimumBalanceDay: 2 },
      forecast: [
        makeForecastDay(1, 900000),
        makeForecastDay(2, 500000), // lower temporary dip
        makeForecastDay(3, 1000000),
      ],
    };

    // Both end at 1,000,000, but sA maintains a better minimum balance (800,000 vs 500,000)
    const scored = scoreAllStrategies([sA, sB], 400000);
    expect(scored[0].name).toBe("RECOVER_AND_COLLECT");
  });

  // 17. Baseline DO_NOTHING consistency
  it("Test 17: Evaluates baseline DO_NOTHING using identical temporal risk parameters", () => {
    const baseline: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 1000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 1000000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 1000000)],
    };

    const scored = scoreAllStrategies([baseline], 500000);
    expect(scored[0].scoring.requiredBuffer).toBe(500000);
  });

  // 18. Scale invariance
  it("Test 18: Preserves strategy rankings when scaling all monetary values (0.1x to 100x)", () => {
    const runScaled = (scale: number) => {
      const sA: StrategyResult = {
        name: "RECOVER_AND_COLLECT",
        actions: [],
        projectedBalance: 1000000 * scale,
        riskLevel: "LOW",
        runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 800000 * scale, minimumBalanceDay: 2 },
        forecast: [
          makeForecastDay(1, 900000 * scale),
          makeForecastDay(2, 800000 * scale),
          makeForecastDay(3, 1000000 * scale),
        ],
      };

      const sB: StrategyResult = {
        name: "RECOVER_ONLY",
        actions: [],
        projectedBalance: 1000000 * scale,
        riskLevel: "LOW",
        runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 500000 * scale, minimumBalanceDay: 2 },
        forecast: [
          makeForecastDay(1, 900000 * scale),
          makeForecastDay(2, 500000 * scale),
          makeForecastDay(3, 1000000 * scale),
        ],
      };

      const scored = scoreAllStrategies([sA, sB], 400000 * scale);
      return scored.map(s => s.name);
    };

    const r0_1 = runScaled(0.1);
    const r1 = runScaled(1);
    const r10 = runScaled(10);
    const r100 = runScaled(100);

    expect(r0_1).toEqual(r1);
    expect(r1).toEqual(r10);
    expect(r10).toEqual(r100);
  });

  // 19. Deterministic ranking tie-breakers
  it("Test 19: Stable tie-breaking using alphabetical strategy names when scores and balances are identical", () => {
    const s1: StrategyResult = {
      name: "RECOVER_ONLY",
      actions: [],
      projectedBalance: 1000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 1000000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 1000000)],
    };
    const s2: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 1000000,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 1000000, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 1000000)],
    };

    const scored = scoreAllStrategies([s1, s2], 500000);
    // DO_NOTHING ranks prior to RECOVER_ONLY alphabetically
    expect(scored[0].name).toBe("DO_NOTHING");
  });

  // 20. Extreme-value stability
  it("Test 20: Stable behavior under extreme float/integer values", () => {
    const s1: StrategyResult = {
      name: "DO_NOTHING",
      actions: [],
      projectedBalance: 99999999999999,
      riskLevel: "LOW",
      runway: { firstDayBelowSafety: null, crisisDay: null, minimumBalance: 99999999999999, minimumBalanceDay: 1 },
      forecast: [makeForecastDay(1, 99999999999999)],
    };

    const scored = scoreAllStrategies([s1], 9999999999999);
    expect(scored[0].score).toBe(100);
    expect(Number.isFinite(scored[0].score)).toBe(true);
  });
});
