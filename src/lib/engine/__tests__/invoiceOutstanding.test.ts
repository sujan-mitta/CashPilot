import { describe, it, expect } from "vitest";
import {
  outstandingAmount,
  confirmedPaid,
  isFullySettled,
  statusAfterPayment,
  totalOutstanding,
} from "../invoiceOutstanding";

/**
 * What an invoice is still expected to deliver.
 *
 * Covers the cases spec §17 names: zero payment, partial, multiple partials,
 * full, overpayment, and duplicates. The direction of every error matters —
 * overstating outstanding overstates expected inflow and makes the runway look
 * healthier than it is.
 */

const inv = (amount: number, paidAmount?: number | null, status?: string) => ({
  amount,
  paidAmount,
  status,
});

describe("Outstanding on a single invoice", () => {
  it("is the full amount when nothing has been paid", () => {
    expect(outstandingAmount(inv(1_000_000, 0))).toBe(1_000_000);
    expect(outstandingAmount(inv(1_000_000, null))).toBe(1_000_000);
    expect(outstandingAmount(inv(1_000_000))).toBe(1_000_000);
  });

  it("is the remainder after a part payment", () => {
    // ₹10,00,000 invoice, ₹6,00,000 received, ₹4,00,000 still expected.
    expect(outstandingAmount(inv(1_000_000, 600_000))).toBe(400_000);
  });

  it("is zero once fully paid", () => {
    expect(outstandingAmount(inv(1_000_000, 1_000_000))).toBe(0);
    expect(isFullySettled(inv(1_000_000, 1_000_000))).toBe(true);
  });

  it("never goes negative on an overpayment", () => {
    // Negative outstanding would silently SUBTRACT from expected inflow
    // elsewhere in the horizon. The extra money is real and is credited to the
    // ledger at settlement; it is simply not something this invoice delivers
    // again.
    expect(outstandingAmount(inv(1_000_000, 1_250_000))).toBe(0);
  });

  it("treats a negative recorded payment as zero, not as extra outstanding", () => {
    // Corrupt data, not a refund model. Letting it through would inflate
    // outstanding ABOVE the invoice value and overstate expected inflow.
    expect(confirmedPaid(inv(1_000_000, -500_000))).toBe(0);
    expect(outstandingAmount(inv(1_000_000, -500_000))).toBe(1_000_000);
  });

  it("returns zero for a non-positive or non-finite invoice amount", () => {
    expect(outstandingAmount(inv(0, 0))).toBe(0);
    expect(outstandingAmount(inv(-100, 0))).toBe(0);
    expect(outstandingAmount(inv(Number.NaN, 0))).toBe(0);
  });

  it("ignores a non-finite recorded payment rather than propagating NaN", () => {
    // NaN outstanding poisons every downstream sum silently.
    expect(outstandingAmount(inv(1_000_000, Number.NaN))).toBe(1_000_000);
  });
});

describe("Accumulating part payments", () => {
  it("does not double-count when payments are applied in sequence", () => {
    // Three ₹2,00,000 receipts against a ₹10,00,000 invoice. paidAmount is a
    // running total, so outstanding falls once per receipt and never twice.
    let paid = 0;
    const amount = 1_000_000;
    const steps: number[] = [];

    for (const receipt of [200_000, 200_000, 200_000]) {
      paid += receipt;
      steps.push(outstandingAmount(inv(amount, paid)));
    }

    expect(steps).toEqual([800_000, 600_000, 400_000]);
  });

  it("reaches exactly zero when the parts sum to the invoice", () => {
    expect(outstandingAmount(inv(1_000_000, 600_000 + 400_000))).toBe(0);
  });
});

describe("The status a settlement produces", () => {
  it("is PARTIALLY_PAID when the balance is not closed", () => {
    expect(statusAfterPayment(inv(1_000_000, 0), 600_000)).toBe("PARTIALLY_PAID");
    expect(statusAfterPayment(inv(1_000_000, 600_000), 300_000)).toBe("PARTIALLY_PAID");
  });

  it("is PAID exactly at the full amount", () => {
    expect(statusAfterPayment(inv(1_000_000, 0), 1_000_000)).toBe("PAID");
    expect(statusAfterPayment(inv(1_000_000, 600_000), 400_000)).toBe("PAID");
  });

  it("is PAID on an overpayment — the invoice is satisfied", () => {
    expect(statusAfterPayment(inv(1_000_000, 0), 1_500_000)).toBe("PAID");
  });

  it("does not advance on a zero or negative receipt", () => {
    expect(statusAfterPayment(inv(1_000_000, 0), 0)).toBe("PARTIALLY_PAID");
    expect(statusAfterPayment(inv(1_000_000, 0), -100)).toBe("PARTIALLY_PAID");
  });

  it("is derived from the money, not from the caller's intent", () => {
    // A settlement asserting it closes the invoice does not close it if the
    // amount does not.
    expect(statusAfterPayment(inv(1_000_000, 100_000), 1)).toBe("PARTIALLY_PAID");
  });
});

describe("Totalling a portfolio", () => {
  it("sums the remainders, not the face values", () => {
    const invoices = [
      inv(1_000_000, 600_000, "PARTIALLY_PAID"),
      inv(500_000, 0, "OVERDUE"),
      inv(300_000, 300_000, "PAID"),
    ];
    // 400,000 + 500,000 + 0
    expect(totalOutstanding(invoices)).toBe(900_000);
  });

  it("does not resurrect a legacy PAID row that has no recorded paidAmount", () => {
    // paidAmount was added later and is deliberately not backfilled, so a
    // historical PAID invoice reads paidAmount 0. Trusting the arithmetic alone
    // would report the whole invoice as still expected.
    expect(totalOutstanding([inv(1_000_000, 0, "PAID")])).toBe(0);
  });

  it("is zero for an empty portfolio", () => {
    expect(totalOutstanding([])).toBe(0);
  });
});
