import { describe, it, expect } from "vitest";
import { describeSafetyProgress } from "../safetyProgress";

/**
 * "Where am I, and how much further?"
 *
 * An operator part-way through a recovery is asking three things at once: what
 * landed, whether it was enough, and what is still available if it was not.
 * Those have exact answers, and getting them subtly wrong is easy — which is
 * why the arithmetic lives in a tested function rather than in a component.
 */

const L = (rupees: number) => rupees * 100; // paise

const base = {
  projectedLow: L(100_000),
  safeFloor: L(278_571),
  recovered: 0,
  outstanding: 0,
};

describe("Safety is judged on the PROJECTION, never today's cash", () => {
  it("reports SAFE when the low stays above the floor", () => {
    const r = describeSafetyProgress({ ...base, projectedLow: L(400_000) });
    expect(r.status).toBe("SAFE");
    expect(r.shortfall).toBe(0);
  });

  it("reports SHORTFALL when the low dips below, however healthy today looks", () => {
    // A business can hold plenty right now and still miss payroll on the 5th.
    // Judging on current cash would call it safe on exactly the days it most
    // needs the warning.
    const r = describeSafetyProgress({ ...base, projectedLow: L(-200_000) });
    expect(r.status).toBe("SHORTFALL");
    expect(r.shortfall).toBe(L(278_571) + L(200_000));
  });

  it("treats sitting exactly on the floor as safe", () => {
    const r = describeSafetyProgress({ ...base, projectedLow: L(278_571) });
    expect(r.status).toBe("SAFE");
    expect(r.shortfall).toBe(0);
  });

  it("never reports a negative shortfall", () => {
    // "A shortfall of minus three lakh" is not a thing.
    const r = describeSafetyProgress({ ...base, projectedLow: L(900_000) });
    expect(r.shortfall).toBe(0);
    expect(r.stillNeededBeyondOutstanding).toBe(0);
  });
});

describe("Outstanding links are possibilities, not money", () => {
  const short = { ...base, projectedLow: L(0), safeFloor: L(100_000) }; // gap = 1,00,000

  it("never lets an unpaid link make the status SAFE", () => {
    // Counting an unpaid link as cash is the same error as banking an overdue
    // receivable: it flatters the numbers in the direction that gets a company
    // into trouble.
    const r = describeSafetyProgress({ ...short, outstanding: L(500_000) });
    expect(r.status).toBe("SHORTFALL");
    expect(r.shortfall).toBe(L(100_000));
  });

  it("says so when the links out would cover the gap", () => {
    const r = describeSafetyProgress({ ...short, outstanding: L(150_000) });
    expect(r.outstandingCoversShortfall).toBe(true);
    expect(r.stillNeededBeyondOutstanding).toBe(0);
    expect(r.detail).toMatch(/nothing new needs to be created/i);
  });

  it("counts exactly-enough as covering", () => {
    const r = describeSafetyProgress({ ...short, outstanding: L(100_000) });
    expect(r.outstandingCoversShortfall).toBe(true);
  });

  it("reports the true remaining need when links fall short", () => {
    const r = describeSafetyProgress({ ...short, outstanding: L(40_000) });
    expect(r.outstandingCoversShortfall).toBe(false);
    expect(r.stillNeededBeyondOutstanding).toBe(L(60_000));
  });

  it("reports the whole gap when nothing is out", () => {
    const r = describeSafetyProgress({ ...short, outstanding: 0 });
    expect(r.stillNeededBeyondOutstanding).toBe(L(100_000));
    expect(r.detail).toMatch(/nothing is currently out/i);
  });
});

describe("What it says to a non-specialist", () => {
  it("acknowledges recovery that already worked", () => {
    const r = describeSafetyProgress({
      projectedLow: L(400_000),
      safeFloor: L(278_571),
      recovered: L(240_000),
      outstanding: 0,
    });
    expect(r.headline).toMatch(/above your safe floor/i);
    expect(r.detail).toMatch(/was enough/i);
  });

  it("does not claim a recovery happened when none did", () => {
    const r = describeSafetyProgress({ ...base, projectedLow: L(400_000), recovered: 0 });
    expect(r.detail).not.toMatch(/recovered/i);
  });

  it("always carries a headline and a sentence worth reading", () => {
    const cases = [
      { ...base, projectedLow: L(400_000) },
      { ...base, projectedLow: L(0), outstanding: L(999_999) },
      { ...base, projectedLow: L(0), outstanding: L(1) },
      { ...base, projectedLow: L(0) },
    ];
    for (const c of cases) {
      const r = describeSafetyProgress(c);
      expect(r.headline.length).toBeGreaterThan(10);
      expect(r.detail.length).toBeGreaterThan(40);
    }
  });
});
