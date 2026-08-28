import { describe, it, expect } from "vitest";
import {
  sourceReliability,
  freshnessScore,
  specificityScore,
  isPredictiveClaim,
  computeConfidence,
  aggregateClaimConfidence,
} from "../confidence";

const NOW = new Date("2026-09-10T00:00:00.000Z");

describe("sourceReliability (spec §10, §12)", () => {
  it("ranks observed sources above stated-intention sources", () => {
    expect(sourceReliability("BANK")).toBeGreaterThan(sourceReliability("EMAIL"));
    expect(sourceReliability("RAZORPAY")).toBeGreaterThan(sourceReliability("HISTORICAL"));
    expect(sourceReliability("ERP")).toBeGreaterThan(sourceReliability("EMAIL"));
  });

  it("is case-insensitive and falls back to a neutral 0.5 for unknown sources", () => {
    expect(sourceReliability("bank")).toBe(sourceReliability("BANK"));
    expect(sourceReliability("SOMETHING_NEW")).toBe(0.5);
  });
});

describe("freshnessScore", () => {
  it("is 1.0 at the moment of observation and clamps future skew to 1.0", () => {
    expect(freshnessScore(NOW, NOW)).toBe(1);
    expect(freshnessScore(new Date("2026-09-11T00:00:00.000Z"), NOW)).toBe(1);
  });

  it("halves after one half-life and keeps decaying", () => {
    expect(freshnessScore(new Date("2026-09-03T00:00:00.000Z"), NOW, 7)).toBeCloseTo(0.5, 5);
    expect(freshnessScore(new Date("2026-08-27T00:00:00.000Z"), NOW, 7)).toBeCloseTo(0.25, 5);
  });
});

describe("specificityScore", () => {
  it("rewards exact amount and exact date", () => {
    expect(specificityScore({})).toBeCloseTo(0.4, 5);
    expect(specificityScore({ hasExactAmount: true })).toBeCloseTo(0.7, 5);
    expect(specificityScore({ hasExactAmount: true, hasExactDate: true })).toBeCloseTo(1.0, 5);
  });
});

describe("isPredictiveClaim (spec §13)", () => {
  it("treats EXPECTED/PREDICTED/UNCERTAIN as predictions", () => {
    expect(isPredictiveClaim("EXPECTED")).toBe(true);
    expect(isPredictiveClaim("PREDICTED")).toBe(true);
    expect(isPredictiveClaim("UNCERTAIN")).toBe(true);
  });
  it("treats ACTUAL/CONTRACTUAL/RECONCILED as facts", () => {
    expect(isPredictiveClaim("ACTUAL")).toBe(false);
    expect(isPredictiveClaim("CONTRACTUAL")).toBe(false);
    expect(isPredictiveClaim("RECONCILED")).toBe(false);
  });
});

describe("computeConfidence - source vs claim confidence (spec §12)", () => {
  const exact = { hasExactAmount: true, hasExactDate: true };

  it("a reliable source reporting a FACT yields high claim confidence", () => {
    const r = computeConfidence({
      sourceType: "BANK",
      claimType: "ACTUAL",
      observedAt: NOW,
      now: NOW,
      specificity: exact,
    });
    expect(r.isPrediction).toBe(false);
    expect(r.sourceConfidence).toBeCloseTo(0.98, 5); // reliability x freshness
    expect(r.derivedConfidence).toBeCloseTo(0.98, 5); // fact, fully specific
  });

  it("the SAME reliable source reporting a PREDICTION yields much lower claim confidence", () => {
    const fact = computeConfidence({
      sourceType: "BANK",
      claimType: "ACTUAL",
      observedAt: NOW,
      now: NOW,
      specificity: exact,
    });
    const prediction = computeConfidence({
      sourceType: "BANK",
      claimType: "EXPECTED",
      observedAt: NOW,
      now: NOW,
      specificity: exact,
    });
    // Same source, same freshness - so source confidence is identical...
    expect(prediction.sourceConfidence).toBeCloseTo(fact.sourceConfidence, 5);
    // ...but the prediction is far less certain than the fact (§12).
    expect(prediction.derivedConfidence).toBeLessThan(fact.derivedConfidence);
    // With no track record and no corroboration it is capped conservatively.
    expect(prediction.derivedConfidence).toBeLessThanOrEqual(0.98 * 0.6 + 1e-9);
    expect(prediction.completeness).toBe("MINIMAL");
  });

  it("a prediction with a good track record + corroboration beats one without", () => {
    const bare = computeConfidence({
      sourceType: "BANK",
      claimType: "EXPECTED",
      observedAt: NOW,
      now: NOW,
      specificity: exact,
    });
    const informed = computeConfidence({
      sourceType: "BANK",
      claimType: "EXPECTED",
      observedAt: NOW,
      now: NOW,
      specificity: exact,
      historicalAccuracyScore: 0.9,
      consistencyScore: 0.9,
    });
    expect(informed.derivedConfidence).toBeGreaterThan(bare.derivedConfidence);
    expect(informed.completeness).toBe("FULL");
  });

  it("stale evidence lowers both source and claim confidence", () => {
    const fresh = computeConfidence({ sourceType: "ERP", claimType: "CONTRACTUAL", observedAt: NOW, now: NOW });
    const stale = computeConfidence({
      sourceType: "ERP",
      claimType: "CONTRACTUAL",
      observedAt: new Date("2026-08-27T00:00:00.000Z"),
      now: NOW,
    });
    expect(stale.sourceConfidence).toBeLessThan(fresh.sourceConfidence);
    expect(stale.derivedConfidence).toBeLessThan(fresh.derivedConfidence);
  });

  it("keeps every output within [0,1]", () => {
    for (const claimType of ["ACTUAL", "EXPECTED", "PREDICTED", "CONTRACTUAL", "UNCERTAIN"] as const) {
      const r = computeConfidence({ sourceType: "EMAIL", claimType, observedAt: NOW, now: NOW });
      for (const v of [r.reliabilityScore, r.freshnessScore, r.specificityScore, r.sourceConfidence, r.derivedConfidence]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("aggregateClaimConfidence", () => {
  it("returns 0 for no evidence and the strongest otherwise", () => {
    expect(aggregateClaimConfidence([])).toBe(0);
    expect(aggregateClaimConfidence([0.5, 0.9, 0.6])).toBe(0.9);
  });
});
