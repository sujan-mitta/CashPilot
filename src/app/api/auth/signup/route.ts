import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { signSession } from "@/lib/auth";
import { hashPassword } from "@/lib/auth/password";
import { rateLimit, clientKey } from "@/lib/auth/rateLimit";
import { cookies } from "next/headers";
import { logger } from "@/lib/observability";
import { parseJsonBody } from "@/lib/errors";
import {
  validateEmail,
  validateDisplayName,
  validatePassword,
  normalizeEmail,
  MAX_NAME_LENGTH,
  MAX_BUSINESS_NAME_LENGTH,
} from "@/lib/auth/validation";

/**
 * Account registration.
 *
 * Two live-verified defects are closed here:
 *
 *  1. Passwordless. The route never hashed or stored a password, so every
 *     account was unauthenticable-by-design and login accepted anything.
 *
 *  2. Tenant hijack. A new user signing up with an EXISTING business name was
 *     silently connected to that business. Proven live: an outside email
 *     joined ABC Electronics and received a session scoped to its ledger.
 *     Business membership is now granted only at creation; you cannot join an
 *     existing tenant by guessing its name.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(`signup:${clientKey(req)}`, 5, 60_000);
    if (!limited.ok) {
      return NextResponse.json(
        { error: "Too many attempts. Please wait a minute and try again." },
        { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
      );
    }

    const parsed = await parseJsonBody<Record<string, unknown>>(req);
    if (!parsed.ok) return parsed.response;
    const { name, email, businessName, password } = parsed.data;

    // Validated on the SERVER, in one place. The route previously checked only
    // that the fields were truthy, so "notanemail" was stored on a unique
    // column and name/businessName had no length bound at all.
    const fieldError =
      validateDisplayName(name, "Name", MAX_NAME_LENGTH) ??
      validateEmail(email) ??
      validateDisplayName(businessName, "Business name", MAX_BUSINESS_NAME_LENGTH) ??
      validatePassword(password);
    if (fieldError) {
      return NextResponse.json({ error: fieldError.message, field: fieldError.field }, { status: 400 });
    }

    const normalizedEmail = normalizeEmail(String(email));
    const businessNameStr = String(businessName).trim().replace(/\s+/g, " ");
    const nameStr = String(name).trim().replace(/\s+/g, " ");

    // An existing email must sign in, not sign up again. This also stops a
    // second registration silently re-connecting an account elsewhere.
    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existingUser) {
      return NextResponse.json(
        { error: "An account with this email already exists. Please sign in." },
        { status: 409 }
      );
    }

    // A taken business name is refused rather than joined. Joining an existing
    // tenant is a deliberate, authorized action (an invite), never a
    // side-effect of picking the same name.
    // Case-insensitive: "ACME Ltd" and "acme ltd" are the same tenant name, and
    // allowing both to exist is how one operator ends up signing into the other
    // company by accident.
    const existingBusiness = await prisma.business.findFirst({
      where: { name: { equals: businessNameStr, mode: "insensitive" } },
    });
    if (existingBusiness) {
      return NextResponse.json(
        { error: "That business name is already registered. Choose a different name, or ask an existing member to invite you." },
        { status: 409 }
      );
    }

    const passwordHash = await hashPassword(String(password));

    // One transaction so a half-created account can never exist.
    const { user, business } = await prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: { name: businessNameStr, currentCash: 100000000 },
      });
      const user = await tx.user.create({
        data: {
          name: nameStr,
          email: normalizedEmail,
          password: passwordHash,
          businesses: { connect: { id: business.id } },
        },
      });
      return { user, business };
    });

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

    logger.info("Account created", { userId: user.id, businessId: business.id });
    return NextResponse.json({ success: true, user: sessionPayload });
  } catch (error) {
    logger.error("Signup API error", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "Sign-up failed. Please try again." }, { status: 500 });
  }
}
