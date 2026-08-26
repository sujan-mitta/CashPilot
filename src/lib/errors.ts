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

import { NextResponse } from "next/server";

/**
 * Parses a JSON request body, distinguishing "malformed input" (the client's
 * fault) from a genuine server error.
 *
 * A bare `await req.json()` throws a SyntaxError on malformed input, which then
 * falls into a route's catch-all and returns 500 - telling the client the
 * server broke when the client sent garbage. This returns a typed result so the
 * caller can answer 400 instead. It never exposes the parser's internal error
 * text.
 */
export async function parseJsonBody<T = unknown>(
  req: Request
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  try {
    const data = (await req.json()) as T;
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }),
    };
  }
}
