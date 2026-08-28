import { describe, it, expect } from "vitest";
import { resolveCounterpartyName, isAutomaticMatch } from "../resolver";
import { normalizeEntityName } from "../normalize";

function known(id: string, displayName: string) {
  return { id, displayName, normalizedName: normalizeEntityName(displayName) };
}

/** The four cases spec §50-D names explicitly. */
describe("entity resolution (spec §50-D)", () => {
  describe("same customer across sources", () => {
    it("matches a differently-spelled but notationally identical name", () => {
      const abc = known("cp_1", "ABC Ltd");
      const d = resolveCounterpartyName("ABC LIMITED", [abc]);
      expect(d.method).toBe("EXACT");
      expect(d.matchedId).toBe("cp_1");
      expect(d.confidence).toBe(1);
    });

    it("matches through a previously recorded alias", () => {
      const d = resolveCounterpartyName(
        "ABC-IND",
        [known("cp_1", "ABC Ltd")],
        [{ counterpartyId: "cp_1", normalizedName: "abc ind" }]
      );
      expect(d.method).toBe("ALIAS");
      expect(d.matchedId).toBe("cp_1");
    });

    it("prefers the alias over a fuzzy candidate", () => {
      // The alias is recorded knowledge; similarity is a guess. Knowledge wins.
      const d = resolveCounterpartyName(
        "ABC Industries",
        [known("cp_1", "ABC Ltd"), known("cp_2", "ABC Industries Pvt Ltd")],
        [{ counterpartyId: "cp_1", normalizedName: "abc industries" }]
      );
      expect(d.method).toBe("ALIAS");
      expect(d.matchedId).toBe("cp_1");
    });
  });

  describe("different customers with similar names", () => {
    it("never auto-matches a near-miss", () => {
      const d = resolveCounterpartyName("ABC Industries Pvt Ltd", [known("cp_1", "ABC Ltd")]);
      expect(d.method).toBe("CANDIDATE");
      // The whole point: a suggestion carries no id to act on.
      expect(d.matchedId).toBeNull();
      expect(isAutomaticMatch(d.method)).toBe(false);
      expect(d.candidates[0].id).toBe("cp_1");
    });

    it("keeps clearly distinct companies apart entirely", () => {
      const d = resolveCounterpartyName("XYZ Traders", [known("cp_1", "ABC Ltd")]);
      expect(d.method).toBe("NEW");
      expect(d.candidates).toHaveLength(0);
    });

    it("does not match on a shared legal form alone", () => {
      // "Alpha Pvt Ltd" and "Beta Pvt Ltd" share every stripped token and no
      // real one. If legal forms survived normalisation they would look similar.
      const d = resolveCounterpartyName("Beta Pvt Ltd", [known("cp_1", "Alpha Pvt Ltd")]);
      expect(d.method).toBe("NEW");
    });
  });

  describe("ambiguous match", () => {
    it("refuses to pick when two candidates are equally plausible", () => {
      const d = resolveCounterpartyName("Retail Chain C", [
        known("cp_1", "Retail Chain A"),
        known("cp_2", "Retail Chain B"),
      ]);
      expect(d.method).toBe("AMBIGUOUS");
      expect(d.matchedId).toBeNull();
      expect(d.candidates).toHaveLength(2);
      expect(d.confidence).toBe(0);
    });

    it("picks a clear winner as a candidate when one stands out", () => {
      const d = resolveCounterpartyName("Retail Chain A Holdings", [
        known("cp_1", "Retail Chain A"),
        known("cp_2", "Wholesale Chain B"),
      ]);
      expect(d.method).toBe("CANDIDATE");
      expect(d.candidates[0].id).toBe("cp_1");
      expect(d.matchedId).toBeNull();
    });
  });

  describe("incorrect match protection", () => {
    it("returns UNRESOLVABLE rather than inventing an entity for a blank name", () => {
      const d = resolveCounterpartyName("   ", [known("cp_1", "ABC Ltd")]);
      expect(d.method).toBe("UNRESOLVABLE");
      expect(d.matchedId).toBeNull();
      expect(d.normalizedName).toBe("");
    });

    it("two different blank names do not resolve to each other", () => {
      const a = resolveCounterpartyName("---", []);
      const b = resolveCounterpartyName("!!!", []);
      expect(a.method).toBe("UNRESOLVABLE");
      expect(b.method).toBe("UNRESOLVABLE");
    });

    it("only ALIAS and EXACT are ever automatic", () => {
      expect(isAutomaticMatch("ALIAS")).toBe(true);
      expect(isAutomaticMatch("EXACT")).toBe(true);
      for (const m of ["CANDIDATE", "AMBIGUOUS", "NEW", "UNRESOLVABLE"] as const) {
        expect(isAutomaticMatch(m)).toBe(false);
      }
    });

    it("every non-automatic method carries a null matchedId", () => {
      const cases = [
        resolveCounterpartyName("ABC Industries Pvt Ltd", [known("cp_1", "ABC Ltd")]),
        resolveCounterpartyName("Retail Chain C", [
          known("cp_1", "Retail Chain A"),
          known("cp_2", "Retail Chain B"),
        ]),
        resolveCounterpartyName("Totally New Co", [known("cp_1", "ABC Ltd")]),
        resolveCounterpartyName("", [known("cp_1", "ABC Ltd")]),
      ];
      for (const d of cases) {
        if (!isAutomaticMatch(d.method)) expect(d.matchedId).toBeNull();
      }
    });
  });

  describe("determinism", () => {
    it("orders candidates identically regardless of input order", () => {
      const a = known("cp_1", "Retail Chain A");
      const b = known("cp_2", "Retail Chain B");
      const one = resolveCounterpartyName("Retail Chain C", [a, b]);
      const two = resolveCounterpartyName("Retail Chain C", [b, a]);
      expect(one.candidates.map((c) => c.id)).toEqual(two.candidates.map((c) => c.id));
    });

    it("returns the same decision on repeated calls", () => {
      const inputs = [known("cp_1", "ABC Ltd"), known("cp_2", "ABC Industries Pvt Ltd")];
      const first = resolveCounterpartyName("ABC Traders", inputs);
      for (let i = 0; i < 5; i++) {
        expect(resolveCounterpartyName("ABC Traders", inputs)).toEqual(first);
      }
    });
  });

  describe("thresholds are configurable but conservative by default", () => {
    it("a stricter threshold suppresses weak suggestions", () => {
      const d = resolveCounterpartyName("ABC Industries Pvt Ltd", [known("cp_1", "ABC Ltd")], [], {
        candidateThreshold: 0.9,
      });
      expect(d.method).toBe("NEW");
    });

    it("a wider ambiguity margin turns a close call into AMBIGUOUS", () => {
      const d = resolveCounterpartyName(
        "Retail Chain A Holdings",
        [known("cp_1", "Retail Chain A"), known("cp_2", "Retail Chain B Holdings")],
        [],
        { ambiguityMargin: 0.9 }
      );
      expect(d.method).toBe("AMBIGUOUS");
      expect(d.matchedId).toBeNull();
    });
  });
});
