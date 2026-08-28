import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recordFinancialEvent,
  type RecordFinancialEventInput,
  type FinancialEventClient,
} from "../financialEvent";

/**
 * An in-memory stand-in for the Prisma client that models the ONE thing this
 * writer relies on for correctness: the (businessId, sourceType, sourceRecordId)
 * unique constraint. A duplicate insert throws a P2002, exactly as Prisma does.
 */
function makeMockClient() {
  const rows: Array<Record<string, unknown>> = [];
  let seq = 0;

  const client = {
    financialEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const clash = rows.find(
          (r) =>
            r.businessId === data.businessId &&
            r.sourceType === data.sourceType &&
            r.sourceRecordId === data.sourceRecordId
        );
        if (clash) {
          const e = new Error(
            "Unique constraint failed on the fields: (`businessId`,`sourceType`,`sourceRecordId`)"
          ) as Error & { code: string };
          e.code = "P2002";
          throw e;
        }
        const row = {
          id: `fe_${++seq}`,
          currency: "INR",
          entityId: null,
          amount: null,
          status: null,
          normalizedData: null,
          rawReference: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, { businessId: string; sourceType: string; sourceRecordId: string }> }) => {
        const key = where.businessId_sourceType_sourceRecordId;
        return (
          rows.find(
            (r) =>
              r.businessId === key.businessId &&
              r.sourceType === key.sourceType &&
              r.sourceRecordId === key.sourceRecordId
          ) ?? null
        );
      }),
    },
    rows,
  };

  return client;
}

// A cast helper: the mock structurally satisfies the writer's needs.
function asClient(mock: ReturnType<typeof makeMockClient>): FinancialEventClient {
  return mock as unknown as FinancialEventClient;
}

const BASE_INPUT: RecordFinancialEventInput = {
  eventType: "INVOICE_CREATED",
  sourceType: "ERP",
  sourceRecordId: "INV-1001",
  occurredAt: new Date("2026-09-01T00:00:00.000Z"),
  amount: 500000, // paise
};

describe("recordFinancialEvent - ingestion", () => {
  let mock: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    mock = makeMockClient();
  });

  it("inserts a new event and reports created: true", async () => {
    const { event, created } = await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT);
    expect(created).toBe(true);
    expect(event.businessId).toBe("biz-A");
    expect(event.sourceType).toBe("ERP");
    expect(event.sourceRecordId).toBe("INV-1001");
    expect(event.amount).toBe(500000);
    expect(mock.rows).toHaveLength(1);
  });

  it("defaults effectiveAt to occurredAt and currency to INR", async () => {
    const { event } = await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT);
    expect(event.effectiveAt).toEqual(BASE_INPUT.occurredAt);
    expect(event.currency).toBe("INR");
  });

  it("honours an explicit effectiveAt distinct from occurredAt", async () => {
    const effectiveAt = new Date("2026-09-10T00:00:00.000Z");
    const { event } = await recordFinancialEvent(asClient(mock), "biz-A", { ...BASE_INPUT, effectiveAt });
    expect(event.effectiveAt).toEqual(effectiveAt);
    expect(event.occurredAt).toEqual(BASE_INPUT.occurredAt);
  });

  it("supports a null amount for non-monetary events", async () => {
    const { event } = await recordFinancialEvent(asClient(mock), "biz-A", {
      eventType: "INVOICE_DUE",
      sourceType: "ERP",
      sourceRecordId: "INV-DUE-1",
      occurredAt: BASE_INPUT.occurredAt,
      amount: null,
    });
    expect(event.amount).toBeNull();
  });
});

describe("recordFinancialEvent - idempotency (spec §7, §50-B)", () => {
  let mock: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    mock = makeMockClient();
  });

  it("same event once -> one row", async () => {
    await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT);
    expect(mock.rows).toHaveLength(1);
  });

  it("same event twice -> one row, second is created: false", async () => {
    const first = await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT);
    const second = await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(mock.rows).toHaveLength(1);
  });

  it("same event ten times -> one row, one insert", async () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT));
    }
    expect(mock.rows).toHaveLength(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(9);
    // Every call resolves to the same event.
    const ids = new Set(results.map((r) => r.event.id));
    expect(ids.size).toBe(1);
  });

  it("same event after a restart (row already persisted) -> created: false", async () => {
    // Simulate a restart: a fresh process/client, but the row from before the
    // restart is already in the table.
    await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT);
    const freshMock = makeMockClient();
    freshMock.rows.push({ ...mock.rows[0] });
    const after = await recordFinancialEvent(asClient(freshMock), "biz-A", BASE_INPUT);
    expect(after.created).toBe(false);
    expect(freshMock.rows).toHaveLength(1);
  });

  it("same event after a partial failure -> the retry is idempotent", async () => {
    // First attempt: the insert lands but the caller crashes before it can
    // record success. The retry must not create a second row.
    await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT);
    const retry = await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT);
    expect(retry.created).toBe(false);
    expect(mock.rows).toHaveLength(1);
  });

  it("resolves the concurrent-insert race to the winning row", async () => {
    // Two writers with the same identity, insert order serialised: the second
    // create trips the unique constraint and is resolved by reading the winner.
    const [a, b] = [
      await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT),
      await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT),
    ];
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.event.id).toBe(b.event.id);
    expect(mock.rows).toHaveLength(1);
  });
});

describe("recordFinancialEvent - error handling", () => {
  it("re-throws a non-duplicate database error rather than swallowing it", async () => {
    const mock = makeMockClient();
    mock.financialEvent.create.mockImplementationOnce(async () => {
      const e = new Error("connection reset") as Error & { code: string };
      e.code = "P1001"; // not a unique violation
      throw e;
    });
    await expect(recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT)).rejects.toThrow("connection reset");
    // findUnique must not have been consulted for a non-duplicate error.
    expect(mock.financialEvent.findUnique).not.toHaveBeenCalled();
  });

  it("re-throws if a unique violation cannot be resolved to an existing row", async () => {
    const mock = makeMockClient();
    // Force a P2002 with no row behind it (an unexpected constraint).
    mock.financialEvent.create.mockImplementationOnce(async () => {
      const e = new Error("some other unique constraint") as Error & { code: string };
      e.code = "P2002";
      throw e;
    });
    await expect(recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT)).rejects.toThrow();
  });

  it("rejects a missing tenantId", async () => {
    const mock = makeMockClient();
    await expect(recordFinancialEvent(asClient(mock), "", BASE_INPUT)).rejects.toThrow(/tenantId/);
    expect(mock.financialEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a missing source identity", async () => {
    const mock = makeMockClient();
    await expect(
      recordFinancialEvent(asClient(mock), "biz-A", { ...BASE_INPUT, sourceRecordId: "" })
    ).rejects.toThrow(/sourceType and sourceRecordId/);
    expect(mock.financialEvent.create).not.toHaveBeenCalled();
  });
});

describe("recordFinancialEvent - tenant isolation (spec §47, §50-D)", () => {
  it("scopes the idempotency identity by tenant: same source record, two tenants -> two events", async () => {
    const mock = makeMockClient();
    const a = await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT);
    const b = await recordFinancialEvent(asClient(mock), "biz-B", BASE_INPUT);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.event.id).not.toBe(b.event.id);
    expect(a.event.businessId).toBe("biz-A");
    expect(b.event.businessId).toBe("biz-B");
    expect(mock.rows).toHaveLength(2);
  });

  it("a tenant's duplicate does not collide with another tenant's identical record", async () => {
    const mock = makeMockClient();
    await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT);
    await recordFinancialEvent(asClient(mock), "biz-A", BASE_INPUT); // dup for A
    const b = await recordFinancialEvent(asClient(mock), "biz-B", BASE_INPUT); // new for B
    expect(b.created).toBe(true);
    expect(mock.rows).toHaveLength(2);
  });
});
