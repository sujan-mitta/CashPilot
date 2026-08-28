import { describe, it, expect } from "vitest";
import {
  reconcileObservations,
  isSettled,
  needsAttention,
  type SourceObservation,
  type ReconciliationState,
} from "../reconcile";
import { computeConfidence } from "../confidence";

const L5 = 500000_00; // ₹5,00,000 in paise
const SEP5 = new Date("2026-09-05T00:00:00Z");
const SEP10 = new Date("2026-09-10T00:00:00Z");
const SEP12 = new Date("2026-09-12T00:00:00Z");

function obs(
  sourceType: string,
  amount: number | null,
  claimType: SourceObservation["claimType"],
  extra: Partial<SourceObservation> = {}
): SourceObservation {
  return {
    sourceType,
    sourceRecordId: extra.sourceRecordId ?? `${sourceType.toLowerCase()}_1`,
    amount,
    claimType,
    observedAt: extra.observedAt ?? SEP5,
    effectiveAt: extra.effectiveAt ?? null,
    ...extra,
  };
}

const subject = { subjectType: "INVOICE", subjectId: "inv_1" };

function reconcile(observations: SourceObservation[], now = SEP12, expiryDays?: number) {
  return reconcileObservations({ ...subject, observations }, { now, expiryDays });
}

describe("golden scenarios (spec §51)", () => {
  it("Scenario 1: ERP invoice + bank payment = RECONCILED", () => {
    const r = reconcile([
      obs("ERP", L5, "CONTRACTUAL", { effectiveAt: SEP5 }),
      obs("BANK", L5, "ACTUAL"),
    ]);

    expect(r.state).toBe("RECONCILED");
    expect(r.agreedAmount).toBe(L5);
    expect(r.amountDelta).toBe(0);
    expect(r.contradictions).toHaveLength(0);
    expect(isSettled(r.state)).toBe(true);
  });

  it("Scenario 4: commitment passed, bank silent = EXPECTED_EVENT_MISSED", () => {
    const r = reconcile(
      [
        obs("ERP", L5, "CONTRACTUAL", { effectiveAt: SEP5 }),
        obs("EMAIL", L5, "CONFIRMED", { effectiveAt: SEP10 }),
      ],
      SEP12
    );

    expect(r.state).toBe("MISSING");
    expect(r.contradictions.map((c) => c.type)).toContain("EXPECTED_EVENT_MISSED");
    expect(r.contradictions[0].detail).toMatch(/7 day\(s\) ago/);
    expect(needsAttention(r.state)).toBe(true);
  });

  it("Scenario 8: ERP ₹5L, provider ₹5L, bank ₹4.98L = CONFLICT", () => {
    const bankAmount = 498750_00;
    const r = reconcile([
      obs("ERP", L5, "CONTRACTUAL", { effectiveAt: SEP5 }),
      obs("RAZORPAY", L5, "ACTUAL"),
      obs("BANK", bankAmount, "ACTUAL"),
    ]);

    // Emphatically not SUCCESS, and emphatically not silently averaged.
    expect(r.state).toBe("CONFLICT");
    expect(r.agreedAmount).toBeNull();
    expect(r.amountDelta).toBe(L5 - bankAmount);
    expect(r.contradictions.map((c) => c.type)).toContain("AMOUNT_CONFLICT");
    expect(r.contradictions[0].sources).toEqual(["BANK", "ERP", "RAZORPAY"]);
    expect(needsAttention(r.state)).toBe(true);
  });
});

describe("state machine (spec §15)", () => {
  it("UNKNOWN when there is nothing to go on", () => {
    expect(reconcile([]).state).toBe("UNKNOWN");
  });

  it("UNMATCHED when only one source has spoken", () => {
    const r = reconcile([obs("ERP", L5, "CONTRACTUAL")]);
    expect(r.state).toBe("UNMATCHED");
    expect(r.agreedAmount).toBe(L5);
    expect(r.reason).toMatch(/nothing to corroborate/);
  });

  it("CANDIDATE_MATCH when sources overlap but carry no comparable amount", () => {
    const r = reconcile([
      obs("ERP", L5, "CONTRACTUAL"),
      obs("EMAIL", null, "CONFIRMED"),
    ]);
    expect(r.state).toBe("CANDIDATE_MATCH");
  });

  it("MATCHED when amounts agree but no source can settle the question", () => {
    // Two sources agree that money ARRIVED, but neither can observe cash.
    const r = reconcile([
      obs("ERP", L5, "ACTUAL"),
      obs("EMAIL", L5, "ACTUAL"),
    ]);
    expect(r.state).toBe("MATCHED");
    expect(r.agreedAmount).toBe(L5);
    expect(r.reason).toMatch(/none of them can settle/);
  });

  it("does not let an authoritative source verify with a claim that cannot settle", () => {
    // The group is about whether money arrived (the ERP asserts it did). The
    // bank IS the authority on that - but it only *expects* the money, it has
    // not observed it, so its presence must not be mistaken for confirmation.
    const r = reconcile([
      obs("ERP", L5, "ACTUAL"),
      obs("BANK", L5, "EXPECTED"),
    ]);
    expect(r.question).toBe("MONEY_ARRIVED");
    expect(r.state).toBe("MATCHED");
    expect(r.state).not.toBe("RECONCILED");
  });

  it("verifies the obligation question from the ERP alone, which is its to settle", () => {
    // Symmetric check: the ERP is not an authority on cash, but it IS the
    // authority on whether an invoice exists - so this group does reconcile.
    const r = reconcile([
      obs("ERP", L5, "CONTRACTUAL"),
      obs("EMAIL", L5, "CONFIRMED"),
    ]);
    expect(r.question).toBe("OBLIGATION_EXISTS");
    expect(r.state).toBe("RECONCILED");
  });

  it("RECONCILED once an authoritative source has actually observed it", () => {
    const r = reconcile([
      obs("ERP", L5, "CONTRACTUAL"),
      obs("RAZORPAY", L5, "ACTUAL"),
    ]);
    expect(r.state).toBe("RECONCILED");
    expect(r.reason).toMatch(/RAZORPAY confirms/);
  });

  it("DUPLICATE when the same source record is presented twice", () => {
    const r = reconcile([
      obs("BANK", L5, "ACTUAL", { sourceRecordId: "txn_9" }),
      obs("BANK", L5, "ACTUAL", { sourceRecordId: "txn_9" }),
    ]);

    // A redelivered webhook must never look like two sources corroborating.
    expect(r.state).toBe("DUPLICATE");
    expect(r.contradictions[0].type).toBe("DUPLICATE_OBSERVATION");
    expect(r.consistency.every((c) => c.consistencyScore === null)).toBe(true);
  });

  it("distinguishes two genuinely different records from the same source", () => {
    const r = reconcile([
      obs("BANK", L5, "ACTUAL", { sourceRecordId: "txn_9" }),
      obs("ERP", L5, "CONTRACTUAL", { sourceRecordId: "inv_1" }),
    ]);
    expect(r.state).not.toBe("DUPLICATE");
  });

  it("EXPIRED only when an expiry policy was supplied", () => {
    const observations = [obs("ERP", L5, "CONTRACTUAL", { effectiveAt: SEP5 })];

    // No policy: it stays MISSING rather than being silently written off.
    expect(reconcile(observations, SEP12).state).toBe("MISSING");
    expect(reconcile(observations, SEP12, 5).state).toBe("EXPIRED");
    expect(reconcile(observations, SEP12, 30).state).toBe("MISSING");
  });

  it("does not call an expectation missed before it comes due", () => {
    const r = reconcile(
      [obs("ERP", L5, "CONTRACTUAL", { effectiveAt: SEP10 })],
      SEP5
    );
    expect(r.state).toBe("UNMATCHED");
    expect(r.contradictions).toHaveLength(0);
  });

  it("stops reporting a miss once the money is actually observed", () => {
    const r = reconcile([
      obs("ERP", L5, "CONTRACTUAL", { effectiveAt: SEP5 }),
      obs("BANK", L5, "ACTUAL"),
    ], SEP12);
    expect(r.state).toBe("RECONCILED");
    expect(r.contradictions).toHaveLength(0);
  });
});

describe("conflict handling (spec §14, §64)", () => {
  it("never averages, picks a winner, or invents a number", () => {
    const r = reconcile([
      obs("BANK", 100_00, "ACTUAL"),
      obs("RAZORPAY", 200_00, "ACTUAL"),
    ]);
    expect(r.state).toBe("CONFLICT");
    expect(r.agreedAmount).toBeNull();
    // Not 150_00, and not the bank's number just because the bank is reliable.
    expect(r.amountDelta).toBe(100_00);
  });

  it("treats a sub-percent difference as material by default", () => {
    const r = reconcile([obs("ERP", L5, "ACTUAL"), obs("BANK", L5 - 125, "ACTUAL")]);
    expect(r.state).toBe("CONFLICT");
  });

  it("honours an explicit tolerance when one is set as policy", () => {
    const r = reconcileObservations(
      { ...subject, observations: [obs("ERP", L5, "CONTRACTUAL"), obs("BANK", L5 - 125, "ACTUAL")] },
      { now: SEP12, amountToleranceMinor: 200 }
    );
    expect(r.state).toBe("RECONCILED");
    expect(r.amountDelta).toBe(125);
  });

  it("reports every disagreeing source in the contradiction", () => {
    const r = reconcile([
      obs("ERP", L5, "CONTRACTUAL"),
      obs("BANK", 400000_00, "ACTUAL"),
      obs("RAZORPAY", L5, "ACTUAL"),
    ]);
    expect(r.contradictions[0].detail).toMatch(/BANK reports 40000000/);
    expect(r.contradictions[0].detail).toMatch(/ERP\/RAZORPAY reports 50000000/);
  });
});

describe("cross-source consistency scoring", () => {
  it("scores a corroborated observation high and a contradicted one low", () => {
    const r = reconcile([
      obs("BANK", L5, "ACTUAL"),
      obs("RAZORPAY", L5, "ACTUAL"),
      obs("ERP", 400000_00, "ACTUAL"),
    ]);

    const bank = r.consistency.find((c) => c.sourceType === "BANK")!;
    const erp = r.consistency.find((c) => c.sourceType === "ERP")!;

    // BANK is backed by RAZORPAY and contradicted only by the far weaker ERP.
    expect(bank.consistencyScore!).toBeGreaterThan(0.6);
    // ERP is the lone dissenter against both cash-authoritative sources.
    expect(erp.consistencyScore).toBe(0);
    expect(bank.consistencyScore!).toBeGreaterThan(erp.consistencyScore!);
  });

  it("weights corroboration by how much the corroborating source knows (§16)", () => {
    // Same shape twice; only the identity of the agreeing source changes.
    const backedByBank = reconcile([
      obs("ERP", L5, "ACTUAL"),
      obs("BANK", L5, "ACTUAL"),
    ]);
    const backedByHistory = reconcile([
      obs("ERP", L5, "ACTUAL"),
      obs("HISTORICAL", L5, "ACTUAL"),
    ]);

    const a = backedByBank.consistency.find((c) => c.sourceType === "ERP")!.consistencyScore!;
    const b = backedByHistory.consistency.find((c) => c.sourceType === "ERP")!.consistencyScore!;

    // Both are full agreement, so both are 1 - the weighting shows up when
    // sources DISAGREE, which the next test covers.
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it("penalises disagreement more when the dissenting source is the authority", () => {
    const bankDissents = reconcile([
      obs("ERP", L5, "ACTUAL"),
      obs("BANK", 1, "ACTUAL"),
      obs("HISTORICAL", L5, "ACTUAL"),
    ]);
    const historyDissents = reconcile([
      obs("ERP", L5, "ACTUAL"),
      obs("BANK", L5, "ACTUAL"),
      obs("HISTORICAL", 1, "ACTUAL"),
    ]);

    const erpWhenBankDissents = bankDissents.consistency.find((c) => c.sourceType === "ERP")!
      .consistencyScore!;
    const erpWhenHistoryDissents = historyDissents.consistency.find((c) => c.sourceType === "ERP")!
      .consistencyScore!;

    // Being contradicted by the bank about cash hurts far more than being
    // contradicted by a behavioural model.
    expect(erpWhenBankDissents).toBeLessThan(erpWhenHistoryDissents);
  });

  it("returns null - not zero - when there is nothing to check against", () => {
    const r = reconcile([obs("ERP", L5, "CONTRACTUAL")]);
    expect(r.consistency[0].consistencyScore).toBeNull();
  });

  it("returns null for an observation that carries no amount", () => {
    const r = reconcile([obs("ERP", L5, "CONTRACTUAL"), obs("EMAIL", null, "CONFIRMED")]);
    expect(r.consistency.find((c) => c.sourceType === "EMAIL")!.consistencyScore).toBeNull();
  });

  it("scores every observation exactly once", () => {
    const observations = [
      obs("ERP", L5, "CONTRACTUAL"),
      obs("BANK", L5, "ACTUAL"),
      obs("EMAIL", null, "CONFIRMED"),
    ];
    const r = reconcile(observations);
    expect(r.consistency).toHaveLength(observations.length);
  });
});

describe("closing the Phase 3 gap: consistency lifts the prediction cap", () => {
  const base = {
    sourceType: "ERP",
    claimType: "EXPECTED" as const,
    observedAt: SEP12,
    now: SEP12,
    specificity: { hasExactAmount: true, hasExactDate: true },
  };

  it("caps an uncorroborated prediction, as Phase 3 did on its own", () => {
    const c = computeConfidence({ ...base, consistencyScore: null });
    expect(c.completeness).toBe("MINIMAL");
    // reliability x freshness x 0.6 cap
    expect(c.derivedConfidence).toBeCloseTo(0.9 * 1 * 0.6, 10);
  });

  it("lets a corroborated prediction exceed the cap", () => {
    const r = reconcile([obs("ERP", L5, "EXPECTED"), obs("BANK", L5, "EXPECTED")]);
    const consistency = r.consistency.find((c) => c.sourceType === "ERP")!.consistencyScore!;

    const uncorroborated = computeConfidence({ ...base, consistencyScore: null });
    const corroborated = computeConfidence({ ...base, consistencyScore: consistency });

    expect(consistency).toBe(1);
    expect(corroborated.completeness).toBe("PARTIAL");
    expect(corroborated.derivedConfidence).toBeGreaterThan(uncorroborated.derivedConfidence);
    // The 0.6 ceiling that Phase 3 could not get past is now genuinely earned past.
    expect(corroborated.derivedConfidence).toBeGreaterThan(0.6);
  });

  it("drops confidence below the uncorroborated baseline when sources contradict", () => {
    const r = reconcile([obs("ERP", L5, "EXPECTED"), obs("BANK", 1, "EXPECTED")]);
    const consistency = r.consistency.find((c) => c.sourceType === "ERP")!.consistencyScore!;

    const contradicted = computeConfidence({ ...base, consistencyScore: consistency });
    const uncorroborated = computeConfidence({ ...base, consistencyScore: null });

    expect(consistency).toBe(0);
    expect(contradicted.derivedConfidence).toBeLessThan(uncorroborated.derivedConfidence);
  });
});

describe("determinism", () => {
  it("is independent of the order observations arrive in", () => {
    const a = obs("ERP", L5, "CONTRACTUAL", { effectiveAt: SEP5 });
    const b = obs("BANK", L5, "ACTUAL");
    const c = obs("RAZORPAY", L5, "ACTUAL");

    const forward = reconcile([a, b, c]);
    const backward = reconcile([c, b, a]);

    expect(forward.state).toBe(backward.state);
    expect(forward.agreedAmount).toBe(backward.agreedAmount);
    expect(forward.amountDelta).toBe(backward.amountDelta);
  });

  it("produces the same outcome on repeated calls", () => {
    const observations = [obs("ERP", L5, "CONTRACTUAL"), obs("BANK", 1, "ACTUAL")];
    const first = reconcile(observations);
    for (let i = 0; i < 5; i++) expect(reconcile(observations)).toEqual(first);
  });

  it("classifies every reachable state as settled or not, never both", () => {
    const states: ReconciliationState[] = [
      "UNMATCHED",
      "CANDIDATE_MATCH",
      "MATCHED",
      "VERIFIED",
      "RECONCILED",
      "CONFLICT",
      "DUPLICATE",
      "MISSING",
      "EXPIRED",
      "UNKNOWN",
    ];
    for (const s of states) {
      expect(isSettled(s) && needsAttention(s)).toBe(false);
    }
  });
});
