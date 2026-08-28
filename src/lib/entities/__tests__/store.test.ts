import { describe, it, expect } from "vitest";
import {
  resolveCounterparty,
  resolveCanonicalCounterparty,
  mergeCounterparties,
  backfillInvoiceCounterparties,
  backfillPayoutCounterparties,
} from "../store";
import { makeMockCounterpartyClient, asClient, type MockCounterpartyClient } from "./mockCounterpartyClient";

const TENANT_A = "biz_A";
const TENANT_B = "biz_B";

function setup() {
  const mock = makeMockCounterpartyClient();
  return { mock, client: asClient(mock) };
}

const erp = (rawName: string) => ({ type: "CUSTOMER" as const, rawName, sourceType: "ERP" });

describe("resolveCounterparty - idempotency", () => {
  it("resolves the same name to one entity however many times it is ingested", async () => {
    const { mock, client } = setup();

    const first = await resolveCounterparty(client, TENANT_A, erp("ABC Ltd"));
    expect(first.created).toBe(true);

    for (let i = 0; i < 10; i++) {
      const again = await resolveCounterparty(client, TENANT_A, erp("ABC Ltd"));
      expect(again.created).toBe(false);
      expect(again.counterparty!.id).toBe(first.counterparty!.id);
    }
    expect(mock.counterpartyRows).toHaveLength(1);
  });

  it("resolves notational variants of one company to the same entity", async () => {
    const { mock, client } = setup();

    const a = await resolveCounterparty(client, TENANT_A, erp("ABC Ltd"));
    const b = await resolveCounterparty(client, TENANT_A, erp("ABC LIMITED"));
    const c = await resolveCounterparty(client, TENANT_A, {
      ...erp("  abc  ltd. "),
      sourceType: "BANK",
    });

    expect(b.counterparty!.id).toBe(a.counterparty!.id);
    expect(c.counterparty!.id).toBe(a.counterparty!.id);
    // Creation records the canonical spelling as an alias, so every later
    // variant resolves through the single indexed alias lookup.
    expect(b.decision.method).toBe("ALIAS");
    expect(c.decision.method).toBe("ALIAS");
    expect(mock.counterpartyRows).toHaveLength(1);
  });

  it("matches on canonical form when no alias has been recorded yet", async () => {
    const { mock, client } = setup();
    // An entity with no alias row - the state left behind by a direct write or
    // an entity whose alias rows were moved by a merge.
    const row = await mock.counterparty.create({
      data: {
        businessId: TENANT_A,
        type: "CUSTOMER",
        displayName: "ABC Ltd",
        normalizedName: "abc",
      },
    });

    const hit = await resolveCounterparty(client, TENANT_A, erp("ABC LIMITED"));

    expect(hit.decision.method).toBe("EXACT");
    expect(hit.counterparty!.id).toBe(row.id);
    expect(hit.created).toBe(false);
    // The spelling is recorded so the next lookup is an alias hit.
    expect(mock.aliasRows).toHaveLength(1);
    expect(mock.aliasRows[0].matchMethod).toBe("EXACT");
  });

  it("resolves to the winner when a concurrent insert wins the race", async () => {
    const { mock, client } = setup();

    // Both callers read an empty world, then both try to insert. The unique
    // constraint - not the read - is what makes this converge.
    const [a, b] = await Promise.all([
      resolveCounterparty(client, TENANT_A, erp("Acme Corp")),
      resolveCounterparty(client, TENANT_A, erp("Acme Corporation")),
    ]);

    expect(a.counterparty!.id).toBe(b.counterparty!.id);
    expect(mock.counterpartyRows).toHaveLength(1);
    // Exactly one of them did the creating.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it("re-throws a non-duplicate failure instead of swallowing it", async () => {
    const { mock, client } = setup();
    mock.counterparty.create.mockRejectedValueOnce(new Error("connection reset"));
    await expect(resolveCounterparty(client, TENANT_A, erp("ABC Ltd"))).rejects.toThrow(
      "connection reset"
    );
  });

  it("requires a tenant and a source", async () => {
    const { client } = setup();
    await expect(resolveCounterparty(client, "", erp("ABC Ltd"))).rejects.toThrow(/tenantId/);
    await expect(
      resolveCounterparty(client, TENANT_A, { type: "CUSTOMER", rawName: "ABC", sourceType: "" })
    ).rejects.toThrow(/sourceType/);
  });
});

describe("resolveCounterparty - conservatism", () => {
  it("keeps a near-match separate and reports it as a suggestion", async () => {
    const { mock, client } = setup();

    const abc = await resolveCounterparty(client, TENANT_A, erp("ABC Ltd"));
    const ind = await resolveCounterparty(client, TENANT_A, erp("ABC Industries Pvt Ltd"));

    expect(ind.decision.method).toBe("CANDIDATE");
    // Distinct entities: a wrong merge is unrecoverable, a duplicate is not.
    expect(ind.counterparty!.id).not.toBe(abc.counterparty!.id);
    expect(ind.decision.candidates.map((c) => c.id)).toContain(abc.counterparty!.id);
    expect(mock.counterpartyRows).toHaveLength(2);
  });

  it("creates nothing for an unresolvable name", async () => {
    const { mock, client } = setup();
    const r = await resolveCounterparty(client, TENANT_A, erp("   "));
    expect(r.counterparty).toBeNull();
    expect(r.decision.method).toBe("UNRESOLVABLE");
    expect(mock.counterpartyRows).toHaveLength(0);
  });

  it("with autoCreate disabled, reports the decision without writing", async () => {
    const { mock, client } = setup();
    const r = await resolveCounterparty(client, TENANT_A, erp("ABC Ltd"), { autoCreate: false });
    expect(r.counterparty).toBeNull();
    expect(r.decision.method).toBe("NEW");
    expect(mock.counterpartyRows).toHaveLength(0);
    expect(mock.aliasRows).toHaveLength(0);
  });

  it("separates the same name used as a customer and as a supplier", async () => {
    const { mock, client } = setup();
    const cust = await resolveCounterparty(client, TENANT_A, {
      type: "CUSTOMER",
      rawName: "Acme Corp",
      sourceType: "ERP",
    });
    const supp = await resolveCounterparty(client, TENANT_A, {
      type: "SUPPLIER",
      rawName: "Acme Corp",
      sourceType: "ERP",
    });
    expect(supp.counterparty!.id).not.toBe(cust.counterparty!.id);
    expect(mock.counterpartyRows).toHaveLength(2);
  });
});

describe("tenant isolation (spec §47)", () => {
  it("never resolves one tenant's name to another tenant's entity", async () => {
    const { mock, client } = setup();

    const a = await resolveCounterparty(client, TENANT_A, erp("ABC Ltd"));
    const b = await resolveCounterparty(client, TENANT_B, erp("ABC Ltd"));

    expect(b.created).toBe(true);
    expect(b.counterparty!.id).not.toBe(a.counterparty!.id);
    expect(b.decision.method).toBe("NEW");
    expect(mock.counterpartyRows).toHaveLength(2);
  });

  it("never surfaces another tenant's entity as a merge candidate", async () => {
    const { client } = setup();
    await resolveCounterparty(client, TENANT_A, erp("ABC Ltd"));
    const b = await resolveCounterparty(client, TENANT_B, erp("ABC Industries Pvt Ltd"));
    expect(b.decision.candidates).toHaveLength(0);
    expect(b.decision.method).toBe("NEW");
  });

  it("does not read another tenant's entity by id", async () => {
    const { client } = setup();
    const a = await resolveCounterparty(client, TENANT_A, erp("ABC Ltd"));
    expect(await resolveCanonicalCounterparty(client, TENANT_B, a.counterparty!.id)).toBeNull();
  });

  it("refuses to merge across tenants", async () => {
    const { client } = setup();
    const a = await resolveCounterparty(client, TENANT_A, erp("ABC Ltd"));
    const b = await resolveCounterparty(client, TENANT_B, erp("XYZ Ltd"));
    await expect(
      mergeCounterparties(client, TENANT_A, a.counterparty!.id, b.counterparty!.id)
    ).rejects.toThrow(/not found for this tenant/);
  });
});

describe("mergeCounterparties", () => {
  async function twoEntities() {
    const { mock, client } = setup();
    const target = await resolveCounterparty(client, TENANT_A, erp("ABC Ltd"));
    const source = await resolveCounterparty(client, TENANT_A, erp("ABC Industries Pvt Ltd"));
    return { mock, client, target: target.counterparty!, source: source.counterparty! };
  }

  it("resolves the merged-away name to the survivor afterwards", async () => {
    const { client, target, source } = await twoEntities();

    await mergeCounterparties(client, TENANT_A, source.id, target.id);

    const again = await resolveCounterparty(client, TENANT_A, erp("ABC Industries Pvt Ltd"));
    expect(again.counterparty!.id).toBe(target.id);
    expect(again.created).toBe(false);
  });

  it("keeps the losing row for audit rather than deleting it (spec §46)", async () => {
    const { mock, client, target, source } = await twoEntities();
    await mergeCounterparties(client, TENANT_A, source.id, target.id);

    expect(mock.counterpartyRows).toHaveLength(2);
    const loser = mock.counterpartyRows.find((c) => c.id === source.id)!;
    expect(loser.mergedIntoId).toBe(target.id);
    expect(loser.mergedAt).toBeInstanceOf(Date);
  });

  it("follows the merge chain to the surviving entity", async () => {
    const { client, target, source } = await twoEntities();
    const third = await resolveCounterparty(client, TENANT_A, erp("ABC Holdings Group"));

    // third -> source -> target
    await mergeCounterparties(client, TENANT_A, third.counterparty!.id, source.id);
    await mergeCounterparties(client, TENANT_A, source.id, target.id);

    const canonical = await resolveCanonicalCounterparty(client, TENANT_A, third.counterparty!.id);
    expect(canonical!.id).toBe(target.id);
  });

  it("throws on a merge cycle instead of looping forever", async () => {
    const { mock, client, target, source } = await twoEntities();
    // Force a cycle that the merge guards would normally prevent.
    const a = mock.counterpartyRows.find((c) => c.id === source.id)!;
    const b = mock.counterpartyRows.find((c) => c.id === target.id)!;
    a.mergedIntoId = target.id;
    b.mergedIntoId = source.id;

    await expect(resolveCanonicalCounterparty(client, TENANT_A, source.id)).rejects.toThrow(
      /merge cycle/
    );
  });

  it("relinks the rows that pointed at the losing entity", async () => {
    const { mock, client, target, source } = await twoEntities();
    mock.invoiceRows.push({ id: "inv_1", businessId: TENANT_A, counterpartyId: source.id });
    mock.payoutRows.push({ id: "po_1", businessId: TENANT_A, counterpartyId: source.id });

    const result = await mergeCounterparties(client, TENANT_A, source.id, target.id);

    expect(result.invoicesRelinked).toBe(1);
    expect(result.payoutsRelinked).toBe(1);
    expect(mock.invoiceRows[0].counterpartyId).toBe(target.id);
    expect(mock.payoutRows[0].counterpartyId).toBe(target.id);
  });

  it("does not relink another tenant's rows", async () => {
    const { mock, client, target, source } = await twoEntities();
    mock.invoiceRows.push({ id: "inv_other", businessId: TENANT_B, counterpartyId: source.id });

    const result = await mergeCounterparties(client, TENANT_A, source.id, target.id);

    expect(result.invoicesRelinked).toBe(0);
    expect(mock.invoiceRows[0].counterpartyId).toBe(source.id);
  });

  it("refuses self-merge, double-merge and cross-type merge", async () => {
    const { client, target, source } = await twoEntities();

    await expect(mergeCounterparties(client, TENANT_A, target.id, target.id)).rejects.toThrow(
      /into itself/
    );

    const supplier = await resolveCounterparty(client, TENANT_A, {
      type: "SUPPLIER",
      rawName: "Packaging Co",
      sourceType: "ERP",
    });
    await expect(
      mergeCounterparties(client, TENANT_A, supplier.counterparty!.id, target.id)
    ).rejects.toThrow(/different types/);

    await mergeCounterparties(client, TENANT_A, source.id, target.id);
    await expect(mergeCounterparties(client, TENANT_A, source.id, target.id)).rejects.toThrow(
      /already been merged/
    );
  });

  it("refuses to merge into an entity that was itself merged away", async () => {
    const { client, target, source } = await twoEntities();
    const third = await resolveCounterparty(client, TENANT_A, erp("ABC Holdings Group"));
    await mergeCounterparties(client, TENANT_A, source.id, target.id);

    await expect(
      mergeCounterparties(client, TENANT_A, third.counterparty!.id, source.id)
    ).rejects.toThrow(/surviving entity/);
  });
});

describe("backfill", () => {
  function seedInvoices(mock: MockCounterpartyClient, rows: Array<{ id: string; businessId: string }>) {
    rows.forEach((r) => mock.invoiceRows.push({ ...r, counterpartyId: null }));
  }

  it("links invoices to canonical customers and reuses one entity per company", async () => {
    const { mock, client } = setup();
    seedInvoices(mock, [
      { id: "inv_1", businessId: TENANT_A },
      { id: "inv_2", businessId: TENANT_A },
      { id: "inv_3", businessId: TENANT_A },
    ]);

    const result = await backfillInvoiceCounterparties(client, TENANT_A, [
      { id: "inv_1", name: "Retail Chain A" },
      { id: "inv_2", name: "RETAIL CHAIN A LTD" },
      { id: "inv_3", name: "Distributor B" },
    ]);

    expect(result.linked).toBe(3);
    expect(result.createdCounterparties).toBe(2);
    expect(mock.invoiceRows[0].counterpartyId).toBe(mock.invoiceRows[1].counterpartyId);
    expect(mock.invoiceRows[2].counterpartyId).not.toBe(mock.invoiceRows[0].counterpartyId);
  });

  it("is safe to re-run", async () => {
    const { mock, client } = setup();
    seedInvoices(mock, [{ id: "inv_1", businessId: TENANT_A }]);
    const rows = [{ id: "inv_1", name: "Retail Chain A" }];

    const first = await backfillInvoiceCounterparties(client, TENANT_A, rows);
    const linkAfterFirst = mock.invoiceRows[0].counterpartyId;
    const second = await backfillInvoiceCounterparties(client, TENANT_A, rows);

    expect(first.createdCounterparties).toBe(1);
    expect(second.createdCounterparties).toBe(0);
    expect(mock.invoiceRows[0].counterpartyId).toBe(linkAfterFirst);
    expect(mock.counterpartyRows).toHaveLength(1);
  });

  it("reports unresolvable names instead of guessing", async () => {
    const { mock, client } = setup();
    seedInvoices(mock, [
      { id: "inv_1", businessId: TENANT_A },
      { id: "inv_2", businessId: TENANT_A },
    ]);

    const result = await backfillInvoiceCounterparties(client, TENANT_A, [
      { id: "inv_1", name: "Retail Chain A" },
      { id: "inv_2", name: "   " },
    ]);

    expect(result.linked).toBe(1);
    expect(result.unresolved).toEqual(["inv_2"]);
    expect(mock.invoiceRows[1].counterpartyId).toBeNull();
  });

  it("reports merge suggestions without acting on them", async () => {
    const { mock, client } = setup();
    seedInvoices(mock, [
      { id: "inv_1", businessId: TENANT_A },
      { id: "inv_2", businessId: TENANT_A },
    ]);

    const result = await backfillInvoiceCounterparties(client, TENANT_A, [
      { id: "inv_1", name: "ABC Ltd" },
      { id: "inv_2", name: "ABC Industries Pvt Ltd" },
    ]);

    expect(result.mergeSuggestions).toHaveLength(1);
    expect(result.mergeSuggestions[0].rowId).toBe("inv_2");
    expect(mock.counterpartyRows).toHaveLength(2);
    expect(mock.invoiceRows[0].counterpartyId).not.toBe(mock.invoiceRows[1].counterpartyId);
  });

  it("does not link a row belonging to another tenant", async () => {
    const { mock, client } = setup();
    mock.invoiceRows.push({ id: "inv_other", businessId: TENANT_B, counterpartyId: null });

    const result = await backfillInvoiceCounterparties(client, TENANT_A, [
      { id: "inv_other", name: "Retail Chain A" },
    ]);

    expect(result.linked).toBe(0);
    expect(mock.invoiceRows[0].counterpartyId).toBeNull();
  });

  it("links payouts as suppliers, not customers", async () => {
    const { mock, client } = setup();
    mock.payoutRows.push({ id: "po_1", businessId: TENANT_A, counterpartyId: null });

    await backfillPayoutCounterparties(client, TENANT_A, [{ id: "po_1", name: "Packaging Co" }]);

    expect(mock.counterpartyRows).toHaveLength(1);
    expect(mock.counterpartyRows[0].type).toBe("SUPPLIER");
    expect(mock.payoutRows[0].counterpartyId).toBe(mock.counterpartyRows[0].id);
  });
});
