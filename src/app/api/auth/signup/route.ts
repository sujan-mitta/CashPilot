import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cookies } from "next/headers";
import { signSession } from "@/lib/auth";
import { hashPassword } from "@/lib/auth/password";
import { issueVerificationCode } from "@/lib/auth/issueVerificationCode";
import { verificationCanBeRequired } from "@/lib/auth/verificationPolicy";
import { rateLimit, clientKey } from "@/lib/auth/rateLimit";
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
 *
 *  3. Unreachable addresses. Validation checked the SHAPE of the email, which
 *     cannot tell "sujan@gmail.com" from "sujan@gmial.com". Accounts were
 *     created on addresses that do not exist, and every alert to them bounced
 *     back to us. Signup now ends at a code sent to the address; the session is
 *     issued only when that code comes back.
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

    // Except when that account never finished verifying. Signup creates the
    // account and then waits for a code, so anyone who closed the tab, lost the
    // email, or let the code expire owns an account they cannot reach: signing
    // up again said "already exists, please sign in", and signing in asked for
    // the code they never had. A dead end built out of two correct-looking
    // refusals.
    //
    // Resuming is the fix, NOT deleting the half-made account. Deleting on an
    // incomplete verification would destroy an account because someone closed a
    // tab, and would release their email and business name for anyone else to
    // claim in the meantime.
    //
    // Nothing about the account is modified here — not the password, not the
    // business. This only re-sends a code, and the code goes to the address on
    // file, so a stranger cannot use it to take anything over: at most they
    // cause one email to be sent to its rightful owner.
    if (existingUser && !existingUser.emailVerified && verificationCanBeRequired()) {
      const resent = await issueVerificationCode({
        id: existingUser.id,
        name: existingUser.name,
        email: existingUser.email,
      });

      logger.info("Signup resumed for an unverified account", {
        userId: existingUser.id,
        codeSent: resent.ok,
      });

      return NextResponse.json(
        {
          requiresVerification: true,
          email: existingUser.email,
          error: resent.ok
            ? "This email is already registered but not yet confirmed. We have sent a new code."
            : "This email is already registered but not yet confirmed. We could not send a code just now — request a new one.",
        },
        { status: 200 }
      );
    }

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

    // With no mail provider configured a code can never arrive, so demanding
    // one would leave the account created and unreachable — no session, and no
    // way to get one. Such a deployment sends no alerts either, so there is no
    // bounce to protect against and nothing is lost by signing them straight in.
    if (!verificationCanBeRequired()) {
      const cookieStore = await cookies();
      cookieStore.set("cashpilot_session", signSession(sessionPayload), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 604800,
        path: "/",
      });
      logger.info("Account created without email verification (no mailer configured)", {
        userId: user.id,
        businessId: business.id,
      });
      return NextResponse.json({ success: true, user: sessionPayload });
    }

    // No session yet. The account exists, but nobody has shown they can read
    // the address on it, and an address that only LOOKS valid is how the alert
    // pipeline ends up mailing somewhere that does not exist — every send
    // bouncing back to us. The session is issued by /api/auth/verify/confirm,
    // once a code mailed to the address is returned.
    const issued = await issueVerificationCode({
      id: user.id,
      name: user.name,
      email: user.email,
    });

    if (!issued.ok) {
      // The account is kept. Deleting it would free the email and the business
      // name for anyone else in the window before a retry, and the user can
      // simply request another code. Reported honestly so they do not sit
      // waiting for mail that never left.
      logger.error("Account created but verification email failed", {
        userId: user.id,
        businessId: business.id,
      });
      return NextResponse.json(
        {
          requiresVerification: true,
          email: user.email,
          error:
            "Your account was created, but we could not send the verification code. Request a new one.",
        },
        { status: 202 }
      );
    }

    logger.info("Account created; awaiting email verification", {
      userId: user.id,
      businessId: business.id,
    });
    return NextResponse.json({ requiresVerification: true, email: user.email });
  } catch (error) {
    logger.error("Signup API error", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "Sign-up failed. Please try again." }, { status: 500 });
  }
}
