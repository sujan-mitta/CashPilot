import { describe, it, expect } from "vitest";
import { reconcileOverdueMovements } from "../overdueMovements";
import { buildForecast } from "../forecast";
import type { DailyMovement } from "../forecast";

/**
 * Committed movements whose date has already passed.
 *
 * `buildForecast` walks days 1..N from today and matches by exact date, so
 * anything dated earlier matched no day and was silently dropped. Observed on
 * real data: ₹18,80,000 of committed movements vanished from the projection,
 * including an overdue payroll and an overdue vendor payout.
 *
 * The treatment is asymmetric because the risk is. Carrying an overdue OUTFLOW
 * forward is conservative — the money is still owed. Carrying an overdue INFLOW
 * forward would assume late money arrives, on exactly the invoices least likely
 * to pay.
 */

const T0 = new Date("2026-09-10T09:00:00.000Z");
const at = (isoDay: string): Date => new Date(`${isoDay}T00:00:00.000Z`);

const outflow = (day: string, amount: number, description?: string): DailyMovement => ({
  date: at(day),
  inflows: 0,
  outflows: amount,
  description,
});

const inflow = (day: string, amount: number, description?: string): DailyMovement => ({
  date: at(day),
  inflows: amount,
  outflows: 0,
  description,
});

describe("Overdue outflows are still owed", () => {
  it("carries an overdue outflow into the projection", () => {
    const r = reconcileOverdueMovements([outflow("2026-09-05", 600_000, "Payroll")], T0);

    // Dropping it understates committed spending and makes the business look
    // better off than it is.
    expect(r.movements).toHaveLength(1);
    expect(r.movements[0].outflows).toBe(600_000);
    expect(r.carriedOutflows).toBe(600_000);
  });

  it("lands it on day 1, the earliest the forecast models", () => {
    const r = reconcileOverdueMovements([outflow("2026-09-01", 600_000)], T0);
    expect(r.movements[0].date.toISOString().slice(0, 10)).toBe("2026-09-11");
  });

  it("says why the date moved", () => {
    const r = reconcileOverdueMovements([outflow("2026-09-05", 600_000, "Payroll")], T0);

    // A silently relocated date is indistinguishable from a wrong one.
    expect(r.movements[0].description).toMatch(/overdue/i);
    expect(r.movements[0].description).toMatch(/Payroll/);
  });

  it("preserves the amount exactly", () => {
    const r = reconcileOverdueMovements([outflow("2026-08-20", 1_234_567)], T0);
    expect(r.movements[0].outflows).toBe(1_234_567);
  });
});

describe("Overdue inflows are not banked", () => {
  it("does not carry an overdue receivable forward", () => {
    const r = reconcileOverdueMovements([inflow("2026-09-05", 900_000, "Order #4821")], T0);

    // Assuming late money arrives overstates cash on exactly the invoices least
    // likely to pay.
    expect(r.movements).toHaveLength(0);
  });

  it("reports it rather than discarding it silently", () => {
    const r = reconcileOverdueMovements([inflow("2026-09-05", 900_000)], T0);

    // The difference between this and the old behaviour: the money is still not
    // counted, but it is no longer invisible.
    expect(r.uncountedInflows).toBe(900_000);
    expect(r.overdueCount).toBe(1);
  });
});

describe("Future movements are untouched", () => {
  it("passes them through unchanged", () => {
    const future = outflow("2026-09-20", 500_000, "Rent");
    const r = reconcileOverdueMovements([future], T0);

    expect(r.movements).toEqual([future]);
    expect(r.overdueCount).toBe(0);
    expect(r.carriedOutflows).toBe(0);
  });

  it("treats today as not overdue", () => {
    // Something due today has not yet failed to happen.
    const today = outflow("2026-09-10", 400_000);
    const r = reconcileOverdueMovements([today], T0);

    expect(r.overdueCount).toBe(1);
    expect(r.carriedOutflows).toBe(400_000);
  });
});

describe("The effect on a real projection", () => {
  it("an overdue payroll changes the runway instead of disappearing", () => {
    const cash = 1_000_000;
    const movements = [outflow("2026-09-05", 900_000, "Payroll")];

    const before = buildForecast(cash, movements, 14, T0);
    const after = buildForecast(cash, reconcileOverdueMovements(movements, T0).movements, 14, T0);

    const lowBefore = Math.min(...before.map((d) => d.closingBalance));
    const lowAfter = Math.min(...after.map((d) => d.closingBalance));

    // THE BUG: the old projection never saw the ₹9,00,000 at all.
    expect(lowBefore).toBe(cash);
    expect(lowAfter).toBe(cash - 900_000);
    expect(lowAfter).toBeLessThan(lowBefore);
  });

  it("an overdue receivable does not inflate the runway", () => {
    const cash = 1_000_000;
    const movements = [inflow("2026-09-05", 900_000)];

    const after = buildForecast(cash, reconcileOverdueMovements(movements, T0).movements, 14, T0);

    // Both before and after leave cash flat — the point is that "after" did not
    // become MORE optimistic by banking a late payment.
    expect(Math.max(...after.map((d) => d.closingBalance))).toBe(cash);
  });

  it("nets a mixed overdue batch conservatively", () => {
    const cash = 2_000_000;
    const movements = [
      inflow("2026-09-05", 800_000, "Late receivable"),
      outflow("2026-09-06", 500_000, "Late payable"),
    ];

    const after = buildForecast(cash, reconcileOverdueMovements(movements, T0).movements, 14, T0);
    const low = Math.min(...after.map((d) => d.closingBalance));

    // The payable lands, the receivable does not. Both errors would otherwise
    // point the same way: too optimistic.
    expect(low).toBe(cash - 500_000);
  });
});
