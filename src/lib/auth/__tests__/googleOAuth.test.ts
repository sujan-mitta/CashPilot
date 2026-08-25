import { describe, it, expect, vi, afterEach } from "vitest";
import {
  readIdentityFromIdToken,
  buildAuthorizationUrl,
  resolveRedirectUri,
  isGoogleConfigured,
} from "../googleOAuth";

/**
 * Google sign-in used to be a mock: a fake account chooser posted a
 * GOOGLE_AUTH_SUCCESS message and the login page created a real account from
 * whatever the message claimed, with no `event.origin` check. Identity was
 * fully attacker-controlled.
 *
 * These pin the checks that make the replacement trustworthy - above all that
 * a token minted for a DIFFERENT OAuth client is rejected, which is what stops
 * a token obtained elsewhere from being replayed at this app.
 */

const CLIENT = "123456789-abcdef.apps.googleusercontent.com";

function makeIdToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature-not-checked`;
}

const validClaims = (over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT,
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: "Person@Example.com",
  email_verified: true,
  name: "A Person",
  ...over,
});

afterEach(() => vi.unstubAllEnvs());

describe("readIdentityFromIdToken", () => {
  it("extracts the identity and normalises the email", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    const id = readIdentityFromIdToken(makeIdToken(validClaims()));
    expect(id.email).toBe("person@example.com");
    expect(id.name).toBe("A Person");
    expect(id.emailVerified).toBe(true);
  });

  it("REJECTS a token minted for a different OAuth client", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    const other = makeIdToken(validClaims({ aud: "999-someone-else.apps.googleusercontent.com" }));
    expect(() => readIdentityFromIdToken(other)).toThrow(/different client/i);
  });

  it("rejects a non-Google issuer", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    const evil = makeIdToken(validClaims({ iss: "https://accounts.evil.example" }));
    expect(() => readIdentityFromIdToken(evil)).toThrow(/issuer is not Google/i);
  });

  it("accepts the bare-host issuer Google also emits", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    expect(() => readIdentityFromIdToken(makeIdToken(validClaims({ iss: "accounts.google.com" })))).not.toThrow();
  });

  it("rejects an expired token", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    const old = makeIdToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 60 }));
    expect(() => readIdentityFromIdToken(old)).toThrow(/expired/i);
  });

  it("rejects a malformed token and a token with no email", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    expect(() => readIdentityFromIdToken("not.a.jwt.at.all")).toThrow();
    expect(() => readIdentityFromIdToken(makeIdToken(validClaims({ email: "" })))).toThrow(/no email/i);
  });

  it("reports an unverified email rather than trusting it", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    const id = readIdentityFromIdToken(makeIdToken(validClaims({ email_verified: false })));
    // The callback refuses on this flag; it must survive intact to get there.
    expect(id.emailVerified).toBe(false);
  });
});

describe("authorization request", () => {
  it("carries the state and requests only the scopes it needs", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    const u = new URL(buildAuthorizationUrl("https://app.example/api/auth/google/callback", "st4te"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("state")).toBe("st4te");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("client_id")).toBe(CLIENT);
    // The client secret must never appear in a browser-visible URL.
    expect(u.toString()).not.toMatch(/client_secret/);
  });
});

describe("redirect URI resolution", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://internal.local/api/auth/google/start", { headers });

  it("uses forwarded headers so it works behind Vercel's proxy", () => {
    // req.url reports the internal origin in production; the registered URI
    // must be the PUBLIC one or Google rejects the exchange.
    const uri = resolveRedirectUri(req({ "x-forwarded-host": "cash-pilot-gold.vercel.app", "x-forwarded-proto": "https" }));
    expect(uri).toBe("https://cash-pilot-gold.vercel.app/api/auth/google/callback");
  });

  it("stays on http for localhost", () => {
    expect(resolveRedirectUri(req({ host: "localhost:3000" }))).toBe(
      "http://localhost:3000/api/auth/google/callback"
    );
  });

  it("an explicit override wins", () => {
    vi.stubEnv("GOOGLE_REDIRECT_URI", "https://pinned.example/cb");
    expect(resolveRedirectUri(req({ host: "whatever" }))).toBe("https://pinned.example/cb");
  });
});

describe("configuration gate", () => {
  it("is off unless BOTH credentials are present", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    expect(isGoogleConfigured()).toBe(false);

    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT);
    expect(isGoogleConfigured()).toBe(false);

    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    expect(isGoogleConfigured()).toBe(true);
  });
});
