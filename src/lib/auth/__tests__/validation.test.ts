import { describe, it, expect } from "vitest";
import {
  validateEmail,
  validateDisplayName,
  validatePassword,
  normalizeEmail,
  normalizeBusinessNameForComparison,
  MAX_NAME_LENGTH,
  MAX_BUSINESS_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
} from "../validation";

/**
 * REGISTRATION INPUT
 *
 * The signup route checked only that the fields were truthy, so "notanemail"
 * was stored on a unique column and name/businessName had no length bound at
 * all. The client's `email.includes("@")` is not a boundary - it runs on the
 * caller's machine.
 */
describe("validateEmail", () => {
  it("accepts ordinary addresses", () => {
    for (const email of [
      "a@b.co",
      "first.last@example.com",
      "user+tag@sub.domain.co.in",
      "UPPER@EXAMPLE.COM",
      "name_with_underscore@example.org",
    ]) {
      expect(validateEmail(email)).toBeNull();
    }
  });

  it("THE BUG: rejects a string with no @ at all, which used to be stored", () => {
    expect(validateEmail("notanemail")).toMatchObject({ field: "email" });
  });

  it("rejects a missing domain dot — the shape that is certainly not routable", () => {
    expect(validateEmail("user@localhost")).not.toBeNull();
  });

  it("rejects whitespace inside the address", () => {
    expect(validateEmail("us er@example.com")).not.toBeNull();
    expect(validateEmail("user@exa mple.com")).not.toBeNull();
  });

  it("rejects two @ signs", () => {
    expect(validateEmail("a@b@example.com")).not.toBeNull();
  });

  it("rejects an empty or whitespace-only value", () => {
    expect(validateEmail("")).not.toBeNull();
    expect(validateEmail("   ")).not.toBeNull();
  });

  it("rejects a non-string", () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(validateEmail(value)).not.toBeNull();
    }
  });

  it("accepts exactly the maximum length and rejects one character more", () => {
    const local = "a".repeat(MAX_EMAIL_LENGTH - "@example.com".length);
    expect(validateEmail(`${local}@example.com`)).toBeNull();
    expect(validateEmail(`${local}x@example.com`)).not.toBeNull();
  });

  it("tolerates surrounding whitespace, because a paste usually carries it", () => {
    expect(validateEmail("  user@example.com  ")).toBeNull();
  });
});

describe("validateDisplayName", () => {
  it("accepts a normal name", () => {
    expect(validateDisplayName("Priya Raghavan", "Name", MAX_NAME_LENGTH)).toBeNull();
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(validateDisplayName("", "Name", MAX_NAME_LENGTH)).not.toBeNull();
    expect(validateDisplayName("   ", "Name", MAX_NAME_LENGTH)).not.toBeNull();
  });

  it("THE BUG: rejects an unbounded string instead of writing it to the database", () => {
    expect(validateDisplayName("x".repeat(100_000), "Name", MAX_NAME_LENGTH)).not.toBeNull();
  });

  it("accepts exactly the limit and rejects one over", () => {
    expect(validateDisplayName("x".repeat(MAX_NAME_LENGTH), "Name", MAX_NAME_LENGTH)).toBeNull();
    expect(validateDisplayName("x".repeat(MAX_NAME_LENGTH + 1), "Name", MAX_NAME_LENGTH)).not.toBeNull();
  });

  it("applies the business-name limit independently", () => {
    const value = "x".repeat(MAX_BUSINESS_NAME_LENGTH);
    expect(validateDisplayName(value, "Business name", MAX_BUSINESS_NAME_LENGTH)).toBeNull();
  });

  it("names the field it rejected, so the form can point at it", () => {
    expect(validateDisplayName("", "Business name", MAX_BUSINESS_NAME_LENGTH)).toMatchObject({
      field: "Business name",
    });
  });
});

describe("validatePassword", () => {
  it("rejects anything under 8 characters", () => {
    expect(validatePassword("short12")).not.toBeNull();
    expect(validatePassword("")).not.toBeNull();
  });

  it("accepts exactly 8", () => {
    expect(validatePassword("12345678")).toBeNull();
  });

  it("caps the maximum, so an unbounded input cannot burn CPU in the KDF", () => {
    // scrypt is memory-hard by design. An unbounded input is a free way to
    // make the server do arbitrary work per request.
    expect(validatePassword("x".repeat(MAX_PASSWORD_LENGTH))).toBeNull();
    expect(validatePassword("x".repeat(MAX_PASSWORD_LENGTH + 1))).not.toBeNull();
  });

  it("does NOT trim — leading and trailing spaces are part of a password", () => {
    expect(validatePassword("        ")).toBeNull();
  });

  it("rejects a non-string", () => {
    for (const value of [null, undefined, 12345678, {}]) {
      expect(validatePassword(value)).not.toBeNull();
    }
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims, so one address cannot register twice", () => {
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
  });
});

describe("normalizeBusinessNameForComparison", () => {
  it("THE BUG: makes sign-in case-insensitive", () => {
    // An exact match meant "abc electronics" failed against a stored
    // "ABC Electronics", and the operator was told "Invalid email or password"
    // - sending them to hunt for a password problem they did not have.
    expect(normalizeBusinessNameForComparison("ABC Electronics")).toBe(
      normalizeBusinessNameForComparison("abc electronics")
    );
  });

  it("collapses runs of internal whitespace", () => {
    expect(normalizeBusinessNameForComparison("ABC   Electronics")).toBe("abc electronics");
    expect(normalizeBusinessNameForComparison("  ABC\tElectronics  ")).toBe("abc electronics");
  });

  it("keeps genuinely different names apart", () => {
    expect(normalizeBusinessNameForComparison("ABC Electronics")).not.toBe(
      normalizeBusinessNameForComparison("ABC Electricals")
    );
  });
});
