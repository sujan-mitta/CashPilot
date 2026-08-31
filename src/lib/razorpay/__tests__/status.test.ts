import { describe, it, expect } from "vitest";
import { describeRazorpayIntegration } from "../status";

/**
 * Telling someone whether Razorpay will actually work, before they choose it.
 *
 * The onboarding fork offers "start with Razorpay" as a real path, so it has to
 * know whether recovery links can reach a payer. Offering the option against an
 * unconfigured provider would be a promise the product cannot keep, discovered
 * at the moment of execution instead of at the moment of choosing.
 */

const TEST_KEY = "rzp_test_abc123";
const LIVE_KEY = "rzp_live_abc123";
const SECRET = "some-secret-value";

describe("Mode is read from the key prefix", () => {
  it("reports TEST for a test key", () => {
    const s = describeRazorpayIntegration(TEST_KEY, SECRET);
    expect(s.mode).toBe("TEST");
    expect(s.connected).toBe(true);
    expect(s.handlesRealMoney).toBe(false);
  });

  it("reports LIVE for a live key, and says real money moves", () => {
    const s = describeRazorpayIntegration(LIVE_KEY, SECRET);
    expect(s.mode).toBe("LIVE");
    expect(s.connected).toBe(true);
    expect(s.handlesRealMoney).toBe(true);
    expect(s.detail).toMatch(/real money/i);
  });

  it("refuses to guess at an unrecognised key", () => {
    // Claiming TEST for a key we cannot classify is the one error here that
    // could move real money by accident, so an unknown prefix is treated as
    // unconfigured rather than assumed safe.
    const s = describeRazorpayIntegration("something_else_abc", SECRET);
    expect(s.mode).toBe("NOT_CONFIGURED");
    expect(s.connected).toBe(false);
    expect(s.handlesRealMoney).toBe(false);
  });
});

describe("Absent and placeholder credentials", () => {
  it("reports NOT_CONFIGURED when either half is missing", () => {
    expect(describeRazorpayIntegration(undefined, SECRET).mode).toBe("NOT_CONFIGURED");
    expect(describeRazorpayIntegration(TEST_KEY, undefined).mode).toBe("NOT_CONFIGURED");
    expect(describeRazorpayIntegration(undefined, undefined).mode).toBe("NOT_CONFIGURED");
  });

  it("treats the shipped placeholders as absent", () => {
    // The repo ships placeholder values so a checkout runs without secrets.
    // Counting those as configured would report a working integration to
    // someone who has set nothing up.
    expect(describeRazorpayIntegration("rzp_test_placeholder", SECRET).mode).toBe("NOT_CONFIGURED");
    expect(describeRazorpayIntegration(TEST_KEY, "placeholder_secret").mode).toBe("NOT_CONFIGURED");
  });

  it("never claims real-money capability when unconfigured", () => {
    for (const [k, v] of [
      [undefined, undefined],
      ["rzp_test_placeholder", SECRET],
      ["unknown_prefix", SECRET],
    ] as const) {
      expect(describeRazorpayIntegration(k, v).handlesRealMoney).toBe(false);
    }
  });
});

describe("It never leaks the credentials it was given", () => {
  it("keeps the key and secret out of everything it returns", () => {
    // Mode answers the only question onboarding is asking. A masked key would
    // answer it too, while creating a value that gets logged, screenshotted and
    // pasted into issue trackers.
    for (const key of [TEST_KEY, LIVE_KEY]) {
      const serialized = JSON.stringify(describeRazorpayIntegration(key, SECRET));
      expect(serialized).not.toContain(key);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain("abc123");
    }
  });
});

describe("Every outcome is explained", () => {
  it("carries a sentence safe to render", () => {
    for (const [k, v] of [
      [TEST_KEY, SECRET],
      [LIVE_KEY, SECRET],
      [undefined, undefined],
      ["unknown_prefix", SECRET],
    ] as const) {
      const s = describeRazorpayIntegration(k, v);
      expect(s.detail.length).toBeGreaterThan(30);
    }
  });
});
