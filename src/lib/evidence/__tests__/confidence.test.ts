import { describe, it, expect } from "vitest";
import {
  sourceReliability,
  freshnessScore,
  provisionalConfidence,
  aggregateClaimConfidence,
} from "../confidence";

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

  it("keeps every reliability within [0,1]", () => {
    for (const s of ["BANK", "RAZORPAY", "ERP", "INVOICE", "USER", "HISTORICAL", "EMAIL", "X"]) {
      const r = sourceReliability(s);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
  });
});

describe("freshnessScore", () => {
  const now = new Date("2026-09-10T00:00:00.000Z");

  it("is 1.0 at the moment of observation", () => {
    expect(freshnessScore(now, now)).toBe(1);
  });

  it("clamps future observations (clock skew) to 1.0", () => {
    const future = new Date("2026-09-11T00:00:00.000Z");
    expect(freshnessScore(future, now)).toBe(1);
  });

  it("halves after one half-life and keeps decaying", () => {
    const oneHalfLife = new Date("2026-09-03T00:00:00.000Z"); // 7 days before now
    expect(freshnessScore(oneHalfLife, now, 7)).toBeCloseTo(0.5, 5);
    const twoHalfLives = new Date("2026-08-27T00:00:00.000Z"); // 14 days
    expect(freshnessScore(twoHalfLives, now, 7)).toBeCloseTo(0.25, 5);
  });

  it("stays within [0,1] for very stale evidence", () => {
    const ancient = new Date("2020-01-01T00:00:00.000Z");
    const f = freshnessScore(ancient, now);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(1);
  });
});

describe("provisionalConfidence (Phase 2 stand-in)", () => {
  it("returns reliability as the aggregate and tracks freshness separately", () => {
    const now = new Date("2026-09-10T00:00:00.000Z");
    const c = provisionalConfidence("BANK", now, now);
    expect(c.reliabilityScore).toBe(sourceReliability("BANK"));
    expect(c.freshnessScore).toBe(1);
    // Provisional: aggregate equals reliability until Phase 3.
    expect(c.derivedConfidence).toBe(c.reliabilityScore);
  });
});

describe("aggregateClaimConfidence", () => {
  it("returns 0 for no evidence", () => {
    expect(aggregateClaimConfidence([])).toBe(0);
  });

  it("takes the strongest supporting evidence", () => {
    expect(aggregateClaimConfidence([0.5, 0.9, 0.6])).toBe(0.9);
  });
});
