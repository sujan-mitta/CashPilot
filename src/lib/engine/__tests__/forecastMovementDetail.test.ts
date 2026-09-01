import { describe, it, expect } from "vitest";
import { buildForecast } from "../forecast";
import type { DailyMovement } from "../forecast";

/**
 * What a day is made of, not just how much it comes to.
 *
 * The table said "Bills to pay, -Rs 8,00,000" on the worst day of a forecast.
 * That figure was a payroll run AND a supplier payout landing together, and
 * only one of those can be moved — so summing them away turned an actionable
 * fact into something to be taken on trust.
 *
 * The movements were already computed inside buildForecast and discarded.
 */

const T0 = new Date("2026-09-01T09:00:00.000Z");
const at = (day: string) => new Date(`${day}T00:00:00.000Z`);

const out = (day: string, amount: number, description?: string): DailyMovement => ({
  date: at(day),
  inflows: 0,
  outflows: amount,
  description,
});

const inn = (day: string, amount: number, description?: string): DailyMovement => ({
  date: at(day),
  inflows: amount,
  outflows: 0,
  description,
});

describe("A day reports its parts", () => {
  it("lists each movement separately", () => {
    const days = buildForecast(
      1_000_000,
      [out("2026-09-05", 600_000, "Payroll run"), out("2026-09-05", 200_000, "Supplier payout")],
      14,
      T0
    );
    const day = days.find((d) => d.expectedOutflows > 0)!;

    expect(day.movements).toHaveLength(2);
    expect(day.movements!.map((m) => m.description)).toEqual(["Payroll run", "Supplier payout"]);
  });

  it("keeps the parts adding up to the total", () => {
    // If a movement were dropped, the detail would quietly contradict the
    // figure above it — worse than showing no detail at all.
    const days = buildForecast(
      1_000_000,
      [out("2026-09-05", 600_000, "Payroll"), out("2026-09-05", 200_000, "Supplier")],
      14,
      T0
    );
    const day = days.find((d) => d.expectedOutflows > 0)!;
    const summed = day.movements!.reduce((s, m) => s + m.outflow, 0);

    expect(summed).toBe(day.expectedOutflows);
    expect(summed).toBe(800_000);
  });

  it("separates money in from money out on a mixed day", () => {
    const days = buildForecast(
      1_000_000,
      [inn("2026-09-03", 300_000, "Order #4821"), out("2026-09-03", 100_000, "Rent")],
      14,
      T0
    );
    const day = days.find((d) => d.expectedInflows > 0)!;

    expect(day.movements).toHaveLength(2);
    expect(day.movements!.find((m) => m.inflow > 0)?.description).toBe("Order #4821");
    expect(day.movements!.find((m) => m.outflow > 0)?.description).toBe("Rent");
    const inSum = day.movements!.reduce((s, m) => s + m.inflow, 0);
    const outSum = day.movements!.reduce((s, m) => s + m.outflow, 0);
    expect(inSum).toBe(day.expectedInflows);
    expect(outSum).toBe(day.expectedOutflows);
  });
});

describe("Movements without a description of their own", () => {
  it("still appear, with a direction-appropriate label", () => {
    // Hiding one would make the parts fail to add up to the total, which is a
    // worse failure than an unhelpful label.
    const days = buildForecast(1_000_000, [out("2026-09-04", 500_000)], 14, T0);
    const day = days.find((d) => d.expectedOutflows > 0)!;

    expect(day.movements).toHaveLength(1);
    expect(day.movements![0].description).toBe("Money out");
    expect(day.movements![0].outflow).toBe(500_000);
  });

  it("labels an undescribed inflow as money in", () => {
    const days = buildForecast(1_000_000, [inn("2026-09-04", 500_000)], 14, T0);
    const day = days.find((d) => d.expectedInflows > 0)!;
    expect(day.movements![0].description).toBe("Money in");
  });

  it("does not treat whitespace as a description", () => {
    const days = buildForecast(1_000_000, [out("2026-09-04", 500_000, "   ")], 14, T0);
    const day = days.find((d) => d.expectedOutflows > 0)!;
    expect(day.movements![0].description).toBe("Money out");
  });
});

describe("Quiet days", () => {
  it("carry an empty list rather than nothing", () => {
    // The table skips them, but a caller reading `movements` should not have to
    // distinguish "no movements" from "detail unavailable".
    const days = buildForecast(1_000_000, [], 3, T0);
    for (const d of days) {
      expect(d.movements).toEqual([]);
    }
  });
});

describe("The totals are unchanged by any of this", () => {
  it("leaves the balances exactly as before", () => {
    // This is additive. A forecast consumer that ignores `movements` must see
    // precisely the numbers it saw previously.
    const movements = [inn("2026-09-03", 300_000, "In"), out("2026-09-05", 800_000, "Out")];
    const days = buildForecast(1_000_000, movements, 14, T0);

    expect(days[0].openingBalance).toBe(1_000_000);
    const low = Math.min(...days.map((d) => d.closingBalance));
    expect(low).toBe(1_000_000 + 300_000 - 800_000);
  });
});
