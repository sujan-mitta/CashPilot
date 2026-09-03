import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  encryptionAvailable,
  secretFingerprint,
  MissingEncryptionKeyError,
  DecryptionFailedError,
} from "../secretBox";

/**
 * Holding somebody else's credentials.
 *
 * A merchant's Razorpay secret authorises moving THEIR money. Stored in
 * plaintext, a database dump — a backup on a laptop, a stray snapshot, a
 * support export — hands an attacker the ability to issue payment links on
 * their account.
 *
 * The properties worth testing are mostly the refusals.
 */

const KEY = "a-sufficiently-long-encryption-key-for-tests-0123456789";
const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CREDENTIAL_ENCRYPTION_KEY = saved;
});

describe("A secret survives the round trip", () => {
  it("decrypts back to exactly what went in", () => {
    const secret = "rzp_test_secret_value_123";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("handles unicode and long values", () => {
    for (const s of ["ünïcødé ✓ ₹", "x".repeat(4096), "with:colons:inside"]) {
      expect(decryptSecret(encryptSecret(s))).toBe(s);
    }
  });
});

describe("The ciphertext gives nothing away", () => {
  it("does not contain the plaintext", () => {
    const secret = "rzp_test_secret_value_123";
    expect(encryptSecret(secret)).not.toContain(secret);
    expect(encryptSecret(secret)).not.toContain("secret_value");
  });

  it("differs every time, even for the same input", () => {
    // A fresh IV per encryption. Reusing one with the same key in GCM is
    // catastrophic rather than merely weak, so identical inputs must never
    // produce identical output.
    const s = "same-input";
    const seen = new Set(Array.from({ length: 50 }, () => encryptSecret(s)));
    expect(seen.size).toBe(50);
  });
});

describe("Tampering is detected, not tolerated", () => {
  it("refuses a modified ciphertext", () => {
    // GCM authenticates. Without that, an altered row could silently decrypt to
    // something else entirely.
    const packed = encryptSecret("original");
    const parts = packed.split(":");
    const bytes = Buffer.from(parts[3], "base64");
    bytes[0] = bytes[0] ^ 0xff;
    parts[3] = bytes.toString("base64");

    expect(() => decryptSecret(parts.join(":"))).toThrow(DecryptionFailedError);
  });

  it("refuses a modified auth tag", () => {
    const parts = encryptSecret("original").split(":");
    parts[2] = Buffer.from("0".repeat(16)).toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow(DecryptionFailedError);
  });

  it("refuses anything not in the expected format", () => {
    for (const bad of ["", "plaintext", "v1:only:three", "v2:a:b:c"]) {
      expect(() => decryptSecret(bad)).toThrow(DecryptionFailedError);
    }
  });

  it("refuses to decrypt under a different key", () => {
    const packed = encryptSecret("original");
    process.env.CREDENTIAL_ENCRYPTION_KEY = "a-completely-different-key-of-sufficient-length-9876";
    expect(() => decryptSecret(packed)).toThrow(DecryptionFailedError);
  });

  it("does not reveal WHICH failure occurred", () => {
    // Distinguishing "wrong key" from "tampered data" tells an attacker which
    // of the two they achieved.
    const packed = encryptSecret("original");
    process.env.CREDENTIAL_ENCRYPTION_KEY = "a-completely-different-key-of-sufficient-length-9876";
    let wrongKey = "";
    try {
      decryptSecret(packed);
    } catch (e) {
      wrongKey = (e as Error).message;
    }

    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
    const parts = encryptSecret("original").split(":");
    const bytes = Buffer.from(parts[3], "base64");
    bytes[0] = bytes[0] ^ 0xff;
    parts[3] = bytes.toString("base64");
    let tampered = "";
    try {
      decryptSecret(parts.join(":"));
    } catch (e) {
      tampered = (e as Error).message;
    }

    expect(wrongKey).toBe(tampered);
  });
});

describe("Without a key it fails closed", () => {
  it("refuses to encrypt rather than storing plaintext", () => {
    // Refusing to hold a merchant's secret is a recoverable inconvenience.
    // Holding it unprotected is not.
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptSecret("anything")).toThrow(MissingEncryptionKeyError);
  });

  it("refuses a key too short to be one", () => {
    // Stretching a weak secret produces a weak key that looks strong.
    process.env.CREDENTIAL_ENCRYPTION_KEY = "short";
    expect(() => encryptSecret("anything")).toThrow(MissingEncryptionKeyError);
    expect(encryptionAvailable()).toBe(false);
  });

  it("reports availability so callers can refuse early", () => {
    expect(encryptionAvailable()).toBe(true);
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(encryptionAvailable()).toBe(false);
  });

  it("refuses to encrypt an empty value", () => {
    expect(() => encryptSecret("")).toThrow();
  });
});

describe("Fingerprints compare without revealing", () => {
  it("is stable for the same secret and different for others", () => {
    expect(secretFingerprint("abc")).toBe(secretFingerprint("abc"));
    expect(secretFingerprint("abc")).not.toBe(secretFingerprint("abd"));
  });

  it("never contains the secret", () => {
    expect(secretFingerprint("rzp_test_xyz")).not.toContain("rzp_test_xyz");
    expect(secretFingerprint("rzp_test_xyz")).toMatch(/^[0-9a-f]{12}$/);
  });
});
