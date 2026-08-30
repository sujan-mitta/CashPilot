import { describe, it, expect } from "vitest";
import { secretsMatch } from "../constantTime";

/**
 * The shared-secret comparison used by the cron endpoint.
 *
 * The security property — constant time — cannot be asserted reliably in a unit
 * test; timing on a busy CI runner is noise. What IS worth pinning is the
 * behaviour around absent and mismatched secrets, because that is where a
 * "hardening" change most easily introduces an authentication bypass.
 */

describe("secretsMatch", () => {
  it("accepts an exact match", () => {
    expect(secretsMatch("s3cr3t-value", "s3cr3t-value")).toBe(true);
  });

  it("rejects a different secret of the same length", () => {
    expect(secretsMatch("s3cr3t-value", "s3cr3t-valu3")).toBe(false);
  });

  it("rejects a prefix, so a partial guess is not a match", () => {
    expect(secretsMatch("s3cr3t", "s3cr3t-value")).toBe(false);
    expect(secretsMatch("s3cr3t-value", "s3cr3t")).toBe(false);
  });

  it("rejects when either side is absent", () => {
    expect(secretsMatch(null, "s3cr3t")).toBe(false);
    expect(secretsMatch("s3cr3t", null)).toBe(false);
    expect(secretsMatch(undefined, "s3cr3t")).toBe(false);
    expect(secretsMatch("s3cr3t", undefined)).toBe(false);
  });

  it("rejects when BOTH sides are absent", () => {
    // The bypass this guards: an unconfigured CRON_SECRET must not authorise a
    // request that also supplied no secret. Two absent values are not a match.
    expect(secretsMatch(null, null)).toBe(false);
    expect(secretsMatch(undefined, undefined)).toBe(false);
    expect(secretsMatch("", "")).toBe(false);
  });

  it("rejects an empty string against a real secret", () => {
    expect(secretsMatch("", "s3cr3t")).toBe(false);
    expect(secretsMatch("s3cr3t", "")).toBe(false);
  });

  it("does not throw on wildly different lengths", () => {
    // timingSafeEqual throws on unequal buffer lengths; hashing both sides to a
    // fixed width is what keeps this a comparison rather than a crash — and a
    // thrown 500 here would be an availability bug in the cron path.
    expect(() => secretsMatch("a", "b".repeat(10_000))).not.toThrow();
    expect(secretsMatch("a", "b".repeat(10_000))).toBe(false);
  });

  it("is byte-exact, not normalised", () => {
    // No trimming, no case folding: a secret that only matches after cleanup is
    // not the secret.
    expect(secretsMatch("Secret", "secret")).toBe(false);
    expect(secretsMatch(" secret", "secret")).toBe(false);
    expect(secretsMatch("secret\n", "secret")).toBe(false);
  });

  it("handles non-ASCII without mangling it", () => {
    expect(secretsMatch("паро́ль-✓", "паро́ль-✓")).toBe(true);
    expect(secretsMatch("паро́ль-✓", "パスワード-✓")).toBe(false);
  });
});
