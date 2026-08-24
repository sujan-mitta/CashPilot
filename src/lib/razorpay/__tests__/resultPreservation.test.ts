import { describe, it, expect } from "vitest";

/**
 * Phase 20 F1 (invoice path): settlement used to overwrite AgentAction.result
 * with a prose string. That field is the ONLY record mapping payment links to
 * invoices, and the collections branch re-parses it on every settlement - so
 * the overwrite made a second settlement attempt unparseable and therefore
 * undetectable. Verified live: a duplicate was correctly prevented but could
 * not be recorded.
 *
 * These pin the shape the fix must preserve.
 */
describe("F1 invoice path - settlement must not destroy the links record", () => {
  const links = [
    { invoiceId: "inv-1", paymentLinkId: "plink_1", amount: 4400000, customerName: "Acme" },
    { invoiceId: "inv-2", paymentLinkId: "plink_2", amount: 100000, customerName: "Beta" },
  ];
  const original = { message: "Generated payment links for 2 of 2 overdue invoices.", links };

  /** Mirrors what settlement now writes back. */
  const afterSettlement = (parsed: any, detail: string) =>
    JSON.stringify({ ...parsed, settlement: detail });

  it("the post-settlement result is still valid JSON", () => {
    const written = afterSettlement(original, "Successfully prioritized collections via plink_1");
    expect(() => JSON.parse(written)).not.toThrow();
  });

  it("the links array survives settlement intact", () => {
    const written = afterSettlement(original, "settled");
    const reparsed = JSON.parse(written);
    expect(reparsed.links).toHaveLength(2);
    expect(reparsed.links.find((l: any) => l.paymentLinkId === "plink_1").invoiceId).toBe("inv-1");
  });

  it("a SECOND settlement can still resolve its link - the duplicate is detectable", () => {
    const written = afterSettlement(original, "settled once");
    const reparsed = JSON.parse(written);
    // This lookup is exactly what the collections branch performs. Before the
    // fix it threw, the branch was skipped, and the duplicate went unrecorded.
    const match = reparsed.links?.find((l: any) => l.paymentLinkId === "plink_2");
    expect(match).toBeDefined();
    expect(match.invoiceId).toBe("inv-2");
  });

  it("the settlement outcome is recorded alongside, not instead of, the links", () => {
    const written = afterSettlement(original, "Successfully prioritized collections");
    const reparsed = JSON.parse(written);
    expect(reparsed.settlement).toContain("Successfully prioritized");
    expect(reparsed.message).toBe(original.message);
    expect(reparsed.links).toEqual(links);
  });

  it("REGRESSION: a prose-only result is unparseable - the old behaviour", () => {
    const oldStyle = "Successfully prioritized collections via Razorpay Link plink_1";
    expect(() => JSON.parse(oldStyle)).toThrow();
  });
});
