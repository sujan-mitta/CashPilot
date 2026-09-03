import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/**
 * Encryption for credentials belonging to someone else.
 *
 * WHAT THIS PROTECTS
 *
 * A merchant's Razorpay key secret and webhook secret are not our data. They
 * authorise moving that merchant's money, and we are only holding them. Stored
 * in plaintext, a database dump — a backup on a laptop, a misconfigured
 * snapshot, a support export — hands an attacker the ability to issue payment
 * links on somebody else's account.
 *
 * WHY THE KEY IS NOT IN THE DATABASE
 *
 * The entire point is that stealing the database is not enough. A key stored
 * beside the ciphertext is decoration. It comes from the environment, so a dump
 * on its own is inert.
 *
 * AES-256-GCM, chosen for authentication as much as secrecy: GCM fails loudly
 * if the ciphertext was altered, so a tampered row cannot silently decrypt to
 * something else. A fresh random IV per encryption, never reused — reusing an
 * IV with the same key in GCM is catastrophic, not merely weak.
 *
 * FAILS CLOSED, ALWAYS
 *
 * No key configured means encrypt() throws rather than storing plaintext, and
 * decrypt() throws rather than returning something unusable. Refusing to hold a
 * merchant's secret is a recoverable inconvenience; holding it unprotected is
 * not.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_ENV = "CREDENTIAL_ENCRYPTION_KEY";

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(
      `${KEY_ENV} is not configured. Credentials cannot be stored without it, ` +
        "and storing them unencrypted is not an option."
    );
    this.name = "MissingEncryptionKeyError";
  }
}

export class DecryptionFailedError extends Error {
  constructor(reason: string) {
    // Deliberately vague to the caller. Distinguishing "wrong key" from
    // "tampered ciphertext" tells an attacker which of the two they achieved.
    super(`Stored credential could not be read: ${reason}`);
    this.name = "DecryptionFailedError";
  }
}

/**
 * The key, derived to exactly 32 bytes.
 *
 * Hashed rather than required to be exactly 32 raw bytes, so an operator can
 * set any sufficiently long random string without hex-encoding it correctly
 * first. The hash is of the raw value, so the same setting always yields the
 * same key.
 */
function encryptionKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw || raw.trim().length < 32) {
    // A short key is not a key. Refused rather than stretched, because
    // stretching a weak secret produces a weak key that looks strong.
    throw new MissingEncryptionKeyError();
  }
  return createHash("sha256").update(raw.trim(), "utf8").digest();
}

/** Whether credentials can be stored at all. Lets callers refuse early. */
export function encryptionAvailable(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a secret for storage.
 *
 * Returns a single self-describing string: version, IV, auth tag and
 * ciphertext. Packed together because they must travel together — an auth tag
 * stored in a separate column WILL eventually be separated from its ciphertext
 * by a migration or a backfill, and then nothing decrypts.
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("Refusing to encrypt an empty value.");
  }

  const key = encryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // v1 prefix so a future scheme change can be told apart from this one rather
  // than guessed at.
  return ["v1", iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(
    ":"
  );
}

export function decryptSecret(packed: string): string {
  const parts = typeof packed === "string" ? packed.split(":") : [];
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new DecryptionFailedError("unrecognised format");
  }

  const key = encryptionKey();

  try {
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const ciphertext = Buffer.from(parts[3], "base64");

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    // GCM verifies the tag during final(). A tampered ciphertext throws here
    // rather than returning plausible-looking rubbish.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptionFailedError("wrong key or altered data");
  }
}

/**
 * A stable, non-reversible identifier for a secret.
 *
 * Lets two credentials be compared, or a rotation detected, without ever
 * decrypting or displaying anything. Twelve hex characters is far too little to
 * attack and enough that a collision is not a practical concern here.
 */
export function secretFingerprint(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex").slice(0, 12);
}
