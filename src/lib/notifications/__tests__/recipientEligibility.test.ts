import { describe, it, expect } from "vitest";
import { evaluateRecipient } from "../recipientEligibility";

/**
 * Not sending to addresses that do not exist.
 *
 * The dispatcher sent to `user.email` unconditionally. A non-existent address
 * bounces, and the bounce goes to the SENDER — so the operator's own inbox
 * filled with "recipient does not exist" from their own product, once per alert
 * cycle, while the alert itself was read by nobody.
 */

const verified = new Date("2026-09-01T00:00:00.000Z");

describe("Only a proven address is mailed", () => {
  it("sends to a verified address", () => {
    const r = evaluateRecipient({ email: "sujan@example.com", emailVerified: verified });
    expect(r.sendable).toBe(true);
    expect(r.decision).toBe("SENDABLE");
    expect(r.reason).toBeNull();
  });

  it("does not send to an unverified address", () => {
    // This is the bounce. The address may well be fine — but nobody has shown
    // it can receive mail, and finding out by sending costs a bounce every time.
    const r = evaluateRecipient({ email: "sujan@gmial.com", emailVerified: null });
    expect(r.sendable).toBe(false);
    expect(r.decision).toBe("UNVERIFIED");
  });

  it("does not send when there is no address", () => {
    expect(evaluateRecipient({ email: null }).decision).toBe("MISSING");
    expect(evaluateRecipient({ email: "   ", emailVerified: verified }).decision).toBe("MISSING");
  });

  it("does not send to a malformed address even if flagged verified", () => {
    // A verified flag against a string that is not an address means the data is
    // wrong, not that the address works.
    const r = evaluateRecipient({ email: "not-an-address", emailVerified: verified });
    expect(r.sendable).toBe(false);
    expect(r.decision).toBe("MALFORMED");
  });

  it("accepts an ISO timestamp as proof, not just a Date", () => {
    expect(evaluateRecipient({ email: "a@b.com", emailVerified: verified.toISOString() }).sendable).toBe(
      true
    );
  });
});

describe("Every refusal explains itself", () => {
  it("gives a reason worth recording for each one", () => {
    const cases = [
      { email: null },
      { email: "bad", emailVerified: verified },
      { email: "a@b.com", emailVerified: null },
    ];
    for (const c of cases) {
      const r = evaluateRecipient(c);
      expect(r.sendable).toBe(false);
      expect(r.reason ?? "").toMatch(/in-app/i);
      expect((r.reason ?? "").length).toBeGreaterThan(30);
    }
  });

  it("says the alert is still recorded, not dropped", () => {
    // Suppressing the EMAIL must not read as suppressing the crisis. The
    // dashboard still shows it.
    const r = evaluateRecipient({ email: "a@b.com", emailVerified: null });
    expect(r.reason).toMatch(/recorded in-app/i);
  });
});
