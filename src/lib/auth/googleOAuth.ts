/**
 * ===========================================================================
 * GOOGLE OAUTH 2.0 — authorization code flow
 * ===========================================================================
 *
 * Replaces a mock account chooser that posted a fabricated
 * GOOGLE_AUTH_SUCCESS message to the login page, which then created a real
 * account from whatever the message claimed. The listener performed no
 * `event.origin` check, so the identity was entirely attacker-controlled.
 *
 * The real flow never lets the browser assert who the user is. The browser
 * only carries an opaque `code`; the server exchanges it with Google over TLS
 * and reads the identity out of the response.
 *
 * No secret VALUE is logged here, and the id_token is never returned to the
 * client.
 */

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Cookie holding the CSRF state between the redirect out and the callback. */
export const OAUTH_STATE_COOKIE = "cashpilot_oauth_state";

export interface GoogleIdentity {
  email: string;
  name: string;
  emailVerified: boolean;
}

export function isGoogleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * The callback URL, which must match a URI registered in Google Cloud Console
 * byte for byte.
 *
 * Derived from forwarded headers so the same build works on localhost and
 * behind Vercel's proxy, where `req.url` reports the internal origin rather
 * than the public one.
 */
export function resolveRedirectUri(req: Request): string {
  const explicit = process.env.GOOGLE_REDIRECT_URI;
  if (explicit) return explicit;

  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/api/auth/google/callback`;
}

export function buildAuthorizationUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    // Google returns a refresh token only with consent+offline; we need
    // neither, so keep the consent screen minimal and the grant short-lived.
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Reads the identity out of an id_token.
 *
 * The signature is deliberately NOT re-verified: this token did not come from
 * the browser. It was returned directly by Google's token endpoint over an
 * authenticated TLS channel, which is what the OAuth spec treats as
 * sufficient. The claims that constrain WHO it is for are still checked,
 * because a token minted for a different client would otherwise be accepted.
 */
export function readIdentityFromIdToken(idToken: string): GoogleIdentity {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token");

  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

  const iss = String(claims.iss ?? "");
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") {
    throw new Error("id_token issuer is not Google");
  }
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw new Error("id_token was issued for a different client");
  }
  const exp = Number(claims.exp ?? 0);
  if (!exp || exp * 1000 < Date.now()) throw new Error("id_token has expired");

  const email = String(claims.email ?? "").toLowerCase();
  if (!email) throw new Error("id_token carries no email");

  return {
    email,
    name: String(claims.name ?? email.split("@")[0]),
    // Google sends this as a boolean or the string "true" depending on flow.
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
  };
}

/** Exchanges the authorization code. Throws with no secret in the message. */
export async function exchangeCodeForIdentity(
  code: string,
  redirectUri: string
): Promise<GoogleIdentity> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    // Google echoes an error code, never our secret, but keep it terse.
    const body = (await res.text()).slice(0, 200);
    throw new Error(`Google token exchange failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw new Error("Google returned no id_token");

  return readIdentityFromIdToken(data.id_token);
}
