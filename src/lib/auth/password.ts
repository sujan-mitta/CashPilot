import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * ===========================================================================
 * PASSWORD HASHING  (scrypt)
 * ===========================================================================
 *
 * Before this, /api/auth/login never read the password field at all - it
 * authenticated on email + business name alone, so anyone who knew those two
 * public strings got a full session. Verified live against production. Every
 * stored password was the literal placeholder "mock-password-hash".
 *
 * scrypt is used rather than bcrypt because it is in Node's standard library:
 * native bcrypt needs a compile step that is fragile on Vercel's serverless
 * build, and a password check that fails to deploy is a password check that
 * isn't there. scrypt is a memory-hard KDF and an accepted choice for this.
 *
 * Format stored in User.password:  scrypt$N$r$p$<saltB64>$<hashB64>
 * The parameters travel with the hash so they can be raised later without
 * invalidating existing credentials.
 */

// promisify picks the 3-arg overload; wrap so options are typed through.
const scryptAsync = (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, options, (err, dk) => (err ? reject(err) : resolve(dk)))
  );

// OWASP-aligned scrypt parameters (N=2^16). Tunable without a migration
// because they are encoded into every stored hash.
const N = 1 << 16;
const r = 8;
const p = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

const PREFIX = "scrypt";

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scryptAsync(password, salt, KEYLEN, { N, r, p, maxmem: 128 * N * r * 2 })) as Buffer;
  return [PREFIX, N, r, p, salt.toString("base64"), derived.toString("base64")].join("$");
}

/**
 * Constant-time verification. Returns false for anything it cannot parse -
 * including the old "mock-password-hash" placeholder, which is exactly the
 * behaviour we want: a placeholder account can no longer be logged into with
 * an arbitrary password.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (typeof password !== "string" || typeof stored !== "string") return false;
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== PREFIX) return false;

    const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const derived = (await scryptAsync(password, salt, expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr),
      maxmem: 128 * Number(nStr) * Number(rStr) * 2,
    })) as Buffer;

    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True for a legacy row that predates real hashing. */
export function isPlaceholderHash(stored: string | null | undefined): boolean {
  return !stored || !stored.startsWith(`${PREFIX}$`);
}
