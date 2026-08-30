import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { signSession } from "@/lib/auth";
import { rateLimit, clientKey } from "@/lib/auth/rateLimit";
import { parseJsonBody } from "@/lib/errors";
import { normalizeEmail, validateEmail } from "@/lib/auth/validation";
import {
  evaluateCode,
  normalizeSubmittedCode,
  outcomeMessage,
  outcomeStatus,
} from "@/lib/auth/emailVerification";
import { logger } from "@/lib/observability";

/**
 * Exchange a code for a verified address, and a session.
 *
 * This is where signup actually completes. The account row exists beforehand,
 * but it holds no session and receives no mail until someone proves they can
 * read the address — which is the only evidence that the address exists.
 */
export async function POST(req: Request) {
  const limited = rateLimit(`verify-confirm:${clientKey(req)}`, 10, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a minute and try again." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  const parsed = await parseJsonBody<Record<string, unknown>>(req);
  if (!parsed.ok) return parsed.response;

  const invalidEmail = validateEmail(parsed.data.email);
  if (invalidEmail) {
    return NextResponse.json({ error: invalidEmail.message, field: "email" }, { status: 400 });
  }

  const code = normalizeSubmittedCode(parsed.data.code);
  if (!code) {
    return NextResponse.json(
      { error: "Enter the 6-digit code from your email.", field: "code" },
      { status: 400 }
    );
  }

  const email = normalizeEmail(String(parsed.data.email));

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { businesses: { orderBy: { createdAt: "asc" }, take: 1 } },
    });

    // An unknown address is answered exactly like a wrong code, so this endpoint
    // cannot be used to discover which addresses are registered.
    if (!user) {
      return NextResponse.json({ error: outcomeMessage("INCORRECT") }, { status: 400 });
    }

    const stored = await prisma.emailVerificationCode.findFirst({
      where: { userId: user.id, email },
      orderBy: { createdAt: "desc" },
    });

    const outcome = evaluateCode(stored, code, new Date());

    if (outcome !== "VERIFIED") {
      // Record the failed guess against the code, which is what makes the
      // attempt cap real. Without this the cap is decorative and six digits are
      // searchable.
      if (stored && (outcome === "INCORRECT" || outcome === "TOO_MANY_ATTEMPTS")) {
        await prisma.emailVerificationCode.update({
          where: { id: stored.id },
          data: { attempts: { increment: 1 } },
        });
      }
      logger.warn("Email verification rejected", { userId: user.id, outcome });
      return NextResponse.json(
        { error: outcomeMessage(outcome), outcome },
        { status: outcomeStatus(outcome) }
      );
    }

    // Burn the code and mark the address proven in one transaction, so a code
    // can never be spent without the verification landing.
    await prisma.$transaction([
      prisma.emailVerificationCode.update({
        where: { id: stored!.id },
        data: { usedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: new Date() },
      }),
    ]);

    const business = user.businesses[0];
    const sessionPayload = {
      userId: user.id,
      name: user.name,
      email: user.email,
      businessId: business?.id ?? "",
      businessName: business?.name ?? "",
    };

    const cookieStore = await cookies();
    cookieStore.set("cashpilot_session", signSession(sessionPayload), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 604800,
      path: "/",
    });

    logger.info("Email verified", { userId: user.id });
    return NextResponse.json({ success: true, user: sessionPayload });
  } catch (error) {
    logger.error("Email verification failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 500 });
  }
}
