/**
 * ===========================================================================
 * REGISTRATION AND SIGN-IN INPUT
 * ===========================================================================
 *
 * The signup route checked only that the fields were truthy. So
 * `email: "notanemail"` was accepted and stored on a unique column, and name /
 * businessName had no length bound at all - an unbounded string straight into
 * the database, and into every prompt and page that later renders it.
 *
 * The client checked `email.includes("@")` and nothing else, which is not a
 * validation boundary: it runs on the attacker's machine.
 */

export const MAX_NAME_LENGTH = 120;
export const MAX_BUSINESS_NAME_LENGTH = 160;
export const MAX_EMAIL_LENGTH = 254; // RFC 5321 practical maximum.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 512; // scrypt cost is bounded by input size.

/**
 * Deliberately permissive, and deliberately not RFC 5322.
 *
 * A regex cannot decide whether an address is real; the only proof is delivery.
 * This rejects the shapes that are certainly not addresses - no @, no domain
 * dot, whitespace, multiple @ - and lets everything else through rather than
 * turning away a legitimate but unusual address.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export type FieldError = { field: string; message: string };

export function validateEmail(raw: unknown): FieldError | null {
  if (typeof raw !== "string") return { field: "email", message: "Email is required." };
  const email = raw.trim();
  if (email.length === 0) return { field: "email", message: "Email is required." };
  if (email.length > MAX_EMAIL_LENGTH) {
    return { field: "email", message: "That email address is too long." };
  }
  if (!EMAIL_SHAPE.test(email)) {
    return { field: "email", message: "Enter a valid email address." };
  }
  return null;
}

export function validateDisplayName(raw: unknown, field: string, max: number): FieldError | null {
  if (typeof raw !== "string") return { field, message: `${field} is required.` };
  const value = raw.trim();
  if (value.length === 0) return { field, message: `${field} is required.` };
  if (value.length > max) {
    return { field, message: `That ${field.toLowerCase()} is too long (max ${max} characters).` };
  }
  return null;
}

export function validatePassword(raw: unknown): FieldError | null {
  if (typeof raw !== "string") return { field: "password", message: "Password is required." };
  if (raw.length < MIN_PASSWORD_LENGTH) {
    return {
      field: "password",
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (raw.length > MAX_PASSWORD_LENGTH) {
    // Not a strength rule: an unbounded input into a memory-hard KDF is a
    // cheap way to burn server CPU.
    return {
      field: "password",
      message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }
  return null;
}

/** Normalises an email for storage and lookup. Storage is always lowercase. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Normalises a business name for COMPARISON only - never for storage.
 *
 * Sign-in matched the business name with an exact, case-sensitive equality, so
 * "abc electronics" failed against a stored "ABC Electronics" and the operator
 * was told "Invalid email or password" - sending them to hunt for a password
 * problem they did not have. The stored value keeps the user\'s own casing.
 */
export function normalizeBusinessNameForComparison(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}
