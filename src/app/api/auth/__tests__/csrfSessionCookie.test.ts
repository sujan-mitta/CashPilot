import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TRANCHE 23 — CSRF / session-cookie configuration guard.
 *
 * CashPilot's CSRF protection is architectural, not token-based, and this test
 * pins the two properties that provide it:
 *
 *   1. The session cookie is SameSite=Strict. A browser never attaches a
 *      Strict cookie to a cross-site request, so an attacker's cross-site POST
 *      carries no session and is rejected as unauthenticated. This removes the
 *      need for CSRF tokens.
 *   2. Every state-changing route is POST (never a GET that mutates), so a
 *      cross-site <img>/<a> GET cannot trigger a financial action.
 *
 * The cookie is also HttpOnly (no JS theft) and Secure in production. If a
 * future change weakens any of these, this test fails - which is the point.
 */

const API = join(process.cwd(), "src", "app", "api");
const read = (p: string) => readFileSync(join(API, p), "utf8");

// Every route that sets the authenticated session cookie.
const SESSION_COOKIE_ROUTES = [
  "auth/login/route.ts",
  "auth/signup/route.ts",
  "auth/switch/route.ts",
  "auth/google/callback/route.ts",
];

describe("session cookie is CSRF-safe by configuration", () => {
  for (const route of SESSION_COOKIE_ROUTES) {
    it(`${route} sets the session cookie SameSite=Strict, HttpOnly, Secure-in-prod`, () => {
      const src = read(route);
      // Find the cashpilot_session cookie set-block.
      const idx = src.indexOf("cashpilot_session");
      expect(idx, `${route}: does not set cashpilot_session`).toBeGreaterThan(-1);
      const block = src.slice(idx, idx + 400);
      expect(block, `${route}: session cookie not SameSite=Strict`).toMatch(/sameSite:\s*["']strict["']/);
      expect(block, `${route}: session cookie not HttpOnly`).toMatch(/httpOnly:\s*true/);
      expect(block, `${route}: Secure flag not gated on production`).toMatch(/secure:\s*process\.env\.NODE_ENV\s*===\s*["']production["']/);
    });
  }

  it("the OAuth STATE cookie is SameSite=Lax (must survive Google's cross-site redirect) but still HttpOnly", () => {
    // The state cookie is the one deliberate exception - a Strict cookie would
    // not return on the top-level redirect back from Google and every sign-in
    // would fail. It carries only a CSRF nonce, never a session.
    const src = read("auth/google/start/route.ts");
    expect(src).toMatch(/sameSite:\s*["']lax["']/);
    expect(src).toMatch(/httpOnly:\s*true/);
    expect(src).not.toContain("cashpilot_session"); // it is NOT the session cookie
  });
});

describe("no state-changing route mutates on GET", () => {
  const MUTATING = ["execute/route.ts", "approve/route.ts", "auth/switch/route.ts", "auth/logout/route.ts"];
  for (const route of MUTATING) {
    it(`${route} exposes no GET handler`, () => {
      const src = read(route);
      expect(src, `${route} exports a GET handler`).not.toMatch(/export\s+(async\s+function|const)\s+GET\b/);
    });
  }
});
