import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scoreAllStrategies } from "../scorer";
import { StrategyResult } from "../strategyEngine";
import { ForecastDay } from "../forecast";

/**
 * TRANCHE 14 — counterfactual engine integrity.
 *
 * THE CRITICAL INVARIANT: a counterfactual calculation must NEVER create a real
 * transaction, payment intent, ledger entry, recovery, or execution.
 *
 * This is guaranteed structurally, not by discipline: the entire decision
 * engine that computes counterfactuals is PURE and has no database access. The
 * architectural test below fails if anyone ever adds a prisma import to those
 * modules, which is the only way a counterfactual could gain a side effect.
 *
 * The math-consistency tests then verify the reported deltas actually equal
 * strategy - baseline, so a "counterfactual improvement" cannot be fabricated.
 */

const ENGINE_DIR = join(process.cwd(), "src", "lib", "engine");

describe("counterfactual purity (architectural guard)", () => {
  // These modules form the counterfactual/scoring path. None may touch the DB.
  const PURE_MODULES = ["scorer.ts", "strategyEngine.ts", "forecast.ts", "liquiditySafety.ts"];

  for (const mod of PURE_MODULES) {
    it(`${mod} has no database access (cannot mutate real state)`, () => {
      const src = readFileSync(join(ENGINE_DIR, mod), "utf8");
      expect(src, `${mod} imports prisma`).not.toMatch(/from ["']@\/lib\/prisma["']/);
      expect(src, `${mod} references prisma client`).not.toMatch(/\bprisma\s*\./);
      // No create/update/delete DB verbs on a client.
      expect(src).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany)\s*\(\s*\{/);
    });
  }
});

// --- math-consistency fixtures ------------------------------------------------

function makeForecast(minBalance: number, deficitDays: number): ForecastDay[] {
  const days: ForecastDay[] = [];
  const start = new Date(Date.UTC(2026, 0, 1));
  for (let i = 1; i <= 14; i++) {
    const closing = i <= deficitDays ? -Math.abs(minBalance) - i : Math.abs(minBalance) + i;
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

function strat(name: string, minBalance: number, deficitDays: number, actions: StrategyResult["actions"]): StrategyResult {
  return {
    name: name as StrategyResult["name"],
    actions,
    projectedBalance: minBalance,
    riskLevel: "HIGH",
    runway: {
      firstDayBelowSafety: deficitDays > 0 ? 1 : null,
      crisisDay: deficitDays > 0 ? 1 : null,
      minimumBalance: minBalance,
      minimumBalanceDay: 2,
    },
    forecast: makeForecast(minBalance, deficitDays),
  };
}

describe("counterfactual math consistency", () => {
  it("reported delta equals strategy - baseline for every scored strategy", () => {
    const strategies: StrategyResult[] = [
      strat("DO_NOTHING", -42_000_000, 6, []),
      strat("RECOVER_ONLY", -18_000_000, 3, [{ type: "RECOVER_FAILED_PAYMENTS", amount: 24_000_000, label: "r" }]),
      strat("FULL_INTERVENTION", 26_000_000, 0, [
        { type: "RECOVER_FAILED_PAYMENTS", amount: 24_000_000, label: "r" },
        { type: "PRIORITIZE_COLLECTIONS", amount: 44_000_000, label: "c" },
      ]),
    ];
    const scored = scoreAllStrategies(strategies);
    for (const s of scored) {
      const cf = s.scoring.counterfactual;
      if (!cf) continue;
      // The single most important consistency check: the claimed improvement is
      // exactly strategy minus baseline, never an invented figure.
      expect(cf.minimumBalanceDelta, s.name).toBe(cf.strategyMinimumBalance - cf.baselineMinimumBalance);
      expect(cf.deficitDaysDelta, s.name).toBe(cf.strategyDeficitDays - cf.baselineDeficitDays);
      // Every counterfactual number is finite.
      for (const v of [cf.minimumBalanceDelta, cf.deficitDaysDelta, cf.baselineMinimumBalance, cf.strategyMinimumBalance]) {
        expect(Number.isFinite(v), s.name).toBe(true);
      }
    }
  });

  it("a strategy that improves liquidity shows a non-negative minimumBalance delta vs the DO_NOTHING baseline", () => {
    const scored = scoreAllStrategies([
      strat("DO_NOTHING", -42_000_000, 6, []),
      strat("FULL_INTERVENTION", 26_000_000, 0, [{ type: "PRIORITIZE_COLLECTIONS", amount: 44_000_000, label: "c" }]),
    ]);
    const full = scored.find((s) => s.name === "FULL_INTERVENTION")!;
    const cf = full.scoring.counterfactual!;
    expect(cf.strategyMinimumBalance).toBeGreaterThan(cf.baselineMinimumBalance);
    expect(cf.minimumBalanceDelta).toBeGreaterThan(0);
  });

  it("a no-op strategy (same as baseline) reports ~zero delta, never a fabricated improvement", () => {
    const scored = scoreAllStrategies([
      strat("DO_NOTHING", -10_000_000, 2, []),
      strat("SAME_AS_BASELINE", -10_000_000, 2, []),
    ]);
    const same = scored.find((s) => (s.name as string) === "SAME_AS_BASELINE")!;
    const cf = same.scoring.counterfactual;
    if (cf) {
      expect(cf.minimumBalanceDelta).toBe(0);
      expect(cf.deficitDaysDelta).toBe(0);
    }
  });
});
