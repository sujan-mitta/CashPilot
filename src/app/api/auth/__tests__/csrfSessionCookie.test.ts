import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

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
//
// Signup is deliberately NOT here any more: it creates the account but issues
// no session, because nobody has yet shown they can read the address on it.
// The session for a new account is set by auth/verify/confirm, once a code
// mailed to that address is returned. A hand-maintained list like this goes
// stale silently, so "the list is complete" is asserted below rather than
// assumed.
const SESSION_COOKIE_ROUTES = [
  "auth/login/route.ts",
  "auth/verify/confirm/route.ts",
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

describe("the list of session-setting routes is complete", () => {
  it("finds no route that sets a session cookie without being listed", () => {
    // The guard above is only as good as its list. A new route that sets a
    // session and is not listed would be entirely unchecked, which is exactly
    // the kind of gap that appears when an auth flow is restructured — as it
    // was when signup stopped issuing one.
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "route.ts") {
          const src = readFileSync(full, "utf8");
          // "Issues a session" means it writes a SIGNED token into the cookie.
          // Matching the cookie name alone catches logout, which writes an
          // empty value to clear it; matching one call form alone misses the
          // Google callback, which sets it on the response rather than through
          // the cookie store.
          if (src.includes("cashpilot_session") && /signSession\s*\(/.test(src)) {
            found.push(relative(API, full).split(sep).join("/"));
          }
        }
      }
    };
    walk(API);

    expect(found.sort()).toEqual([...SESSION_COOKIE_ROUTES].sort());
  });
});
