import { describe, it, expect } from "vitest";
import {
  generateCode,
  hashCode,
  normalizeSubmittedCode,
  evaluateCode,
  outcomeMessage,
  outcomeStatus,
  resendBlockedFor,
  expiryFrom,
  CODE_LENGTH,
  MAX_ATTEMPTS,
  CODE_TTL_MINUTES,
  RESEND_COOLDOWN_SECONDS,
  type StoredCode,
} from "../emailVerification";

/**
 * Proving an address exists before mailing it.
 *
 * `validateEmail` checks shape, and shape is not existence — "sujan@gmial.com"
 * is well formed and undeliverable. Accounts were created on such addresses and
 * every alert bounced back to the sender.
 *
 * A six-digit code is only safe because guessing is bounded. Most of what
 * follows tests the bounds, not the happy path.
 */

const T0 = new Date("2026-09-10T12:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

const stored = (over: Partial<StoredCode> = {}): StoredCode => ({
  codeHash: hashCode("123456"),
  expiresAt: minutes(CODE_TTL_MINUTES),
  usedAt: null,
  attempts: 0,
  ...over,
});

describe("Code generation", () => {
  it("is always exactly six digits", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
    expect(CODE_LENGTH).toBe(6);
  });

  it("keeps leading zeros", () => {
    // Losing them would silently shorten the code, and a four-digit code is a
    // hundred times easier to guess than a six-digit one.
    const padded = Array.from({ length: 4000 }, generateCode).filter((c) => c.startsWith("0"));
    expect(padded.length).toBeGreaterThan(0);
    for (const c of padded) expect(c).toHaveLength(CODE_LENGTH);
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 300 }, generateCode));
    expect(seen.size).toBeGreaterThan(280);
  });

  it("spreads across the range rather than clustering low", () => {
    // `randomBytes % 1000000` is modulo-biased and makes low codes likelier.
    // A uniform generator puts roughly half the codes in the top half.
    const high = Array.from({ length: 2000 }, generateCode).filter((c) => Number(c) >= 500_000);
    expect(high.length).toBeGreaterThan(800);
    expect(high.length).toBeLessThan(1200);
  });
});

describe("The code is never stored", () => {
  it("hashes to something that is not the code", () => {
    const h = hashCode("123456");
    expect(h).not.toContain("123456");
    expect(h).toHaveLength(64);
  });

  it("hashes deterministically, so a correct code still verifies", () => {
    expect(hashCode("000001")).toBe(hashCode("000001"));
    expect(hashCode("000001")).not.toBe(hashCode("000002"));
  });
});

describe("Submitted codes", () => {
  it("accepts the code as typed", () => {
    expect(normalizeSubmittedCode("123456")).toBe("123456");
  });

  it("forgives spacing people paste from an email", () => {
    expect(normalizeSubmittedCode(" 123 456 ")).toBe("123456");
    expect(normalizeSubmittedCode("123-456")).toBe("123456");
  });

  it("refuses anything that is not six digits", () => {
    const bad: unknown[] = ["12345", "1234567", "12345a", "", "abcdef", null, undefined, 123456];
    for (const value of bad) {
      expect(normalizeSubmittedCode(value)).toBeNull();
    }
  });
});

describe("Guessing is bounded", () => {
  it("accepts the right code", () => {
    expect(evaluateCode(stored(), "123456", T0)).toBe("VERIFIED");
  });

  it("rejects a wrong code", () => {
    expect(evaluateCode(stored(), "999999", T0)).toBe("INCORRECT");
  });

  it("refuses once the attempt cap is reached", () => {
    // Without this, six digits are searchable. The cap is what makes a short
    // code acceptable at all.
    expect(evaluateCode(stored({ attempts: MAX_ATTEMPTS }), "999999", T0)).toBe("TOO_MANY_ATTEMPTS");
  });

  it("still refuses the CORRECT code once capped", () => {
    // The cap is on the code, not on wrong answers. An attacker who found it on
    // the last allowed guess must not be let through.
    expect(evaluateCode(stored({ attempts: MAX_ATTEMPTS }), "123456", T0)).toBe("TOO_MANY_ATTEMPTS");
  });

  it("expires", () => {
    expect(evaluateCode(stored(), "123456", minutes(CODE_TTL_MINUTES + 1))).toBe("EXPIRED");
  });

  it("treats the exact expiry instant as expired", () => {
    expect(evaluateCode(stored(), "123456", minutes(CODE_TTL_MINUTES))).toBe("EXPIRED");
  });

  it("checks expiry BEFORE comparing", () => {
    // Order matters: if a dead code were compared first, a caller could keep
    // guessing against it forever and the attempt cap would never bite.
    const expired = stored({ expiresAt: minutes(-1) });
    expect(evaluateCode(expired, "999999", T0)).toBe("EXPIRED");
    expect(evaluateCode(expired, "123456", T0)).toBe("EXPIRED");
  });

  it("never accepts a code twice", () => {
    expect(evaluateCode(stored({ usedAt: T0 }), "123456", T0)).toBe("ALREADY_USED");
  });

  it("reports NO_CODE when nothing was issued", () => {
    expect(evaluateCode(null, "123456", T0)).toBe("NO_CODE");
  });
});

describe("Responses do not leak who has an account", () => {
  it("says the same thing for a wrong code and for no code at all", () => {
    // Differing here would tell an unauthenticated caller which addresses are
    // registered and awaiting verification.
    expect(outcomeMessage("NO_CODE")).toBe(outcomeMessage("INCORRECT"));
    expect(outcomeStatus("NO_CODE")).toBe(outcomeStatus("INCORRECT"));
  });

  it("never puts a code in a message", () => {
    const all = [
      "VERIFIED",
      "NO_CODE",
      "EXPIRED",
      "ALREADY_USED",
      "TOO_MANY_ATTEMPTS",
      "INCORRECT",
    ] as const;
    for (const o of all) {
      expect(outcomeMessage(o)).not.toMatch(/\d{6}/);
      expect(outcomeMessage(o).length).toBeGreaterThan(10);
    }
  });

  it("answers a capped code with 429, and other refusals with 400", () => {
    expect(outcomeStatus("VERIFIED")).toBe(200);
    expect(outcomeStatus("TOO_MANY_ATTEMPTS")).toBe(429);
    expect(outcomeStatus("EXPIRED")).toBe(400);
  });
});

describe("Resend cooldown", () => {
  it("does not block a first send", () => {
    expect(resendBlockedFor(null, T0)).toBe(0);
  });

  it("blocks an immediate resend", () => {
    expect(resendBlockedFor(T0, T0)).toBe(RESEND_COOLDOWN_SECONDS);
  });

  it("clears once the window passes", () => {
    expect(resendBlockedFor(T0, new Date(T0.getTime() + RESEND_COOLDOWN_SECONDS * 1000))).toBe(0);
  });

  it("never reports a negative wait", () => {
    expect(resendBlockedFor(T0, minutes(60))).toBe(0);
  });
});

describe("Expiry window", () => {
  it("is the configured number of minutes ahead", () => {
    expect(expiryFrom(T0).getTime() - T0.getTime()).toBe(CODE_TTL_MINUTES * 60_000);
  });

  it("is short enough to bound guessing and long enough for slow mail", () => {
    expect(CODE_TTL_MINUTES).toBeGreaterThanOrEqual(5);
    expect(CODE_TTL_MINUTES).toBeLessThanOrEqual(30);
  });
});
