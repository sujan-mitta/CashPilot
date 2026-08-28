import { describe, it, expect } from "vitest";
import {
  sourceAuthority,
  isAuthoritativeFor,
  authoritativeSources,
  questionForClaimType,
  type FinancialQuestion,
} from "../precedence";

const QUESTIONS: FinancialQuestion[] = [
  "MONEY_ARRIVED",
  "OBLIGATION_EXISTS",
  "COUNTERPARTY_STATED",
  "LIKELY_TIMING",
];

const SOURCES = ["BANK", "RAZORPAY", "ERP", "INVOICE", "USER", "EMAIL", "HISTORICAL"];

describe("source precedence is claim-specific, not a universal hierarchy (spec §16)", () => {
  it("inverts the bank and the ERP between the two questions they each own", () => {
    // This single assertion is the whole point of the module. Any universal
    // ranking - "BANK > ERP > EMAIL > MODEL" - must fail one of these two lines.
    expect(sourceAuthority("MONEY_ARRIVED", "BANK")).toBeGreaterThan(
      sourceAuthority("MONEY_ARRIVED", "ERP")
    );
    expect(sourceAuthority("OBLIGATION_EXISTS", "ERP")).toBeGreaterThan(
      sourceAuthority("OBLIGATION_EXISTS", "BANK")
    );
  });

  it("makes email the top authority on what a counterparty said, above the bank", () => {
    // No amount of bank reliability makes it a witness to a conversation.
    expect(sourceAuthority("COUNTERPARTY_STATED", "EMAIL")).toBeGreaterThan(
      sourceAuthority("COUNTERPARTY_STATED", "BANK")
    );
    expect(isAuthoritativeFor("COUNTERPARTY_STATED", "EMAIL")).toBe(true);
    expect(isAuthoritativeFor("COUNTERPARTY_STATED", "BANK")).toBe(false);
  });

  it("ranks the historical model above the bank for future timing", () => {
    expect(sourceAuthority("LIKELY_TIMING", "HISTORICAL")).toBeGreaterThan(
      sourceAuthority("LIKELY_TIMING", "BANK")
    );
  });

  it("has no single source that wins every question", () => {
    for (const source of SOURCES) {
      const winsAll = QUESTIONS.every((q) =>
        SOURCES.every((other) => sourceAuthority(q, source) >= sourceAuthority(q, other))
      );
      expect(winsAll, `${source} dominates every question - that is a universal hierarchy`).toBe(
        false
      );
    }
  });

  it("treats no source as able to settle the future", () => {
    // Spec §12: a reliable source does not make a prediction reliable.
    expect(authoritativeSources("LIKELY_TIMING")).toEqual([]);
  });

  it("names the expected settlers for the knowable questions", () => {
    expect(authoritativeSources("MONEY_ARRIVED")).toEqual(["BANK", "RAZORPAY"]);
    expect(authoritativeSources("OBLIGATION_EXISTS")).toEqual(["ERP", "INVOICE"]);
    expect(authoritativeSources("COUNTERPARTY_STATED")).toEqual(["EMAIL", "USER"]);
  });
});

describe("sourceAuthority", () => {
  it("returns a weight in [0,1] for every known pairing", () => {
    for (const q of QUESTIONS) {
      for (const s of SOURCES) {
        const w = sourceAuthority(q, s);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is case-insensitive on the source name", () => {
    expect(sourceAuthority("MONEY_ARRIVED", "bank")).toBe(sourceAuthority("MONEY_ARRIVED", "BANK"));
  });

  it("treats an unrecognised source as weak rather than credible", () => {
    const unknown = sourceAuthority("MONEY_ARRIVED", "SOME_NEW_CONNECTOR");
    expect(unknown).toBeLessThan(sourceAuthority("MONEY_ARRIVED", "EMAIL"));
    expect(isAuthoritativeFor("MONEY_ARRIVED", "SOME_NEW_CONNECTOR")).toBe(false);
  });
});

describe("questionForClaimType", () => {
  it("routes each claim type to the question it actually answers", () => {
    expect(questionForClaimType("ACTUAL")).toBe("MONEY_ARRIVED");
    expect(questionForClaimType("RECONCILED")).toBe("MONEY_ARRIVED");
    expect(questionForClaimType("CONTRACTUAL")).toBe("OBLIGATION_EXISTS");
    expect(questionForClaimType("CONFIRMED")).toBe("COUNTERPARTY_STATED");
    expect(questionForClaimType("PREDICTED")).toBe("LIKELY_TIMING");
    expect(questionForClaimType("EXPECTED")).toBe("LIKELY_TIMING");
    expect(questionForClaimType("UNCERTAIN")).toBe("LIKELY_TIMING");
  });
});
