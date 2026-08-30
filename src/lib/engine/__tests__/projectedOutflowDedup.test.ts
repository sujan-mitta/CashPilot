import { describe, it, expect, vi } from "vitest";
import { calculateLiquiditySafetyRequirement } from "../liquiditySafety";
import { FINANCIAL_CONFIG } from "../financialConfig";
import { SCORING_CONFIG } from "../scorer";
import { addDays } from "date-fns";

/**
 * Projected outflow must be the DEDUPLICATED SUM, not the maximum.
 *
 * The safety buffer is built from two projected sources: pending outflow
 * transactions and scheduled payouts. They can overlap — the same obligation
 * sometimes appears in both — so they cannot simply be added.
 *
 * The previous implementation resolved that with `Math.max(sumTx, sumPayouts)`,
 * commented as "a conservative deduplication heuristic". It is not conservative.
 * It is only correct in the case where one set entirely contains the other. In
 * the ordinary case — a vendor payout and an unrelated pending SaaS charge —
 * the two sets are DISJOINT, the true outflow is their sum, and `max` discards
 * the smaller one entirely.
 *
 * The direction of that error is what makes it serious. Understating projected
 * outflow understates the daily run-rate, which understates the required
 * liquidity buffer, which makes the business look safer than it is. The bug it
 * replaced (double-counting) erred the other way and merely over-reserved.
 *
 * The fix reuses `extractObligations`, which already deduplicates by source id
 * and by (amount, due-date) proximity, and sums what survives.
 */

const T0 = new Date("2026-09-01T00:00:00.000Z");

/** A projected outflow transaction inside the forecast horizon. */
const tx = (id: string, amount: number, dayOffset: number) => ({
  id,
  amount,
  type: "OUTFLOW",
  status: "PENDING",
  expectedDate: addDays(T0, dayOffset),
  description: `pending ${id}`,
});

/** A scheduled payout inside the forecast horizon. */
const payout = (id: string, amount: number, dayOffset: number) => ({
  id,
  amount,
  status: "SCHEDULED",
  scheduledDate: addDays(T0, dayOffset),
  vendor: `vendor ${id}`,
  criticality: "NORMAL",
});

/**
 * No history, so the buffer comes from projected outflows alone. That isolates
 * the quantity under test: with history present the 70/30 weighting would
 * dilute the projection and hide the difference.
 */
function makeClient(payouts: unknown[], transactions: unknown[]) {
  return {
    transaction: {
      findMany: vi.fn(async ({ where }: { where: { status?: string } }) =>
        // The historical query asks for SETTLED; the projected one for PENDING.
        where?.status === "PENDING" ? transactions : []
      ),
    },
    payout: { findMany: vi.fn(async () => payouts) },
  };
}

/**
 * The buffer the engine should derive from a given total projected outflow.
 *
 * Asserts the figure clears SAFETY_BUFFER_MIN_FLOOR. Every fixture here is
 * deliberately large enough to do so: at a smaller scale the floor replaces the
 * computed value, and each assertion silently degenerates into comparing the
 * floor against itself, which passes no matter how the sum is computed.
 */
function expectedBufferFor(totalProjectedOutflow: number) {
  const projectedDaily = totalProjectedOutflow / FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS;
  const buffer = Math.round(projectedDaily * SCORING_CONFIG.SAFETY_BUFFER_COVERAGE_DAYS);
  if (buffer <= SCORING_CONFIG.SAFETY_BUFFER_MIN_FLOOR) {
    throw new Error(
      `Fixture too small: buffer ${buffer} is at or below the floor ` +
        `${SCORING_CONFIG.SAFETY_BUFFER_MIN_FLOOR}, so this test would prove nothing.`
    );
  }
  return buffer;
}

describe("Projected outflow deduplication", () => {
  it("sums disjoint payouts and transactions instead of taking the larger", async () => {
    // Different vendors, different amounts, different days: nothing here is the
    // same obligation twice.
    const payouts = [payout("p1", 30_000_000, 3)];
    const transactions = [tx("t1", 20_000_000, 7)];

    const result = await calculateLiquiditySafetyRequirement(
      "biz-A",
      makeClient(payouts, transactions) as never,
      T0
    );

    const bothCounted = expectedBufferFor(50_000_000);
    const onlyTheLarger = expectedBufferFor(30_000_000);

    // The assertion that fails on `Math.max`: it would return `onlyTheLarger`,
    // silently dropping a real ₹2,00,000 obligation from the safety buffer.
    expect(result.requiredBuffer).toBe(bothCounted);
    expect(result.requiredBuffer).toBeGreaterThan(onlyTheLarger);
  });

  it("counts a genuinely duplicated obligation once", async () => {
    // Same amount, same instant: the payout and the transaction are two views
    // of one obligation, and adding them would over-reserve.
    const payouts = [payout("p1", 30_000_000, 3)];
    const transactions = [tx("t1", 30_000_000, 3)];

    const result = await calculateLiquiditySafetyRequirement(
      "biz-A",
      makeClient(payouts, transactions) as never,
      T0
    );

    expect(result.requiredBuffer).toBe(expectedBufferFor(30_000_000));
  });

  it("counts a shared source id once even when the amounts differ", async () => {
    // The same underlying record surfaced through both tables.
    const payouts = [payout("shared-1", 30_000_000, 3)];
    const transactions = [tx("shared-1", 25_000_000, 5)];

    const result = await calculateLiquiditySafetyRequirement(
      "biz-A",
      makeClient(payouts, transactions) as never,
      T0
    );

    expect(result.requiredBuffer).toBe(expectedBufferFor(30_000_000));
  });

  it("scales with the number of distinct obligations", async () => {
    // Three unrelated obligations must produce a strictly larger buffer than
    // one of them. Under `max` all four of these collapse to the single
    // largest, and the buffer does not move at all.
    const one = await calculateLiquiditySafetyRequirement(
      "biz-A",
      makeClient([payout("p1", 24_000_000, 2)], []) as never,
      T0
    );
    const three = await calculateLiquiditySafetyRequirement(
      "biz-A",
      makeClient(
        [payout("p1", 24_000_000, 2), payout("p2", 16_000_000, 6)],
        [tx("t1", 12_000_000, 9)]
      ) as never,
      T0
    );

    expect(three.requiredBuffer).toBeGreaterThan(one.requiredBuffer);
    expect(three.requiredBuffer).toBe(expectedBufferFor(52_000_000));
  });

  it("still reports a buffer when only one source has records", async () => {
    const onlyPayouts = await calculateLiquiditySafetyRequirement(
      "biz-A",
      makeClient([payout("p1", 28_000_000, 4)], []) as never,
      T0
    );
    const onlyTransactions = await calculateLiquiditySafetyRequirement(
      "biz-A",
      makeClient([], [tx("t1", 28_000_000, 4)]) as never,
      T0
    );

    expect(onlyPayouts.requiredBuffer).toBe(expectedBufferFor(28_000_000));
    expect(onlyTransactions.requiredBuffer).toBe(expectedBufferFor(28_000_000));
  });
});
