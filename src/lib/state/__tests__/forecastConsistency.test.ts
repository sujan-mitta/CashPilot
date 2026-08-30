import { describe, it, expect } from "vitest";
import { checkForecastConsistency, type ForecastTotals } from "../forecastConsistency";
import { FINANCIAL_CONFIG } from "../../engine/financialConfig";
import type { FinancialStateSnapshot } from "../financialState";

/**
 * Cross-checking the forecast against the materialised state.
 *
 * The forecast is computed from canonical rows; the state is computed from the
 * reconciled brain. When two independent paths disagree, something is wrong
 * that neither can see alone. This names the disagreement and stops — deciding
 * which side is right is a human judgement (spec §7), because one of them may
 * be stale and silently preferring either would be inventing an answer.
 */

const MATERIALITY = FINANCIAL_CONFIG.FRESHNESS_MATERIALITY_RATIO;

const forecast = (over: Partial<ForecastTotals> = {}): ForecastTotals => ({
  cashPosition: 10_000_000,
  expectedInflows: 4_000_000,
  expectedOutflows: 6_000_000,
  projectedMinimumBalance: 1_500_000,
  ...over,
});

const state = (over: Partial<FinancialStateSnapshot> = {}): FinancialStateSnapshot =>
  ({
    asOf: new Date("2026-09-01").toISOString(),
    cashPosition: 10_000_000,
    receivables: 0,
    payables: 0,
    expectedInflows: 4_000_000,
    expectedOutflows: 6_000_000,
    activeCommitments: 3,
    requiredBuffer: 2_000_000,
    projectedMinimumBalance: 1_500_000,
    riskState: "OK",
    horizonDays: 14,
    reconciliation: null,
    evidenceRefs: [],
    components: {},
    ...over,
  }) as FinancialStateSnapshot;

describe("When there is nothing to compare against", () => {
  it("reports NOT_COMPARABLE rather than a disagreement", () => {
    // The ordinary case before any sync has run. Calling it a divergence would
    // cry wolf on every tenant that has simply never synced.
    const r = checkForecastConsistency(forecast(), null, null);

    expect(r.verdict).toBe("NOT_COMPARABLE");
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatch(/no materialised financial state/i);
  });

  it("is NOT_COMPARABLE when a state exists but its version is unknown", () => {
    expect(checkForecastConsistency(forecast(), state(), null).verdict).toBe("NOT_COMPARABLE");
  });
});

describe("When the two paths agree", () => {
  it("reports AGREES on identical figures", () => {
    const r = checkForecastConsistency(forecast(), state(), 7);

    expect(r.verdict).toBe("AGREES");
    expect(r.stateVersion).toBe(7);
    expect(r.summary).toContain("v7");
  });

  it("tolerates an immaterial difference", () => {
    // The two paths round and filter slightly differently. Reporting a trivial
    // delta would train operators to ignore this signal, which is worse than
    // not having it.
    const tiny = Math.floor(10_000_000 * MATERIALITY * 0.5);
    const r = checkForecastConsistency(
      forecast({ cashPosition: 10_000_000 + tiny }),
      state(),
      1
    );

    expect(r.verdict).toBe("AGREES");
  });
});

describe("When they disagree", () => {
  it("reports DIVERGED on a material gap", () => {
    const r = checkForecastConsistency(forecast({ cashPosition: 5_000_000 }), state(), 3);

    expect(r.verdict).toBe("DIVERGED");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].field).toBe("cashPosition");
    expect(r.findings[0].deltaPaise).toBe(5_000_000);
  });

  it("reports every field that diverged, not just the first", () => {
    const r = checkForecastConsistency(
      forecast({ cashPosition: 1_000_000, expectedOutflows: 100_000 }),
      state(),
      3
    );

    expect(r.findings.map((f) => f.field).sort()).toEqual(["cashPosition", "expectedOutflows"]);
  });

  it("names the largest divergence in the summary", () => {
    const r = checkForecastConsistency(
      forecast({ cashPosition: 9_500_000, expectedInflows: 100_000 }),
      state(),
      3
    );

    // expectedInflows is proportionally far further off than cashPosition.
    expect(r.summary).toContain("expectedInflows");
  });

  it("does not decide which side is right", () => {
    const r = checkForecastConsistency(forecast({ cashPosition: 1 }), state(), 3);

    // It must point at the disagreement and the two possible causes, and stop.
    expect(r.summary).toMatch(/may be stale|conflict/i);
    expect(r.summary).not.toMatch(/corrected|overwritten|resolved to/i);
  });
});

describe("Nulls are not zeros", () => {
  it("skips a field the forecast could not measure", () => {
    // A null projected minimum means no runway could be built. Comparing it as
    // zero would manufacture a divergence against a real state figure.
    const r = checkForecastConsistency(
      forecast({ projectedMinimumBalance: null }),
      state({ projectedMinimumBalance: 9_000_000 }),
      2
    );

    expect(r.verdict).toBe("AGREES");
    expect(r.findings).toHaveLength(0);
  });

  it("skips a field the state does not carry", () => {
    const r = checkForecastConsistency(
      forecast({ projectedMinimumBalance: 9_000_000 }),
      state({ projectedMinimumBalance: null }),
      2
    );

    expect(r.verdict).toBe("AGREES");
  });

  it("ignores a non-finite figure rather than reporting NaN apart", () => {
    const r = checkForecastConsistency(
      forecast({ cashPosition: Number.NaN }),
      state(),
      2
    );

    expect(r.findings).toHaveLength(0);
  });
});
