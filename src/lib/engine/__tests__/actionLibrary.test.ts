import { describe, it, expect } from "vitest";
import { buildActionLibrary } from "../actionLibrary";

/**
 * One selection, used by the app and by the settlement email.
 *
 * The email built its own library beside the planner's and had none of the
 * planner's rules. Each case below is a candidate the planner rejects and the
 * email's copy accepted, so an operator could be emailed a recommendation the
 * app would refuse to make — including collecting money that had just landed,
 * which is the event that sends the email in the first place.
 */

const tx = (o: Partial<Parameters<typeof buildActionLibrary>[0]["transactions"][number]>) => ({
  id: "t1", type: "INFLOW", status: "FAILED", amount: 100, description: null, ...o,
});

const base = { transactions: [], invoices: [], payouts: [] };

describe("Recovery candidates", () => {
  it("skips a debt already recovered or in flight", () => {
    const { library } = buildActionLibrary({
      ...base,
      transactions: [tx({ id: "settled", amount: 24000000 })],
      handledTransactionIds: new Set(["settled"]),
    });
    expect(library.recoverFailedPayments).toBe(0);
    expect(library.recoverFailedPaymentsId).toBe("");
  });

  it("takes the largest outstanding debt and reports the rest", () => {
    const { library, unaddressedFailures } = buildActionLibrary({
      ...base,
      transactions: [tx({ id: "small", amount: 100 }), tx({ id: "big", amount: 900 })],
    });
    expect(library.recoverFailedPaymentsId).toBe("big");
    // The executor recovers ONE debt per action; the others are real money.
    expect(unaddressedFailures.map((f) => f.id)).toEqual(["small"]);
  });

  it("never offers an outflow as a recovery", () => {
    const { library } = buildActionLibrary({
      ...base,
      transactions: [tx({ type: "OUTFLOW", amount: 500 })],
    });
    expect(library.recoverFailedPayments).toBe(0);
  });
});

describe("Collection value", () => {
  it("counts what is still owed, not the face value", () => {
    const { library } = buildActionLibrary({
      ...base,
      invoices: [{ status: "PARTIALLY_PAID", amount: 100000000, paidAmount: 60000000 }],
    });
    expect(library.prioritizeCollections).toBe(40000000);
  });

  it("ignores invoices that are already paid", () => {
    const { library } = buildActionLibrary({
      ...base,
      invoices: [{ status: "PAID", amount: 500, paidAmount: 500 }],
    });
    expect(library.prioritizeCollections).toBe(0);
  });
});

describe("Payout to reschedule", () => {
  it("refuses one already rescheduled", () => {
    // Moving it again double counts: the benefit was banked the first time.
    const { library } = buildActionLibrary({
      ...base,
      payouts: [{ id: "p1", vendor: "Packaging Co", amount: 55000000, status: "RESCHEDULED" }],
    });
    expect(library.reschedulePayout).toBe(0);
    expect(library.reschedulePayoutId).toBe("");
  });

  it("does not fall back to an arbitrary payout", () => {
    // The email used `find(...) || payouts[0]`, which would move a vendor
    // nobody chose, in whatever status it happened to be in.
    const { library } = buildActionLibrary({
      ...base,
      payouts: [{ id: "p9", vendor: "Components Supplier Ltd", amount: 70000000, status: "SCHEDULED" }],
    });
    expect(library.reschedulePayout).toBe(0);
  });

  it("links the transaction the forecast reads", () => {
    // Moving the payout without moving its transaction changes nothing the
    // projection can see.
    const { library } = buildActionLibrary({
      ...base,
      payouts: [{ id: "p1", vendor: "Packaging Co", amount: 55000000, status: "SCHEDULED" }],
      transactions: [tx({ id: "ptx", type: "OUTFLOW", status: "PENDING", amount: 55000000, description: "Vendor payout - Packaging Co" })],
    });
    expect(library.reschedulePayoutId).toBe("p1");
    expect(library.rescheduleTransactionId).toBe("ptx");
  });
});

describe("Expense to pause", () => {
  it("refuses one that already failed", () => {
    // A FAILED outflow never left the account, so there is no saving to make.
    const { library } = buildActionLibrary({
      ...base,
      transactions: [tx({ type: "OUTFLOW", status: "FAILED", amount: 15000000, description: "Operational SaaS + recurring services" })],
    });
    expect(library.pauseExpense).toBe(0);
  });

  it("accepts a pending recurring outflow", () => {
    const { library } = buildActionLibrary({
      ...base,
      transactions: [tx({ id: "saas", type: "OUTFLOW", status: "PENDING", amount: 15000000, description: "Operational SaaS + recurring services" })],
    });
    expect(library.pauseExpense).toBe(15000000);
    expect(library.pauseExpenseId).toBe("saas");
  });

  it("never offers an inflow described as recurring", () => {
    const { library } = buildActionLibrary({
      ...base,
      transactions: [tx({ type: "INFLOW", status: "PENDING", amount: 9999, description: "recurring customer payment" })],
    });
    expect(library.pauseExpense).toBe(0);
  });
});
