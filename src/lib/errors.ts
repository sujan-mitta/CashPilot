/**
 * Reading a message off a caught value.
 *
 * `catch` binds `unknown`, because a throw site can throw anything - a string, a
 * Prisma error, an object with no `message` at all. Typing the binding as `any`
 * to reach `.message` silences that instead of handling it, and produces
 * `undefined` in a user-facing error field when something non-standard is
 * thrown.
 *
 * This narrows honestly and always yields a string.
 */
export function errorMessage(error: unknown, fallback = "Unexpected error"): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}
