import { describe, it, expect } from "vitest";
import {
  isReschedulablePayout,
  isPausableExpense,
  HANDLED_RECOVERY_STATUSES,
  RESCHEDULABLE_PAYOUT_STATUSES,
  PAUSABLE_TRANSACTION_STATUSES,
} from "../actionEligibility";

/**
 * What each action can actually be performed on.
 *
 * The planner chose targets with in-memory filters and the executor re-derived
 * them with database queries, and the two drifted. Three bugs of the same shape
 * were found in live data, every one producing a plan presented as approved
 * whose action could never run — with the operator told only after pressing the
 * button.
 *
 * These are the rules both sides now read from.
 */

describe("A payout can only be moved while it is still going to happen", () => {
  it("accepts a scheduled payout", () => {
    expect(isReschedulablePayout({ vendor: "Packaging Co", status: "SCHEDULED" })).toBe(true);
  });

  it("refuses one already rescheduled", () => {
    // Found live on ABC Electronics. Beyond failing at execution, proposing
    // this double-counts: the benefit of moving that money was banked when it
    // was moved the first time, so the simulation claims a gain twice.
    expect(isReschedulablePayout({ vendor: "Packaging Co", status: "RESCHEDULED" })).toBe(false);
  });

  it("refuses one already paid or cancelled", () => {
    for (const status of ["COMPLETED", "PAID", "CANCELLED"]) {
      expect(isReschedulablePayout({ vendor: "Packaging Co", status })).toBe(false);
    }
  });
});

describe("An expense can only be paused while it is still going to be paid", () => {
  const saas = { type: "OUTFLOW", status: "PENDING", description: "Operational SaaS + recurring" };

  it("accepts a pending outflow", () => {
    expect(isPausableExpense(saas)).toBe(true);
  });

  it("refuses a FAILED outflow", () => {
    // Found live on ABC Electronics. A failed outflow never left the account,
    // so there is no saving available to make.
    expect(isPausableExpense({ ...saas, status: "FAILED" })).toBe(false);
  });

  it("refuses one already completed", () => {
    // The money has gone. Pausing it saves nothing.
    expect(isPausableExpense({ ...saas, status: "COMPLETED" })).toBe(false);
  });

  it("refuses an INFLOW however it is described", () => {
    // Matching on description alone would have offered money coming IN as an
    // expense to stop.
    expect(isPausableExpense({ type: "INFLOW", status: "PENDING", description: "recurring payment" })).toBe(false);
  });

  it("refuses an outflow that is not a subscription", () => {
    expect(isPausableExpense({ type: "OUTFLOW", status: "PENDING", description: "Payroll run" })).toBe(false);
  });

  it("matches either wording, case-insensitively", () => {
    for (const description of ["SAAS licence", "monthly Recurring fee", "saas"]) {
      expect(isPausableExpense({ type: "OUTFLOW", status: "PENDING", description })).toBe(true);
    }
  });

  it("handles a missing description without throwing", () => {
    expect(isPausableExpense({ type: "OUTFLOW", status: "PENDING", description: null })).toBe(false);
  });
});

describe("Recovery states that mean 'leave it alone'", () => {
  it("covers settled and in-flight debts", () => {
    expect([...HANDLED_RECOVERY_STATUSES]).toEqual([
      "RECOVERED",
      "PAYMENT_PENDING",
      "RECOVERY_INITIATED",
    ]);
  });

  it("deliberately excludes a FAILED recovery", () => {
    // A failed attempt is exactly the case worth retrying. Excluding it would
    // be as wrong as offering a settled one.
    expect([...HANDLED_RECOVERY_STATUSES]).not.toContain("RECOVERY_FAILED");
  });
});

describe("One definition, so the two sides cannot drift", () => {
  it("keeps the status lists the executor queries by", () => {
    // The executor builds its database `where` clauses from these exact
    // constants. If someone widens the predicate here without meaning to, the
    // executor widens with it rather than silently disagreeing — which is the
    // failure this module exists to prevent.
    expect([...RESCHEDULABLE_PAYOUT_STATUSES]).toEqual(["SCHEDULED"]);
    expect([...PAUSABLE_TRANSACTION_STATUSES]).toEqual(["PENDING"]);
  });
});
