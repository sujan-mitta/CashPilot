import { describe, it, expect } from "vitest";
import {
  computePaymentBehavior,
  computePredictionAccuracy,
  type PaymentObservation,
} from "../paymentBehavior";
import { combineConfidence } from "@/lib/evidence/confidence";

const NOW = new Date("2026-09-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

/** A payment that was `delay` days late, settling `daysAgo` before now. */
function pay(id: string, delay: number, daysAgo: number, amount = 100_00): PaymentObservation {
  const paidDate = at(-daysAgo);
  return { id, amount, dueDate: new Date(paidDate.getTime() - delay * DAY), paidDate };
}

const opts = { now: NOW };

describe("insufficient history yields no opinion (spec §64)", () => {
  it("says nothing at all from zero payments", () => {
    const b = computePaymentBehavior([], opts);
    expect(b.sufficiency).toBe("INSUFFICIENT");
    expect(b.confidence).toBe("UNKNOWN");
    expect(b.expectedDelayDays).toBeNull();
    expect(b.averageDelayDays).toBeNull();
    expect(b.basis).toEqual([]);
  });

  it("says nothing from one or two payments, however consistent", () => {
    // Two identical late payments still are not a pattern.
    for (const n of [1, 2]) {
      const b = computePaymentBehavior(
        Array.from({ length: n }, (_, i) => pay(`p${i}`, 6, 10 + i)),
        opts
      );
      expect(b.sufficiency).toBe("INSUFFICIENT");
      expect(b.expectedDelayDays).toBeNull();
    }
  });

  it("reports metrics but refuses to move a forecast on 3-4 payments", () => {
    const b = computePaymentBehavior([pay("a", 4, 10), pay("b", 4, 20), pay("c", 4, 30)], opts);
    expect(b.sufficiency).toBe("SPARSE");
    expect(b.averageDelayDays).toBe(4); // observable
    expect(b.expectedDelayDays).toBeNull(); // but not actionable
    expect(b.confidence).toBe("UNKNOWN");
  });

  it("excludes malformed rows rather than averaging them in", () => {
    const bad = { id: "bad", amount: 1, dueDate: new Date("nonsense"), paidDate: NOW };
    const b = computePaymentBehavior(
      [pay("a", 4, 10), pay("b", 4, 20), pay("c", 4, 30), pay("d", 4, 40), pay("e", 4, 50), bad],
      opts
    );
    expect(b.paymentHistorySampleSize).toBe(5);
    expect(b.averageDelayDays).toBe(4);
  });
});

describe("a settled pattern moves the expectation", () => {
  const consistentlyLate = [
    pay("a", 4, 5),
    pay("b", 4, 20),
    pay("c", 4, 35),
    pay("d", 4, 50),
    pay("e", 4, 65),
  ];

  it("expects a reliably-late customer to be late", () => {
    const b = computePaymentBehavior(consistentlyLate, opts);
    expect(b.sufficiency).toBe("SUFFICIENT");
    expect(b.expectedDelayDays).toBe(4);
    expect(b.onTimeRate).toBe(0);
    expect(b.behaviorStability).toBe(1); // zero variance
    expect(b.confidence).toBe("MEDIUM");
  });

  it("expects an early payer to be early", () => {
    const b = computePaymentBehavior(
      [pay("a", -3, 5), pay("b", -3, 20), pay("c", -3, 35), pay("d", -3, 50), pay("e", -3, 65)],
      opts
    );
    expect(b.expectedDelayDays).toBe(-3);
    expect(b.onTimeRate).toBe(1);
  });

  it("gives a reason a person could read", () => {
    const b = computePaymentBehavior(consistentlyLate, opts);
    expect(b.basis.length).toBeGreaterThan(0);
    expect(b.basis[0]).toMatch(/5 settled payments, averaging 4 day\(s\) late/);
  });

  it("rates a long, consistent history HIGH and an erratic one lower", () => {
    const steady = Array.from({ length: 12 }, (_, i) => pay(`s${i}`, 4, i * 7 + 1));
    const erratic = Array.from({ length: 12 }, (_, i) =>
      pay(`e${i}`, i % 2 === 0 ? -5 : 20, i * 7 + 1)
    );

    expect(computePaymentBehavior(steady, opts).confidence).toBe("HIGH");
    expect(computePaymentBehavior(erratic, opts).confidence).toBe("LOW");
    expect(computePaymentBehavior(erratic, opts).behaviorStability).toBeLessThan(0.3);
  });
});

describe("behaviour adapts over time (spec §26)", () => {
  it("moves toward on-time when a late payer reforms, without ignoring history", () => {
    // The spec's own example: historically +4, last five on time.
    const observations = [
      ...Array.from({ length: 10 }, (_, i) => pay(`old${i}`, 4, 120 + i * 10)),
      ...Array.from({ length: 5 }, (_, i) => pay(`new${i}`, 0, 5 + i * 10)),
    ];
    const b = computePaymentBehavior(observations, opts);

    // Strictly better than the raw historical average...
    expect(b.expectedDelayDays!).toBeLessThan(b.averageDelayDays!);
    // ...but not a full reset to zero: five good payments is not a guarantee.
    expect(b.expectedDelayDays!).toBeGreaterThan(0);
    expect(b.delayTrendDays!).toBeLessThan(0);
    expect(b.basis.some((r) => /improved/.test(r))).toBe(true);
  });

  it("reacts when behaviour deteriorates", () => {
    const observations = [
      ...Array.from({ length: 10 }, (_, i) => pay(`old${i}`, 3, 120 + i * 10)),
      ...Array.from({ length: 5 }, (_, i) => pay(`new${i}`, 8, 5 + i * 10)),
    ];
    const b = computePaymentBehavior(observations, opts);

    expect(b.expectedDelayDays!).toBeGreaterThan(b.averageDelayDays!);
    expect(b.delayTrendDays!).toBeGreaterThan(0);
    expect(b.basis.some((r) => /deteriorated/.test(r))).toBe(true);
  });

  it("weights recent behaviour more as more of it accumulates", () => {
    const old = Array.from({ length: 10 }, (_, i) => pay(`old${i}`, 10, 200 + i * 10));
    const oneRecent = computePaymentBehavior([...old, pay("n0", 0, 5)], opts);
    const fiveRecent = computePaymentBehavior(
      [...old, ...Array.from({ length: 5 }, (_, i) => pay(`n${i}`, 0, 5 + i * 5))],
      opts
    );

    // More recent evidence pulls the expectation further from the old average.
    expect(fiveRecent.expectedDelayDays!).toBeLessThan(oneRecent.expectedDelayDays!);
  });

  it("caps recency so a long history is never entirely erased", () => {
    const old = Array.from({ length: 20 }, (_, i) => pay(`old${i}`, 10, 200 + i * 10));
    const recent = Array.from({ length: 20 }, (_, i) => pay(`new${i}`, 0, 1 + i * 3));
    const b = computePaymentBehavior([...old, ...recent], opts);

    // Even with overwhelming recent evidence, the expectation stays above 0.
    expect(b.expectedDelayDays!).toBeGreaterThan(0);
  });

  it("reports no trend when there is history on only one side of the window", () => {
    const b = computePaymentBehavior(
      Array.from({ length: 6 }, (_, i) => pay(`p${i}`, 4, 5 + i * 5)),
      opts
    );
    expect(b.delayTrendDays).toBeNull();
  });
});

describe("sample-size naming (spec §25)", () => {
  it("never exposes an ambiguous `sampleSize` field", () => {
    const b = computePaymentBehavior([pay("a", 1, 1)], opts);
    const a = computePredictionAccuracy([]);
    expect(Object.keys(b)).not.toContain("sampleSize");
    expect(Object.keys(a)).not.toContain("sampleSize");
  });

  it("names what each count actually counts", () => {
    const b = computePaymentBehavior([pay("a", 1, 1), pay("b", 1, 200)], opts);
    expect(b.paymentHistorySampleSize).toBe(2);
    expect(b.recentSampleSize).toBe(1);
    expect(computePredictionAccuracy([]).forecastObservationCount).toBe(0);
  });
});

describe("prediction accuracy (spec §27) — the other half of the Phase 3 gap", () => {
  const pred = (predicted: number, actual: number) => ({
    predictedDate: at(predicted),
    actualDate: at(actual),
  });

  it("returns null - not zero - when there is nothing to measure", () => {
    // Zero would read as "measured and terrible" rather than "not measured".
    const a = computePredictionAccuracy([]);
    expect(a.accuracyScore).toBeNull();
    expect(a.meanAbsoluteErrorDays).toBeNull();
  });

  it("refuses an opinion from fewer than three observations", () => {
    expect(computePredictionAccuracy([pred(1, 1), pred(2, 2)]).accuracyScore).toBeNull();
  });

  it("scores perfect predictions 1.0", () => {
    const a = computePredictionAccuracy([pred(1, 1), pred(2, 2), pred(3, 3)]);
    expect(a.accuracyScore).toBe(1);
    expect(a.meanAbsoluteErrorDays).toBe(0);
  });

  it("degrades smoothly as error grows", () => {
    const small = computePredictionAccuracy([pred(0, 1), pred(0, 1), pred(0, 1)]);
    const large = computePredictionAccuracy([pred(0, 12), pred(0, 12), pred(0, 12)]);
    expect(small.accuracyScore!).toBeGreaterThan(large.accuracyScore!);
    expect(large.accuracyScore!).toBeLessThan(0.3);
  });

  it("distinguishes systematic bias from noise", () => {
    // Always 4 days late: same MAE as +4/-4 noise, but the signed error differs.
    const biased = computePredictionAccuracy([pred(0, 4), pred(0, 4), pred(0, 4)]);
    const noisy = computePredictionAccuracy([pred(0, 4), pred(0, -4), pred(0, 4)]);
    expect(biased.meanSignedErrorDays).toBe(4);
    expect(Math.abs(noisy.meanSignedErrorDays!)).toBeLessThan(2);
  });

  it("closes C-1: a prediction with a track record can exceed the 0.6 cap", () => {
    const accuracy = computePredictionAccuracy([pred(0, 0), pred(1, 1), pred(2, 2)]);

    const base = {
      claimType: "EXPECTED" as const,
      reliabilityScore: 0.9,
      freshnessScore: 1,
      specificityScore: 1,
      consistencyScore: null,
    };
    const uncalibrated = combineConfidence({ ...base, historicalAccuracyScore: null });
    const calibrated = combineConfidence({
      ...base,
      historicalAccuracyScore: accuracy.accuracyScore,
    });

    expect(uncalibrated.completeness).toBe("MINIMAL");
    expect(uncalibrated.derivedConfidence).toBeCloseTo(0.9 * 0.6, 10);
    expect(calibrated.completeness).toBe("PARTIAL");
    expect(calibrated.derivedConfidence).toBeGreaterThan(0.6);
  });

  it("reaches FULL completeness with both P5 consistency and P9 accuracy", () => {
    const both = combineConfidence({
      claimType: "EXPECTED",
      reliabilityScore: 0.9,
      freshnessScore: 1,
      specificityScore: 1,
      consistencyScore: 1,
      historicalAccuracyScore: 1,
    });
    expect(both.completeness).toBe("FULL");
  });
});

describe("determinism", () => {
  it("is independent of observation order", () => {
    const obs = Array.from({ length: 8 }, (_, i) => pay(`p${i}`, i % 4, i * 12 + 1));
    const a = computePaymentBehavior(obs, opts);
    const b = computePaymentBehavior([...obs].reverse(), opts);
    expect(a).toEqual(b);
  });

  it("returns the same profile on repeated calls", () => {
    const obs = Array.from({ length: 6 }, (_, i) => pay(`p${i}`, 3, i * 20 + 1));
    const first = computePaymentBehavior(obs, opts);
    for (let i = 0; i < 3; i++) expect(computePaymentBehavior(obs, opts)).toEqual(first);
  });
});
