import { describe, it, expect } from "vitest";
import { transactionsToMovements, buildForecast, calculateRunway } from "../forecast";

describe("Forecast Engine", () => {
  it("converts transactions to daily movements correctly", () => {
    const transactions = [
      {
        amount: 1000000,
        type: "INFLOW" as const,
        status: "PENDING",
        expectedDate: new Date("2026-08-22T00:00:00Z"),
        description: "Inflow Tx",
      },
      {
        amount: 500000,
        type: "OUTFLOW" as const,
        status: "FAILED",
        expectedDate: new Date("2026-08-22T00:00:00Z"),
        description: "Failed Outflow Tx",
      },
      {
        amount: 200000,
        type: "OUTFLOW" as const,
        status: "SUCCESS",
        expectedDate: new Date("2026-08-23T00:00:00Z"),
        description: "Success Outflow Tx",
      },
    ];

    const movements = transactionsToMovements(transactions);

    // Failed transactions must be filtered out
    expect(movements.length).toBe(2);
    expect(movements[0].inflows).toBe(1000000);
    expect(movements[0].outflows).toBe(0);
    expect(movements[1].inflows).toBe(0);
    expect(movements[1].outflows).toBe(200000);
  });

  it("builds correct daily opening and closing balances", () => {
    const initialCash = 10000000; // ₹10L
    const movements = [
      {
        date: new Date("2026-08-23T00:00:00Z"), // Day 1
        inflows: 5000000, // ₹5L
        outflows: 2000000, // ₹2L
      },
      {
        date: new Date("2026-08-24T00:00:00Z"), // Day 2
        inflows: 0,
        outflows: 15000000, // ₹15L
      },
    ];

    const forecast = buildForecast(initialCash, movements, 2, new Date("2026-08-22T00:00:00Z"));

    expect(forecast.length).toBe(2);

    // Day 1
    expect(forecast[0].openingBalance).toBe(10000000);
    expect(forecast[0].expectedInflows).toBe(5000000);
    expect(forecast[0].expectedOutflows).toBe(2000000);
    expect(forecast[0].closingBalance).toBe(13000000); // 10 + 5 - 2 = 13L

    // Day 2
    expect(forecast[1].openingBalance).toBe(13000000);
    expect(forecast[1].expectedInflows).toBe(0);
    expect(forecast[1].expectedOutflows).toBe(15000000);
    expect(forecast[1].closingBalance).toBe(-2000000); // 13 - 15 = -2L
  });

  it("calculates runway and crisis metrics correctly", () => {
    const forecast = [
      {
        date: new Date("2026-08-23T00:00:00Z"),
        openingBalance: 10000000,
        expectedInflows: 0,
        expectedOutflows: 8000000,
        closingBalance: 2000000, // safety buffer breached (< 2.5L)
      },
      {
        date: new Date("2026-08-24T00:00:00Z"),
        openingBalance: 2000000,
        expectedInflows: 0,
        expectedOutflows: 3000000,
        closingBalance: -1000000, // crisis breached (< 0)
      },
    ];

    const runway = calculateRunway(forecast);

    expect(runway.firstDayBelowSafety).toBe(1); // safety breached on Day 1
    expect(runway.crisisDay).toBe(2); // deficit on Day 2
    expect(runway.minimumBalance).toBe(-1000000);
    expect(runway.minimumBalanceDay).toBe(2);
  });
});
