import { describe, it, expect, beforeEach } from "vitest";
import { makeMockClient, asClient } from "./mockClaimEvidenceClient";
import {
  deriveFromInvoice,
  deriveFromTransaction,
  deriveFromPayout,
  ingestInvoice,
  ingestTransaction,
  ingestPayout,
  type InvoiceRow,
  type TransactionRow,
  type PayoutRow,
} from "../ingest";

const NOW = new Date("2026-09-01T00:00:00.000Z");

const INVOICE: InvoiceRow = {
  id: "inv-1",
  customerName: "ABC Ltd",
  amount: 500000,
  dueDate: new Date("2026-09-05T00:00:00.000Z"),
  status: "PENDING",
};

describe("deriveFromInvoice", () => {
  it("produces a CONTRACTUAL claim about the invoice with ERP evidence", () => {
    const { claim, evidence } = deriveFromInvoice(INVOICE, NOW);
    expect(claim.claimType).toBe("CONTRACTUAL");
    expect(claim.subjectType).toBe("INVOICE");
    expect(claim.subjectId).toBe("inv-1");
    expect(claim.amount).toBe(500000);
    expect(claim.effectiveAt).toEqual(INVOICE.dueDate);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].sourceType).toBe("ERP");
    expect(evidence[0].evidenceType).toBe("ERP_INVOICE");
  });
});

describe("deriveFromTransaction - claim type follows settlement status (spec §13)", () => {
  const base: TransactionRow = {
    id: "tx-1",
    amount: 250000,
    type: "INFLOW",
    status: "SUCCESS",
    expectedDate: new Date("2026-09-03T00:00:00.000Z"),
  };

  it("SUCCESS -> ACTUAL (a fact)", () => {
    expect(deriveFromTransaction({ ...base, status: "SUCCESS" }, NOW).claim.claimType).toBe("ACTUAL");
  });
  it("FAILED -> CONTRADICTED (expected inflow did not occur)", () => {
    expect(deriveFromTransaction({ ...base, status: "FAILED" }, NOW).claim.claimType).toBe("CONTRADICTED");
  });
  it("PENDING -> EXPECTED (not yet a fact)", () => {
    expect(deriveFromTransaction({ ...base, status: "PENDING" }, NOW).claim.claimType).toBe("EXPECTED");
  });
  it("attaches BANK evidence", () => {
    expect(deriveFromTransaction(base, NOW).evidence[0].sourceType).toBe("BANK");
  });
});

describe("deriveFromPayout", () => {
  const base: PayoutRow = {
    id: "po-1",
    vendor: "Packaging Co",
    amount: 300000,
    scheduledDate: new Date("2026-09-08T00:00:00.000Z"),
    criticality: "MEDIUM",
    status: "SCHEDULED",
  };

  it("SCHEDULED -> CONTRACTUAL obligation", () => {
    expect(deriveFromPayout(base, NOW).claim.claimType).toBe("CONTRACTUAL");
  });
  it("PAID -> ACTUAL", () => {
    expect(deriveFromPayout({ ...base, status: "PAID" }, NOW).claim.claimType).toBe("ACTUAL");
  });
});

describe("ingest* orchestrators", () => {
  let mock: ReturnType<typeof makeMockClient>;
  beforeEach(() => {
    mock = makeMockClient();
  });

  it("ingestInvoice persists one claim + one evidence and is idempotent", async () => {
    await ingestInvoice(asClient(mock), "biz-A", INVOICE, NOW);
    await ingestInvoice(asClient(mock), "biz-A", INVOICE, NOW); // re-run
    expect(mock.claimRows).toHaveLength(1);
    expect(mock.evidenceRows).toHaveLength(1);
  });

  it("ingestTransaction and ingestPayout each persist their claim", async () => {
    await ingestTransaction(asClient(mock), "biz-A", {
      id: "tx-1",
      amount: 250000,
      type: "INFLOW",
      status: "SUCCESS",
      expectedDate: new Date("2026-09-03T00:00:00.000Z"),
    }, NOW);
    await ingestPayout(asClient(mock), "biz-A", {
      id: "po-1",
      vendor: "Packaging Co",
      amount: 300000,
      scheduledDate: new Date("2026-09-08T00:00:00.000Z"),
      criticality: "MEDIUM",
      status: "SCHEDULED",
    }, NOW);
    expect(mock.claimRows).toHaveLength(2);
    expect(mock.claimRows.map((c) => c.subjectType).sort()).toEqual(["PAYOUT", "TRANSACTION"]);
  });

  it("keeps different tenants' identical rows separate", async () => {
    await ingestInvoice(asClient(mock), "biz-A", INVOICE, NOW);
    await ingestInvoice(asClient(mock), "biz-B", INVOICE, NOW);
    expect(mock.claimRows).toHaveLength(2);
  });
});
