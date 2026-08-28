import { describe, it, expect } from "vitest";
import {
  readProviderPaidAmount,
  validateSettlementAmount,
  describeRejection,
  MAX_SINGLE_SETTLEMENT_PAISE,
} from "../amounts";

/**
 * PROVIDER-REPORTED AMOUNTS
 *
 * An amount in a webhook payload is an ASSERTION by an outside party. Two live
 * defects came from treating it as a fact:
 *
 *   1. `amount_paid || amount` - a partial payment reporting `amount_paid: 0`
 *      is falsy, so the fallback credited the FULL face value of the link for
 *      money that had not arrived.
 *   2. The figure went into `currentCash: { increment }` with no validation, so
 *      a negative or absurd value would have moved a real balance by it.
 */
describe("readProviderPaidAmount — the zero-is-falsy defect", () => {
  it("THE BUG: a fully unpaid link reports amount_paid: 0 and must NOT fall back to the face amount", () => {
    // `amount_paid || amount` returned 500000 here, crediting the whole invoice
    // for a link nobody had paid.
    const result = readProviderPaidAmount({ amount: 500000, amount_paid: 0 });
    expect(result).toEqual({ ok: true, amount: 0 });
  });

  it("a PARTIAL payment settles for what arrived, not what was owed", () => {
    const result = readProviderPaidAmount({ amount: 500000, amount_paid: 120000 });
    expect(result.ok && result.amount).toBe(120000);
  });

  it("an OVERPAYMENT is reported as-is, so reconciliation can flag it", () => {
    const result = readProviderPaidAmount({ amount: 500000, amount_paid: 750000 });
    expect(result.ok && result.amount).toBe(750000);
  });

  it("falls back to the face amount only when amount_paid is genuinely ABSENT", () => {
    expect(readProviderPaidAmount({ amount: 500000 })).toEqual({ ok: true, amount: 500000 });
  });

  it("treats an explicit null amount_paid as absent, not as zero", () => {
    // `null ?? amount` falls through, which is correct: null is "the provider
    // did not tell us", whereas 0 is "the provider told us nothing was paid".
    expect(readProviderPaidAmount({ amount: 500000, amount_paid: null })).toEqual({
      ok: true,
      amount: 500000,
    });
  });

  it("reports MISSING when the entity carries no amount at all", () => {
    expect(readProviderPaidAmount({})).toMatchObject({ ok: false, reason: "MISSING" });
    expect(readProviderPaidAmount(null)).toMatchObject({ ok: false, reason: "MISSING" });
    expect(readProviderPaidAmount(undefined)).toMatchObject({ ok: false, reason: "MISSING" });
  });
});

describe("validateSettlementAmount — what may reach a balance", () => {
  it("accepts zero", () => {
    // Zero is a real, meaningful answer, not an absence.
    expect(validateSettlementAmount(0)).toEqual({ ok: true, amount: 0 });
  });

  it("accepts the largest allowed single settlement", () => {
    expect(validateSettlementAmount(MAX_SINGLE_SETTLEMENT_PAISE)).toEqual({
      ok: true,
      amount: MAX_SINGLE_SETTLEMENT_PAISE,
    });
  });

  it("rejects one paise beyond the ceiling", () => {
    expect(validateSettlementAmount(MAX_SINGLE_SETTLEMENT_PAISE + 1)).toMatchObject({
      ok: false,
      reason: "IMPLAUSIBLY_LARGE",
    });
  });

  it("rejects a NEGATIVE amount — a settlement never removes money", () => {
    // Without this, a payload of -10000000 silently DEBITED a real balance.
    expect(validateSettlementAmount(-1)).toMatchObject({ ok: false, reason: "NEGATIVE" });
    expect(validateSettlementAmount(-10_000_000)).toMatchObject({ ok: false, reason: "NEGATIVE" });
  });

  it("rejects a fractional paise", () => {
    // Money is an integer number of paise everywhere in this system. A
    // fraction is corrupt data, not something to round.
    expect(validateSettlementAmount(100.5)).toMatchObject({ ok: false, reason: "NOT_AN_INTEGER" });
  });

  it("rejects NaN and the infinities", () => {
    expect(validateSettlementAmount(NaN)).toMatchObject({ ok: false, reason: "NOT_A_NUMBER" });
    expect(validateSettlementAmount(Infinity)).toMatchObject({ ok: false, reason: "NOT_A_NUMBER" });
    expect(validateSettlementAmount(-Infinity)).toMatchObject({ ok: false, reason: "NOT_A_NUMBER" });
  });

  it("rejects a numeric STRING rather than coercing it", () => {
    // "1000" + a balance is string concatenation in a language that would
    // happily do it. Refuse at the boundary.
    expect(validateSettlementAmount("1000")).toMatchObject({ ok: false, reason: "NOT_A_NUMBER" });
  });

  it("rejects objects, arrays and booleans", () => {
    for (const value of [{}, [], [1000], true, false]) {
      expect(validateSettlementAmount(value).ok).toBe(false);
    }
  });

  it("rejects a value beyond the safe integer range, where arithmetic stops being exact", () => {
    expect(validateSettlementAmount(Number.MAX_SAFE_INTEGER + 10).ok).toBe(false);
  });
});

describe("describeRejection", () => {
  it("gives a reason for every rejection kind and never echoes the value", () => {
    const reasons = [
      "MISSING",
      "NOT_A_NUMBER",
      "NOT_AN_INTEGER",
      "NEGATIVE",
      "IMPLAUSIBLY_LARGE",
    ] as const;
    for (const reason of reasons) {
      const text = describeRejection(reason);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/\d{4,}/); // no raw amounts in an operator-facing string
    }
  });
});
