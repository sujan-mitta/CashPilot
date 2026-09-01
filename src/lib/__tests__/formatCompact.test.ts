import { describe, it, expect } from "vitest";
import { formatINR, formatINRCompact } from "../format";

/**
 * Short amounts for scanning, exact amounts for acting.
 *
 * ₹2,81,428 and ₹3,21,428 differ by a lakh and are nearly indistinguishable at
 * a glance — the eye parses seven digits and two separators before the
 * difference appears. Rounded, the comparison is immediate.
 *
 * The rounding is why this must never reach anything acted upon. A payment
 * amount, an invoice total, or a figure reconciled against a provider has to be
 * exact; "roughly where do I stand" does not.
 */

const L = (rupees: number) => Math.round(rupees * 100);

describe("Lakhs and crores", () => {
  it("renders lakhs", () => {
    expect(formatINRCompact(L(281_428))).toBe("₹2.81L");
    expect(formatINRCompact(L(1_000_000))).toBe("₹10L");
  });

  it("renders crores", () => {
    expect(formatINRCompact(L(12_000_000))).toBe("₹1.2Cr");
    expect(formatINRCompact(L(10_000_000))).toBe("₹1Cr");
  });

  it("drops trailing zeros, which add width and no information", () => {
    expect(formatINRCompact(L(300_000))).toBe("₹3L");
    expect(formatINRCompact(L(280_000))).toBe("₹2.8L");
  });

  it("keeps the sign", () => {
    expect(formatINRCompact(L(-200_000))).toBe("₹-2L");
  });
});

describe("Below a lakh it does not round at all", () => {
  it("falls through to the exact formatter", () => {
    // Rounding here would discard precision on amounts people track to the
    // rupee, and the plain figure is already short enough to scan.
    for (const r of [0, 500, 40_000, 99_999]) {
      expect(formatINRCompact(L(r))).toBe(formatINR(L(r)));
    }
  });

  it("switches to lakhs exactly at one lakh", () => {
    expect(formatINRCompact(L(99_999))).toBe(formatINR(L(99_999)));
    expect(formatINRCompact(L(100_000))).toBe("₹1L");
  });
});

describe("It is a summary, never a source of truth", () => {
  it("loses precision, which is why the exact value must stay available", () => {
    // This test exists to record the trade-off rather than to defend it: the
    // compact form is deliberately lossy, so every caller pairs it with the
    // exact amount.
    const exact = L(281_428);
    expect(formatINRCompact(exact)).toBe("₹2.81L");
    expect(formatINR(exact)).toBe("₹2,81,428");
    expect(formatINRCompact(exact)).not.toBe(formatINR(exact));
  });

  it("never renders a bare number without its unit", () => {
    for (const r of [150_000, 25_000_000, -750_000]) {
      expect(formatINRCompact(L(r))).toMatch(/(L|Cr)$/);
    }
  });
});
