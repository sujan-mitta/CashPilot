import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, isPlaceholderHash } from "../password";

/**
 * Login used to ignore the password entirely. These pin the primitive that
 * replaces that: a real, salted, constant-time password check.
 */
describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password entirely", hash)).toBe(false);
  });

  it("salts: the same password hashes differently every time", async () => {
    const a = await hashPassword("same-password-1");
    const b = await hashPassword("same-password-1");
    expect(a).not.toBe(b);
    // ...yet both verify.
    expect(await verifyPassword("same-password-1", a)).toBe(true);
    expect(await verifyPassword("same-password-1", b)).toBe(true);
  });

  it("stores parameters so they can be raised later", async () => {
    const hash = await hashPassword("param-check-123");
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it("refuses to hash a too-short password", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/at least 8/i);
  });

  it("THE DEFECT: the legacy placeholder can never be satisfied", async () => {
    // Every migrated row held this literal. The old login accepted any
    // password against it; verifyPassword must accept none.
    expect(await verifyPassword("anything", "mock-password-hash")).toBe(false);
    expect(await verifyPassword("", "mock-password-hash")).toBe(false);
    expect(isPlaceholderHash("mock-password-hash")).toBe(true);
    expect(isPlaceholderHash(null)).toBe(true);
  });

  it("recognises a real hash as non-placeholder", async () => {
    const hash = await hashPassword("a-real-password-8");
    expect(isPlaceholderHash(hash)).toBe(false);
  });

  it("rejects malformed stored values without throwing", async () => {
    for (const bad of ["", "notscrypt$1$2", "scrypt$only", "$$$$$"]) {
      expect(await verifyPassword("x", bad)).toBe(false);
    }
  });

  it("never leaks the password into the stored hash", async () => {
    const hash = await hashPassword("super-secret-passphrase");
    expect(hash).not.toContain("super-secret-passphrase");
  });
});
