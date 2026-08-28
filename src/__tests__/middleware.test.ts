import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware, config } from "../middleware";

/**
 * ROUTE PROTECTION
 *
 * There was no middleware at all. Every page was a client component whose only
 * gate was `localStorage.getItem("cashpilot_user")`, which meant:
 *
 *   - the whole app shell rendered for a signed-out visitor before the client
 *     bounced them, so the first thing anyone saw was a flash of a financial
 *     dashboard that was not theirs;
 *   - setting that key in a console passed the gate, and the visitor then sat
 *     inside the app watching every request 401;
 *   - when the cookie lapsed while localStorage persisted, the UI still
 *     believed the operator was signed in.
 *
 * This checks the SESSION COOKIE - the thing that actually authenticates. It
 * deliberately does not verify the signature (the Edge runtime has no Prisma);
 * a forged cookie gets past here only to be rejected by getSession() on the
 * first API call, which is and remains the real boundary.
 */

const request = (path: string, opts: { session?: string } = {}) => {
  const req = new NextRequest(new URL(`http://localhost${path}`));
  if (opts.session) req.cookies.set("cashpilot_session", opts.session);
  return req;
};

const PROTECTED = [
  "/dashboard",
  "/investigation",
  "/strategies",
  "/approval",
  "/execution",
  "/history",
  "/profile",
];

describe("signed-out visitors", () => {
  it("are redirected away from every protected page", () => {
    for (const path of PROTECTED) {
      const res = middleware(request(path));
      expect(res.status, path).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname, path).toBe("/login");
    }
  });

  it("are redirected from nested paths too", () => {
    const res = middleware(request("/approval/some/deep/path"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("carry where they were going, so sign-in can return them there", () => {
    const res = middleware(request("/approval?strategyId=strat-1"));
    const url = new URL(res.headers.get("location")!);
    expect(url.searchParams.get("next")).toBe("/approval?strategyId=strat-1");
  });

  it("the `next` value is always a same-origin PATH, never an absolute URL", () => {
    // Anything else would make this an open redirect.
    const res = middleware(request("/history?tab=all"));
    const next = new URL(res.headers.get("location")!).searchParams.get("next")!;
    expect(next.startsWith("/")).toBe(true);
    expect(next).not.toMatch(/^https?:|^\/\//);
  });

  it("reach /login without being bounced", () => {
    expect(middleware(request("/login")).status).toBe(200);
  });

  it("an EMPTY cookie value counts as signed out", () => {
    // This is exactly what /api/auth/logout writes.
    const res = middleware(request("/dashboard", { session: "" }));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});

describe("signed-in visitors", () => {
  it("pass through to every protected page", () => {
    for (const path of PROTECTED) {
      expect(middleware(request(path, { session: "signed.token" })).status, path).toBe(200);
    }
  });

  it("are sent to the dashboard if they open /login again", () => {
    const res = middleware(request("/login", { session: "signed.token" }));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
  });

  it("a cookie present but not verifiable here still passes — the API is the real gate", () => {
    // Documenting the boundary on purpose: this removes the flash and the
    // impossible states; it is not an authorisation check.
    expect(middleware(request("/dashboard", { session: "obviously-forged" })).status).toBe(200);
  });
});

/**
 * Next.js anchors a matcher pattern against the WHOLE pathname, so the test
 * has to as well - an unanchored regex matches "/api/forecast" via its own
 * "/..." suffix and would report the opposite of the truth.
 */
const matches = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

describe("what the matcher deliberately excludes", () => {
  it("API routes, so a fetch gets a 401 rather than an HTML redirect", () => {
    for (const path of ["/api/forecast", "/api/auth/login", "/api/webhooks"]) {
      expect(matches(path), path).toBe(false);
    }
  });

  it("static assets, so the login page keeps its own styling", () => {
    for (const path of ["/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/logo.svg"]) {
      expect(matches(path), path).toBe(false);
    }
  });

  it("the OAuth callback page and the sandbox checkout", () => {
    // The OAuth hop has no session yet by definition, and the sandbox checkout
    // is opened by a customer who has no CashPilot account at all.
    expect(matches("/auth/google")).toBe(false);
    expect(matches("/sandbox/checkout")).toBe(false);
  });

  it("but DOES cover the pages it is meant to guard", () => {
    for (const path of PROTECTED) {
      expect(matches(path), path).toBe(true);
    }
    expect(matches("/login")).toBe(true);
  });
});
