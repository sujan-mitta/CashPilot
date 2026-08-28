import { describe, it, expect, vi } from "vitest";
import {
  materializeFinancialState,
  getLatestFinancialState,
  getFinancialStateVersion,
  type FinancialStateClient,
} from "../store";
import { computeFinancialState, type FinancialStateInputs } from "../financialState";

const TENANT_A = "biz_A";
const TENANT_B = "biz_B";
const TODAY = new Date("2026-09-01T00:00:00Z");

type Row = Record<string, unknown>;

function p2002(): Error & { code: string } {
  const e = new Error("Unique constraint failed") as Error & { code: string };
  e.code = "P2002";
  return e;
}

/**
 * In-memory FinancialState table. Enforces the one constraint the store relies
 * on - (businessId, stateVersion) unique - and filters on every key the real
 * queries filter on, so a tenant-isolation test cannot pass vacuously.
 */
function makeMock() {
  const rows: Row[] = [];
  let seq = 0;

  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const mock = {
    rows,
    financialState: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
        const hits = rows.filter((r) => matches(r, where));
        if (orderBy && (orderBy as Row).stateVersion === "desc") {
          hits.sort((a, b) => (b.stateVersion as number) - (a.stateVersion as number));
        }
        return hits[0] ? { ...hits[0] } : null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const clash = rows.find(
          (r) => r.businessId === data.businessId && r.stateVersion === data.stateVersion
        );
        if (clash) throw p2002();
        const row: Row = { id: `fs_${++seq}`, createdAt: new Date(), ...data };
        rows.push(row);
        return { ...row };
      }),
    },
  };
  return mock;
}

const asClient = (m: ReturnType<typeof makeMock>) => m as unknown as FinancialStateClient;

function snapshot(overrides: Partial<FinancialStateInputs> = {}) {
  return computeFinancialState({
    currentCash: 1000000_00,
    requiredBuffer: 700000_00,
    today: TODAY,
    transactions: [],
    invoices: [],
    payouts: [],
    ...overrides,
  });
}

describe("materializeFinancialState", () => {
  it("creates version 1 on the first materialisation", async () => {
    const mock = makeMock();
    const r = await materializeFinancialState(asClient(mock), TENANT_A, snapshot());

    expect(r.created).toBe(true);
    expect(r.unchanged).toBe(false);
    expect(r.state.stateVersion).toBe(1);
    expect(mock.rows).toHaveLength(1);
  });

  it("writes nothing when the financial reality has not changed", async () => {
    const mock = makeMock();
    const client = asClient(mock);
    await materializeFinancialState(client, TENANT_A, snapshot());

    for (let i = 0; i < 10; i++) {
      const again = await materializeFinancialState(client, TENANT_A, snapshot());
      expect(again.unchanged).toBe(true);
      expect(again.created).toBe(false);
      expect(again.state.stateVersion).toBe(1);
    }
    // stateVersion must count changes, not how often we looked.
    expect(mock.rows).toHaveLength(1);
  });

  it("does not advance the version just because time passed", async () => {
    const mock = makeMock();
    const client = asClient(mock);
    await materializeFinancialState(client, TENANT_A, snapshot({ today: TODAY }));
    const later = await materializeFinancialState(
      client,
      TENANT_A,
      snapshot({ today: new Date(TODAY.getTime() + 6 * 36e5) })
    );

    expect(later.unchanged).toBe(true);
    expect(mock.rows).toHaveLength(1);
  });

  it("advances the version when the reality changes", async () => {
    const mock = makeMock();
    const client = asClient(mock);

    await materializeFinancialState(client, TENANT_A, snapshot({ currentCash: 100 }));
    const second = await materializeFinancialState(client, TENANT_A, snapshot({ currentCash: 200 }));
    const third = await materializeFinancialState(client, TENANT_A, snapshot({ currentCash: 300 }));

    expect(second.state.stateVersion).toBe(2);
    expect(third.state.stateVersion).toBe(3);
    expect(mock.rows).toHaveLength(3);
  });

  it("keeps every past state rather than overwriting (spec §46)", async () => {
    const mock = makeMock();
    const client = asClient(mock);
    await materializeFinancialState(client, TENANT_A, snapshot({ currentCash: 100 }));
    await materializeFinancialState(client, TENANT_A, snapshot({ currentCash: 200 }));

    const v1 = await getFinancialStateVersion(client, TENANT_A, 1);
    expect(v1!.cashPosition).toBe(100);
    expect(mock.financialState.create).toHaveBeenCalledTimes(2);
  });

  it("returns to an earlier reality as a NEW version, not by rewinding", async () => {
    const mock = makeMock();
    const client = asClient(mock);
    await materializeFinancialState(client, TENANT_A, snapshot({ currentCash: 100 }));
    await materializeFinancialState(client, TENANT_A, snapshot({ currentCash: 200 }));
    const back = await materializeFinancialState(client, TENANT_A, snapshot({ currentCash: 100 }));

    expect(back.state.stateVersion).toBe(3);
    expect(back.created).toBe(true);
  });

  it("resolves the version race by re-reading rather than failing", async () => {
    const mock = makeMock();
    const client = asClient(mock);

    // A competing writer lands version 1 between our read and our insert.
    mock.financialState.create.mockImplementationOnce(async () => {
      mock.rows.push({
        id: "fs_other",
        businessId: TENANT_A,
        stateVersion: 1,
        stateHash: "someone-elses-state",
        cashPosition: 0,
      });
      throw p2002();
    });

    const r = await materializeFinancialState(client, TENANT_A, snapshot());
    expect(r.created).toBe(true);
    expect(r.state.stateVersion).toBe(2);
  });

  it("returns the competitor's row when it stored our exact content", async () => {
    const mock = makeMock();
    const client = asClient(mock);
    const snap = snapshot();

    mock.financialState.create.mockImplementationOnce(async () => {
      mock.rows.push({
        id: "fs_other",
        businessId: TENANT_A,
        stateVersion: 1,
        stateHash: snap.stateHash,
        cashPosition: snap.cashPosition,
      });
      throw p2002();
    });

    const r = await materializeFinancialState(client, TENANT_A, snap);
    expect(r.unchanged).toBe(true);
    expect(r.state.id).toBe("fs_other");
    expect(mock.rows).toHaveLength(1);
  });

  it("re-throws a non-duplicate failure instead of retrying it", async () => {
    const mock = makeMock();
    mock.financialState.create.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      materializeFinancialState(asClient(mock), TENANT_A, snapshot())
    ).rejects.toThrow("connection reset");
  });

  it("gives up after bounded attempts rather than looping forever", async () => {
    const mock = makeMock();
    mock.financialState.create.mockRejectedValue(p2002());
    await expect(
      materializeFinancialState(asClient(mock), TENANT_A, snapshot())
    ).rejects.toThrow(/after 5 attempts/);
  });

  it("requires a tenant", async () => {
    const mock = makeMock();
    await expect(materializeFinancialState(asClient(mock), "", snapshot())).rejects.toThrow(
      /tenantId/
    );
  });
});

describe("tenant isolation (spec §47)", () => {
  it("versions each tenant independently", async () => {
    const mock = makeMock();
    const client = asClient(mock);

    await materializeFinancialState(client, TENANT_A, snapshot({ currentCash: 100 }));
    await materializeFinancialState(client, TENANT_A, snapshot({ currentCash: 200 }));
    const b = await materializeFinancialState(client, TENANT_B, snapshot({ currentCash: 999 }));

    // Tenant B starts at 1, not at 3.
    expect(b.state.stateVersion).toBe(1);
  });

  it("does not return another tenant's state", async () => {
    const mock = makeMock();
    const client = asClient(mock);
    await materializeFinancialState(client, TENANT_A, snapshot());

    expect(await getLatestFinancialState(client, TENANT_B)).toBeNull();
    expect(await getFinancialStateVersion(client, TENANT_B, 1)).toBeNull();
  });

  it("does not treat another tenant's identical state as unchanged", async () => {
    const mock = makeMock();
    const client = asClient(mock);
    const snap = snapshot();

    await materializeFinancialState(client, TENANT_A, snap);
    const b = await materializeFinancialState(client, TENANT_B, snap);

    expect(b.created).toBe(true);
    expect(b.unchanged).toBe(false);
    expect(mock.rows).toHaveLength(2);
  });
});
