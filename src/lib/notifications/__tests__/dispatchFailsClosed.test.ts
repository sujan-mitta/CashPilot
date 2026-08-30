import { describe, it, expect, beforeEach, vi } from "vitest";
import { claimAlertForDispatch, findLatestAlertForCrisis, __resetStoreForTesting } from "../alertStore";
import { prisma } from "@/lib/prisma";

/**
 * When the database cannot answer, the dispatch path must fail CLOSED.
 *
 * Two gates stand between "a crisis exists" and "an email is sent":
 *
 *   1. findLatestAlertForCrisis — have we already emailed about this exact crisis?
 *   2. claimAlertForDispatch — did this worker win the race to send it?
 *
 * Both were written to catch a database error and fall back to an in-memory
 * store. That store is per-process, and on serverless every concurrent
 * invocation is a different process with an empty one. So a transient database
 * fault turned both gates into unconditional "yes":
 *
 *   - the dedup lookup searched an empty store, found nothing, and reported
 *     that no alert had ever been sent for this crisis;
 *   - the claim wrote to an empty store and reported an exclusive claim.
 *
 * N concurrent workers would therefore each conclude they were the only sender
 * and emit N duplicate emails — precisely when the database is unhealthy and
 * retries are most likely.
 *
 * The safe direction is unambiguous. A suppressed alert is recovered on the
 * next scheduled evaluation; a duplicate email cannot be recalled. Neither gate
 * may convert "I cannot tell" into "go ahead".
 */

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notificationAlertRecord: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

const DB_DOWN = new Error("terminating connection due to administrator command");

beforeEach(() => {
  __resetStoreForTesting();
  vi.clearAllMocks();
});

describe("Dispatch gates under database failure", () => {
  it("refuses the claim when the claim query throws", async () => {
    vi.mocked(prisma.notificationAlertRecord.updateMany).mockRejectedValue(DB_DOWN);

    // Not "true because we could not check". No claim means no send.
    await expect(claimAlertForDispatch("alert_1")).resolves.toBe(false);
  });

  it("refuses the claim for every concurrent worker, not just the first", async () => {
    vi.mocked(prisma.notificationAlertRecord.updateMany).mockRejectedValue(DB_DOWN);

    // The in-memory fallback granted the first caller in each process. With
    // three processes that is three emails; the count that matters is zero.
    const results = await Promise.all([
      claimAlertForDispatch("alert_1"),
      claimAlertForDispatch("alert_1"),
      claimAlertForDispatch("alert_1"),
    ]);

    expect(results).toEqual([false, false, false]);
    expect(results.filter(Boolean)).toHaveLength(0);
  });

  it("still grants exactly one claim when the database is healthy", async () => {
    // The guard must not break the mechanism it protects: a real compare-and-set
    // still yields one winner.
    let claimed = false;
    vi.mocked(prisma.notificationAlertRecord.updateMany).mockImplementation((async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    }) as never);

    const results = await Promise.all([
      claimAlertForDispatch("alert_2"),
      claimAlertForDispatch("alert_2"),
      claimAlertForDispatch("alert_2"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does not report a crisis as unsent when the dedup lookup throws", async () => {
    vi.mocked(prisma.notificationAlertRecord.findFirst).mockRejectedValue(DB_DOWN);

    // Returning null here means "never emailed about this", which sends again.
    // The honest answer under failure is to refuse rather than to guess.
    await expect(findLatestAlertForCrisis("biz_1", "crisis_deficit_2026-09-10")).rejects.toThrow();
  });

  it("reports a genuine absence as absent when the database is healthy", async () => {
    vi.mocked(prisma.notificationAlertRecord.findFirst).mockResolvedValue(null as never);

    // A real "no row" is still a legitimate null — the guard must not turn every
    // first-time crisis into an error.
    await expect(findLatestAlertForCrisis("biz_1", "crisis_new")).resolves.toBeNull();
  });
});
