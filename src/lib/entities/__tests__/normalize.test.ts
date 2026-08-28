import { describe, it, expect } from "vitest";
import { normalizeEntityName, nameTokens, nameSimilarity } from "../normalize";

describe("normalizeEntityName", () => {
  it("collapses notational differences that mean the same company", () => {
    // The exact cases from spec §8.
    expect(normalizeEntityName("ABC Ltd")).toBe("abc");
    expect(normalizeEntityName("ABC LIMITED")).toBe("abc");
    expect(normalizeEntityName("  abc   ltd.  ")).toBe("abc");
    expect(normalizeEntityName("A.B.C. Pvt Ltd")).toBe("a b c");
  });

  it("keeps genuinely different names apart", () => {
    expect(normalizeEntityName("ABC Industries Pvt Ltd")).toBe("abc industries");
    expect(normalizeEntityName("ABC-IND")).toBe("abc ind");
    // Three spellings, three DIFFERENT keys: only the ones that are notationally
    // identical may auto-merge. The rest are merge suggestions, not matches.
    expect(new Set([
      normalizeEntityName("ABC Ltd"),
      normalizeEntityName("ABC Industries Pvt Ltd"),
      normalizeEntityName("ABC-IND"),
    ]).size).toBe(3);
  });

  it("strips legal forms only as whole tokens", () => {
    // "Cointreau" must not lose its "co", "Incoterms" must not lose its "inc".
    expect(normalizeEntityName("Cointreau")).toBe("cointreau");
    expect(normalizeEntityName("Incoterms Advisory")).toBe("incoterms advisory");
    expect(normalizeEntityName("Sabre Systems")).toBe("sabre systems");
  });

  it("expands ampersands so '&' and 'and' agree", () => {
    expect(normalizeEntityName("Shah & Sons")).toBe(normalizeEntityName("Shah and Sons"));
  });

  it("folds accents", () => {
    expect(normalizeEntityName("Café Supplies")).toBe("cafe supplies");
  });

  it("does not collapse a name made entirely of legal tokens to an empty key", () => {
    // Otherwise "Ltd" and "The Company" would become ONE bogus counterparty.
    expect(normalizeEntityName("Ltd")).toBe("ltd");
    expect(normalizeEntityName("Pvt Ltd")).toBe("pvt ltd");
    expect(normalizeEntityName("Ltd")).not.toBe(normalizeEntityName("Inc"));
  });

  it("returns an empty key only for names with no alphanumeric content", () => {
    expect(normalizeEntityName("")).toBe("");
    expect(normalizeEntityName("   ")).toBe("");
    expect(normalizeEntityName("---")).toBe("");
    expect(normalizeEntityName("!!! ???")).toBe("");
  });

  it("survives non-string input rather than throwing on bad source data", () => {
    expect(normalizeEntityName(null as unknown as string)).toBe("");
    expect(normalizeEntityName(undefined as unknown as string)).toBe("");
    expect(normalizeEntityName(42 as unknown as string)).toBe("");
  });

  it("is idempotent - normalising a normalised name is a no-op", () => {
    for (const n of ["ABC Ltd", "Shah & Sons", "Café Supplies", "A.B.C. Pvt Ltd", "Ltd"]) {
      expect(normalizeEntityName(normalizeEntityName(n))).toBe(normalizeEntityName(n));
    }
  });
});

describe("nameTokens", () => {
  it("returns normalised tokens, empty for unresolvable names", () => {
    expect(nameTokens("ABC Industries Pvt Ltd")).toEqual(["abc", "industries"]);
    expect(nameTokens("   ")).toEqual([]);
  });
});

describe("nameSimilarity", () => {
  it("is 1 for identical token sets and 0 for disjoint ones", () => {
    expect(nameSimilarity("abc", "abc")).toBe(1);
    expect(nameSimilarity("abc", "xyz")).toBe(0);
  });

  it("is symmetric", () => {
    const pairs: Array<[string, string]> = [
      ["abc", "abc industries"],
      ["retail chain a", "retail chain b"],
      ["shah and sons", "shah and daughters"],
    ];
    for (const [a, b] of pairs) {
      expect(nameSimilarity(a, b)).toBe(nameSimilarity(b, a));
    }
  });

  it("scores partial overlap between 0 and 1", () => {
    const s = nameSimilarity("abc", "abc industries");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
    expect(s).toBeCloseTo(0.5, 10);
  });

  it("treats an empty name as similar to nothing, including another empty name", () => {
    expect(nameSimilarity("", "")).toBe(0);
    expect(nameSimilarity("", "abc")).toBe(0);
  });

  it("does not treat one-character typos as similar (token overlap, not edit distance)", () => {
    // Deliberate: "Alpha Traders" and "Alpha Trading" may be different companies,
    // and a wrong merge is unrecoverable. They still share "alpha", so they will
    // surface as a suggestion - just never as an automatic match.
    expect(nameSimilarity("acme", "acmee")).toBe(0);
  });
});
