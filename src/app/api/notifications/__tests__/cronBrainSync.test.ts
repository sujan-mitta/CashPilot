import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The scheduled run brings the brain up to date before it assesses health.
 *
 * B-6: until now, entity links, claims, reconciliation and the materialised
 * state advanced only when a human remembered to run `npm run brain:sync`. This
 * is the automatic trigger.
 *
 * Two properties matter, and they pull in opposite directions:
 *
 *  1. ORDER. Sync runs first. An assessment made before the sync is an
 *     assessment of yesterday's understanding.
 *  2. CONTAINMENT. Sync must never be able to stop an alert. It is derived
 *     bookkeeping; a crisis alert is the thing the operator actually needs, and
 *     the assessment reads canonical rows so it is not blocked by stale derived
 *     state anyway.
 */

const { world } = vi.hoisted(() => ({
  world: {
    order: [] as string[],
    syncThrows: null as Error | null,
    businesses: [{ id: "biz-A" }, { id: "biz-B" }],
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    business: { findMany: vi.fn(async () => world.businesses) },
  },
}));

vi.mock("@/lib/brain/sync", () => ({
  syncFinancialBrain: vi.fn(async (_c: unknown, businessId: string) => {
    world.order.push(`sync:${businessId}`);
    if (world.syncThrows) throw world.syncThrows;
    return { businessId };
  }),
}));

vi.mock("@/lib/notifications/alertEvaluator", () => ({
  evaluateAndDispatchAlerts: vi.fn(async ({ businessId }: { businessId: string }) => {
    world.order.push(`alert:${businessId}`);
    return {
      evaluationStatus: "SENT",
      emailsSent: 1,
      emailsSuppressed: 0,
      crisisKey: "k",
      healthAssessment: { severity: "CRITICAL" },
      evaluatedRecipients: [],
    };
  }),
}));

vi.mock("@/lib/auth", () => ({ getSession: vi.fn(async () => null) }));

import { GET } from "../check-and-dispatch/route";

const CRON_SECRET = "test-cron-secret";

function cronRequest(query = "") {
  return new Request(`http://localhost/api/notifications/check-and-dispatch${query}`, {
    headers: { "x-cron-secret": CRON_SECRET },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = CRON_SECRET;
  world.order = [];
  world.syncThrows = null;
  world.businesses = [{ id: "biz-A" }, { id: "biz-B" }];
});

describe("Scheduled brain sync", () => {
  it("syncs before assessing, for each business", async () => {
    await GET(cronRequest());

    // Not merely "sync was called" — called BEFORE the assessment that depends
    // on it, per business.
    expect(world.order).toEqual(["sync:biz-A", "alert:biz-A", "sync:biz-B", "alert:biz-B"]);
  });

  it("still sends the alert when the sync fails", async () => {
    world.syncThrows = new Error("reconciliation deadlock");

    const res = await GET(cronRequest());
    const body = await res.json();

    // The whole point of containing it separately: derived bookkeeping failing
    // must not silence a crisis.
    expect(res.status).toBe(200);
    expect(world.order).toContain("alert:biz-A");
    expect(body.totalEmailsSent).toBeGreaterThan(0);
  });

  it("reports the sync failure rather than hiding it", async () => {
    world.syncThrows = new Error("reconciliation deadlock");

    const body = await (await GET(cronRequest())).json();
    const row = body.results.find((r: { businessId: string }) => r.businessId === "biz-A");

    expect(row.synced).toBe(false);
    expect(row.syncError).toMatch(/deadlock/);
  });

  it("does not let one business's sync failure skip the next business", async () => {
    world.syncThrows = new Error("boom");
    await GET(cronRequest());

    expect(world.order).toContain("sync:biz-B");
    expect(world.order).toContain("alert:biz-B");
  });

  it("marks a successful sync as synced", async () => {
    const body = await (await GET(cronRequest())).json();
    const row = body.results.find((r: { businessId: string }) => r.businessId === "biz-A");

    expect(row.synced).toBe(true);
    expect(row.syncError).toBeNull();
  });

  it("honours skipSync so alerts remain reachable if sync is the problem", async () => {
    await GET(cronRequest("?skipSync=1"));

    // No sync at all, alerts still delivered.
    expect(world.order).toEqual(["alert:biz-A", "alert:biz-B"]);
  });

  it("still requires the cron secret", async () => {
    const res = await GET(
      new Request("http://localhost/api/notifications/check-and-dispatch")
    );

    expect(res.status).toBe(401);
    // Nothing may run before authorization — sync writes to the database.
    expect(world.order).toEqual([]);
  });
});
