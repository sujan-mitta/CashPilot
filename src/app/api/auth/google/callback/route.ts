import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { signSession } from "@/lib/auth";
import { logger } from "@/lib/observability";
import {
  exchangeCodeForIdentity,
  isGoogleConfigured,
  resolveRedirectUri,
  OAUTH_STATE_COOKIE,
} from "@/lib/auth/googleOAuth";

const fail = (req: Request, reason: string) =>
  NextResponse.redirect(new URL(`/login?error=${reason}`, req.url));

/**
 * Completes Google sign-in.
 *
 * Deliberately signs in EXISTING users only. Auto-provisioning from an OAuth
 * identity would let anyone who can reach this deployment mint an account -
 * which is exactly what the mock it replaces allowed - and, worse, would have
 * to guess which tenant to attach them to. Tenant membership is granted
 * deliberately, not inferred from a Google login.
 */
export async function GET(req: Request) {
  if (!isGoogleConfigured()) return fail(req, "google_not_configured");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) return fail(req, "google_denied");
  if (!code || !state) return fail(req, "google_invalid_response");

  // --- CSRF: the state must match the one we minted, compared in constant time.
  const jar = await cookies();
  const expected = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);

  if (!expected) return fail(req, "google_state_missing");
  const a = Buffer.from(state);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logger.warn("Google OAuth state mismatch", { failureClassification: "STATE_MISMATCH" });
    return fail(req, "google_state_mismatch");
  }

  try {
    const identity = await exchangeCodeForIdentity(code, resolveRedirectUri(req));

    // An unverified Google email is not proof of address ownership, so it is
    // not proof of identity either.
    if (!identity.emailVerified) return fail(req, "google_email_unverified");

    const user = await prisma.user.findUnique({
      where: { email: identity.email },
      include: { businesses: true },
    });

    if (!user || user.businesses.length === 0) {
      logger.info("Google sign-in refused: no provisioned account", {
        emailDomain: identity.email.split("@")[1] ?? "unknown",
      });
      return fail(req, "google_no_account");
    }

    // Google already proved this address receives mail — that is exactly what
    // the refusal above checks, and it is stronger evidence than our own code
    // round trip. Recording it means a Google user is not left permanently
    // unverified, with every alert suppressed and no way to fix it: they never
    // touch the code screen, so nothing else would ever set this.
    if (!user.emailVerified) {
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: new Date() },
      });
      logger.info("Email verified via Google identity", { userId: user.id });
    }

    const business = user.businesses[0];
    const sessionPayload = {
      userId: user.id,
      name: user.name,
      email: user.email,
      businessId: business.id,
      businessName: business.name,
    };

    const res = NextResponse.redirect(new URL("/dashboard", req.url));
    res.cookies.set("cashpilot_session", signSession(sessionPayload), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 604800,
      path: "/",
    });

    logger.info("Google sign-in succeeded", { userId: user.id, businessId: business.id });
    return res;
  } catch (err) {
    logger.error("Google OAuth callback failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return fail(req, "google_failed");
  }
}
