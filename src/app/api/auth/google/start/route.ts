import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import {
  buildAuthorizationUrl,
  isGoogleConfigured,
  resolveRedirectUri,
  OAUTH_STATE_COOKIE,
} from "@/lib/auth/googleOAuth";

/** Begins Google sign-in: mint CSRF state, then redirect to Google. */
export async function GET(req: Request) {
  if (!isGoogleConfigured()) {
    // Say so plainly rather than bouncing the user to a broken Google page.
    return NextResponse.redirect(new URL("/login?error=google_not_configured", req.url));
  }

  const state = crypto.randomBytes(32).toString("base64url");
  const redirectUri = resolveRedirectUri(req);

  const jar = await cookies();
  jar.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // The callback is a top-level cross-site redirect from Google, which a
    // "strict" cookie would not be sent on - the state would look missing and
    // every sign-in would fail. "lax" is the correct scope for this hop.
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return NextResponse.redirect(buildAuthorizationUrl(redirectUri, state));
}
