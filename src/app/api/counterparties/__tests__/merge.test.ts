import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The counterparty merge review endpoint.
 *
 * A wrong merge silently attaches one customer's payment history to another,
 * and the behaviour model then makes confident predictions from fabricated
 * history. There is no error message for that — it just quietly produces worse
 * forecasts forever. So the properties worth pinning here are the refusals, not
 * the happy path.
 */

const { world } = vi.hoisted(() => ({
  world: {
    session: null as { businessId: string; userId: string } | null,
    counterparties: [] as Record<string, unknown>[],
    mergeCalls: [] as { tenantId: string; sourceId: string; targetId: string }[],
    mergeThrows: null as Error | null,
    transactionOpened: false,
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    counterparty: {
      findMany: vi.fn(async ({ where }: { where: { businessId: string } }) =>
        world.counterparties.filter((c) => c.businessId === where.businessId)
      ),
      findFirst: vi.fn(async () => null),
    },
    counterpartyAlias: { updateMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      world.transactionOpened = true;
      return cb({});
    }),
  },
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => world.session),
}));

vi.mock("@/lib/entities/store", () => ({
  mergeCounterparties: vi.fn(
    async (_tx: unknown, tenantId: string, sourceId: string, targetId: string) => {
      world.mergeCalls.push({ tenantId, sourceId, targetId });
      if (world.mergeThrows) throw world.mergeThrows;
      return { aliasesMoved: 2, sourceId, targetId };
    }
  ),
}));

import { GET, POST } from "../merge/route";

const post = (body: unknown) =>
  new Request("http://localhost/api/counterparties/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  world.session = { businessId: "biz-A", userId: "user-1" };
  world.counterparties = [];
  world.mergeCalls = [];
  world.mergeThrows = null;
  world.transactionOpened = false;
});

describe("Authorization", () => {
  it("refuses an unauthenticated listing", async () => {
    world.session = null;
    const res = await GET(new Request("http://localhost/api/counterparties/merge"));
    expect(res.status).toBe(401);
  });

  it("refuses an unauthenticated merge", async () => {
    world.session = null;
    const res = await POST(post({ sourceId: "a", targetId: "b" }));

    expect(res.status).toBe(401);
    // Nothing may reach the merge before the session is established.
    expect(world.mergeCalls).toHaveLength(0);
  });
});

describe("Tenant scoping", () => {
  it("takes the tenant from the session, never from the request", async () => {
    await POST(post({ sourceId: "a", targetId: "b", businessId: "biz-VICTIM" }));

    // A businessId in the body must be ignored entirely; honouring it would let
    // any authenticated user merge another tenant's entities.
    expect(world.mergeCalls[0].tenantId).toBe("biz-A");
  });

  it("lists only the caller's own counterparties", async () => {
    world.counterparties = [
      {
        id: "c1",
        businessId: "biz-A",
        displayName: "Acme Ltd",
        normalizedName: "acme",
        type: "CUSTOMER",
        mergedIntoId: null,
        createdAt: new Date(),
      },
      {
        id: "c2",
        businessId: "biz-B",
        displayName: "Acme Limited",
        normalizedName: "acme limited",
        type: "CUSTOMER",
        mergedIntoId: null,
        createdAt: new Date(),
      },
    ];

    const res = await GET(new Request("http://localhost/api/counterparties/merge"));
    const body = await res.json();

    // Cross-tenant pairs must never be proposed — that would be an invitation
    // to merge two different companies' customers together.
    for (const s of body.suggestions) {
      expect(s.sourceId).toBe("c1");
    }
  });
});

describe("Input validation", () => {
  it("rejects a missing id", async () => {
    const res = await POST(post({ sourceId: "a" }));
    expect(res.status).toBe(400);
    expect(world.mergeCalls).toHaveLength(0);
  });

  it("rejects a non-string id rather than coercing it", async () => {
    const res = await POST(post({ sourceId: 1, targetId: { id: "b" } }));
    expect(res.status).toBe(400);
    expect(world.mergeCalls).toHaveLength(0);
  });

  it("rejects a malformed body", async () => {
    const req = new Request("http://localhost/api/counterparties/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("Executing a confirmed merge", () => {
  it("runs inside a transaction", async () => {
    // C-4: the merge's statement order converges after a crash, but partial
    // convergence is not atomicity. A reviewer gets all of it or none.
    await POST(post({ sourceId: "a", targetId: "b" }));
    expect(world.transactionOpened).toBe(true);
  });

  it("returns the merge result on success", async () => {
    const res = await POST(post({ sourceId: "a", targetId: "b" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.merge.aliasesMoved).toBe(2);
  });

  it("merges exactly the pair named, and only once", async () => {
    await POST(post({ sourceId: "a", targetId: "b" }));

    expect(world.mergeCalls).toEqual([{ tenantId: "biz-A", sourceId: "a", targetId: "b" }]);
  });
});

describe("Refusals are declined, not crashed", () => {
  const refusals = [
    "Cannot merge a counterparty into itself.",
    "Merge source has already been merged.",
    "Cannot merge counterparties of different types.",
    "Merge target counterparty not found for this tenant.",
  ];

  for (const message of refusals) {
    it(`answers 409 for: ${message}`, async () => {
      world.mergeThrows = new Error(message);
      const res = await POST(post({ sourceId: "a", targetId: "b" }));

      // 409, not 500: the system did not break, it declined. And not 404 for
      // the "not found" case, so the response cannot be used to probe which
      // ids exist inside another tenant.
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(message);
    });
  }

  it("still answers 500 for a genuine fault", async () => {
    world.mergeThrows = new Error("connection terminated unexpectedly");
    const res = await POST(post({ sourceId: "a", targetId: "b" }));
    expect(res.status).toBe(500);
  });
});
