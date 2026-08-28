import { describe, it, expect } from "vitest";
import { addDays } from "date-fns";
import { generateStrategies, applyActionsToMovements } from "../strategyEngine";
import { buildForecast } from "../forecast";
import { FINANCIAL_CONFIG } from "../financialConfig";
import { validateActionTransition } from "../stateTransitions";
import { ActionStatus } from "../../../../generated/prisma/client";

/**
 * ONE NUMBER FOR ONE FACT
 *
 * The reschedule delay existed three times, with two different values:
 *
 *   - the executor moved the payout to FORECAST_HORIZON_DAYS + 6  (day 20)
 *   - the simulation defaulted to                                  day 15
 *   - the approval screen told the operator, in prose,             "day 15"
 *
 * So the human approval gate - the last place a figure may be wrong - displayed
 * a date the system would not honour. There is now one constant.
 */
describe("RESCHEDULE_DELAY_DAYS is the single source of truth", () => {
  const today = new Date("2026-08-27T00:00:00.000Z");

  const library = {
    recoverFailedPayments: 0,
    prioritizeCollections: 0,
    reschedulePayout: 500_000,
    pauseExpense: 0,
    rescheduleTransactionId: "payout-1",
  };
  const movements = [
    {
      transactionId: "payout-1",
      date: addDays(today, 3),
      inflows: 0,
      outflows: 500_000,
      description: "Vendor payout",
    },
  ];

  it("the simulation moves the payout to exactly RESCHEDULE_DELAY_DAYS", () => {
    const [full] = generateStrategies(10_000_000, movements, library, today).filter(
      (s) => s.name === "FULL_INTERVENTION"
    );
    const simulated = applyActionsToMovements(movements, full.actions, today);
    const moved = simulated.find((m) => m.description?.startsWith("Rescheduled payout"));

    expect(moved).toBeDefined();
    const shiftDays = Math.round(
      (moved!.date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
    );
    expect(shiftDays).toBe(FINANCIAL_CONFIG.RESCHEDULE_DELAY_DAYS);
  });

  it("the delay is BEYOND the forecast horizon — that is the point of the action", () => {
    expect(FINANCIAL_CONFIG.RESCHEDULE_DELAY_DAYS).toBeGreaterThan(
      FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS
    );
  });

  it("because it lands beyond the horizon, it is recorded as a DEFERRED obligation", () => {
    // Moving an obligation out of the window you measure is only honest if the
    // system says it did so. This is what stretches the outcome horizon.
    const [full] = generateStrategies(10_000_000, movements, library, today).filter(
      (s) => s.name === "FULL_INTERVENTION"
    );
    expect(full.deferredObligations).toHaveLength(1);
    expect(full.deferredObligations![0]).toMatchObject({
      sourceId: "payout-1",
      amount: 500_000,
      daysBeyondHorizon:
        FINANCIAL_CONFIG.RESCHEDULE_DELAY_DAYS - FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS,
    });
  });

  it("the money leaves the forecast window entirely, and reappears nowhere inside it", () => {
    const [full] = generateStrategies(10_000_000, movements, library, today).filter(
      (s) => s.name === "FULL_INTERVENTION"
    );
    const inWindow = full.forecast.reduce((sum, d) => sum + d.expectedOutflows, 0);
    expect(inWindow).toBe(0);
  });

  it("it is moved exactly once — never duplicated across two days", () => {
    const [full] = generateStrategies(10_000_000, movements, library, today).filter(
      (s) => s.name === "FULL_INTERVENTION"
    );
    const simulated = applyActionsToMovements(movements, full.actions, today);
    const wide = buildForecast(
      10_000_000,
      simulated,
      FINANCIAL_CONFIG.RESCHEDULE_DELAY_DAYS + 5,
      today
    );
    expect(wide.reduce((sum, d) => sum + d.expectedOutflows, 0)).toBe(500_000);
  });

  it("an explicit per-action delay still overrides the default", () => {
    const [full] = generateStrategies(
      10_000_000,
      movements,
      { ...library, rescheduleDelayDays: 30 },
      today
    ).filter((s) => s.name === "FULL_INTERVENTION");
    const simulated = applyActionsToMovements(movements, full.actions, today);
    const moved = simulated.find((m) => m.description?.startsWith("Rescheduled payout"))!;
    expect(Math.round((moved.date.getTime() - today.getTime()) / 86_400_000)).toBe(30);
  });
});

/**
 * CANCELLING AN APPROVAL
 *
 * There was no edge out of APPROVED except by executing. An operator who
 * approved by mistake had no remedy: the plan could not be withdrawn, and it
 * sat authorised indefinitely.
 */
describe("an approved-but-unexecuted plan can be withdrawn", () => {
  it("APPROVED -> REJECTED is allowed", () => {
    expect(validateActionTransition(ActionStatus.APPROVED, ActionStatus.REJECTED)).toBe(true);
  });

  it("but nothing IN FLIGHT can be cancelled this way", () => {
    // Once dispatch begins the status leaves APPROVED, and a "cancellation"
    // would then be a lie about an external effect that may already exist.
    for (const inFlight of [
      ActionStatus.EXECUTING,
      ActionStatus.EXECUTION_REQUESTED,
      ActionStatus.EXECUTION_UNKNOWN,
      ActionStatus.RECONCILING,
      ActionStatus.COMPLETED,
    ]) {
      expect(validateActionTransition(inFlight, ActionStatus.REJECTED)).toBe(false);
    }
  });

  it("REJECTED remains terminal — a withdrawal cannot be un-withdrawn into execution", () => {
    expect(validateActionTransition(ActionStatus.REJECTED, ActionStatus.APPROVED)).toBe(false);
    expect(validateActionTransition(ActionStatus.REJECTED, ActionStatus.EXECUTING)).toBe(false);
  });

  it("EXECUTION_UNKNOWN still cannot walk back to EXECUTING", () => {
    // The invariant this whole state machine exists for: an ambiguous external
    // operation is never blindly re-dispatched.
    expect(validateActionTransition(ActionStatus.EXECUTION_UNKNOWN, ActionStatus.EXECUTING)).toBe(false);
  });
});
