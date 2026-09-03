import { describe, it, expect } from "vitest";
import { describePlanRunState } from "../planRunState";

/**
 * Whether the plan on screen can still be run.
 *
 * The execution page offered "Begin Approved Execution" for a decision that had
 * already executed. The state machine refused — correctly — and the operator
 * learned the plan had already run only AFTER pressing a button that promised
 * the opposite, beside a heading reading "Awaiting Execution" for something
 * that was not awaiting anything.
 *
 * Observed live: a settled recovery, a plan in EXECUTED, and a screen still
 * inviting execution.
 */

describe("A plan that has already run", () => {
  it("cannot be run again", () => {
    for (const status of ["EXECUTED", "RECONCILED", "OUTCOME_MEASURED"]) {
      const r = describePlanRunState(status);
      expect(r.canRun).toBe(false);
      expect(r.runnability).toBe("ALREADY_RUN");
    }
  });

  it("says why, in terms of consequence", () => {
    // "Cannot run" invites an argument. "It would ask the same customers to pay
    // twice" does not.
    expect(describePlanRunState("EXECUTED").detail).toMatch(/pay twice/i);
  });

  it("points at the thing that WOULD help", () => {
    // The operator still has a shortfall. Telling them no without telling them
    // what to do instead leaves them pressing the same button.
    expect(describePlanRunState("EXECUTED").detail).toMatch(/build a new plan/i);
  });

  it("distinguishes a mismatched settlement from a clean one", () => {
    const r = describePlanRunState("RECONCILIATION_MISMATCH");
    expect(r.canRun).toBe(false);
    expect(r.detail).toMatch(/disagree/i);
  });
});

describe("A plan that can still run", () => {
  it("is runnable while approved, presented or generated", () => {
    for (const status of ["GENERATED", "PRESENTED", "APPROVED"]) {
      expect(describePlanRunState(status).canRun).toBe(true);
    }
  });
});

describe("A plan that will not run", () => {
  it("separates refusal from having already run", () => {
    // Different remedies: one produced links, the other never did.
    for (const status of ["REJECTED", "NOT_EXECUTED"]) {
      const r = describePlanRunState(status);
      expect(r.canRun).toBe(false);
      expect(r.runnability).toBe("REFUSED");
    }
  });

  it("treats an unsettled plan as in flight, not finished", () => {
    const r = describePlanRunState("NOT_RECONCILED");
    expect(r.canRun).toBe(false);
    expect(r.runnability).toBe("IN_FLIGHT");
    // The reason matters: duplicates for money that may already be arriving.
    expect(r.detail).toMatch(/duplicate/i);
  });
});

describe("An unknown status", () => {
  it("stays runnable rather than blocking on a guess", () => {
    // The state machine is the real authority and refuses if it must. Guessing
    // "blocked" here would strand a perfectly good plan behind a screen with no
    // button and no way forward.
    for (const status of [null, undefined, "", "SOMETHING_NEW"]) {
      const r = describePlanRunState(status);
      expect(r.canRun).toBe(true);
      expect(r.runnability).toBe("UNKNOWN");
    }
  });
});

describe("Every state says something worth reading", () => {
  it("carries a heading and a sentence", () => {
    const all = [
      "GENERATED", "PRESENTED", "APPROVED", "REJECTED", "EXECUTED",
      "NOT_EXECUTED", "RECONCILED", "NOT_RECONCILED",
      "RECONCILIATION_MISMATCH", "OUTCOME_MEASURED", null,
    ];
    for (const status of all) {
      const r = describePlanRunState(status);
      expect(r.heading.length).toBeGreaterThan(10);
      expect(r.detail.length).toBeGreaterThan(40);
    }
  });

  it("never claims a plan is awaiting execution when it is not runnable", () => {
    // The exact contradiction that was on screen.
    const all = ["EXECUTED", "RECONCILED", "REJECTED", "NOT_EXECUTED", "NOT_RECONCILED"];
    for (const status of all) {
      expect(describePlanRunState(status).heading).not.toMatch(/awaiting execution/i);
    }
  });
});
