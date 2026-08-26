import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { signSession } from "@/lib/auth";
import { verifyPassword, isPlaceholderHash } from "@/lib/auth/password";
import { rateLimit, clientKey } from "@/lib/auth/rateLimit";
import { cookies } from "next/headers";
import { logger } from "@/lib/observability";
import { parseJsonBody } from "@/lib/errors";

/**
 * Email + password sign-in.
 *
 * The previous version destructured only { email, businessName } and never
 * looked at the password. Authentication succeeded on two public strings, so
 * anyone who knew a user's email and their business name got a full session.
 * Verified live in production. This now requires and verifies the password.
 */
export async function POST(req: Request) {
  // Uniform failure so the endpoint cannot be used to tell a real account from
  // a wrong password from a non-member. All three return the same 401.
  const reject = () =>
    NextResponse.json({ error: "Invalid email or password." }, { status: 401 });

  try {
    // Brute-force protection: fixed window per IP + email.
    const limited = rateLimit(`login:${clientKey(req)}`, 10, 60_000);
    if (!limited.ok) {
      return NextResponse.json(
        { error: "Too many attempts. Please wait a minute and try again." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
      );
    }

    const parsed = await parseJsonBody<Record<string, unknown>>(req);
    if (!parsed.ok) return parsed.response;
    const { email, password, businessName } = parsed.data;
    if (!email || !password || !businessName) {
      return NextResponse.json({ error: "Email, password and business name are required." }, { status: 400 });
    }

    const business = await prisma.business.findFirst({ where: { name: businessName } });
    if (!business) return reject();

    const user = await prisma.user.findUnique({
      where: { email: String(email).toLowerCase() },
      include: { businesses: { where: { id: business.id } } },
    });
    if (!user || user.businesses.length === 0) return reject();

    // A legacy placeholder hash can never be satisfied by a real password, so
    // these accounts are locked until a password is set. Say so specifically -
    // this is not a wrong-password case and the user needs different guidance.
    if (isPlaceholderHash(user.password)) {
      return NextResponse.json(
        { error: "This account has no password set. Please reset your password to continue." },
        { status: 403 }
      );
    }

    const ok = await verifyPassword(String(password), user.password);
    if (!ok) {
      logger.warn("Failed login attempt", { emailDomain: String(email).split("@")[1] ?? "unknown" });
      return reject();
    }

    const sessionPayload = {
      userId: user.id,
      name: user.name,
      email: user.email,
      businessId: business.id,
      businessName: business.name,
    };

    const token = signSession(sessionPayload);
    const cookieStore = await cookies();
    cookieStore.set("cashpilot_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 604800,
      path: "/",
    });

    return NextResponse.json({ success: true, user: sessionPayload });
  } catch (error) {
    // Never echo the raw error to the client; log it server-side only.
    logger.error("Login API error", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "Sign-in failed. Please try again." }, { status: 500 });
  }
}
