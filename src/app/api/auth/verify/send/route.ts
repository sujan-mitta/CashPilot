import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit, clientKey } from "@/lib/auth/rateLimit";
import { parseJsonBody } from "@/lib/errors";
import { normalizeEmail, validateEmail } from "@/lib/auth/validation";
import { issueVerificationCode } from "@/lib/auth/issueVerificationCode";
import { logger } from "@/lib/observability";

/**
 * Send (or resend) a verification code.
 *
 * The response is deliberately the SAME whether or not the address belongs to
 * an account, and whether or not it is already verified. This endpoint is
 * unauthenticated by necessity — the whole point is that the caller has not yet
 * proven anything — so a response that varied would let anyone test which
 * addresses are registered.
 */
export async function POST(req: Request) {
  // Two limits. The per-caller one stops one client hammering the endpoint; the
  // per-address one stops a rotating set of callers being used to flood one
  // person's inbox, which the caller limit alone would not catch.
  const byClient = rateLimit(`verify-send:${clientKey(req)}`, 5, 60_000);
  if (!byClient.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment." },
      { status: 429, headers: { "Retry-After": String(byClient.retryAfterSec) } }
    );
  }

  const parsed = await parseJsonBody<Record<string, unknown>>(req);
  if (!parsed.ok) return parsed.response;

  const invalid = validateEmail(parsed.data.email);
  if (invalid) return NextResponse.json({ error: invalid.message, field: "email" }, { status: 400 });

  const email = normalizeEmail(String(parsed.data.email));

  const byAddress = rateLimit(`verify-send-addr:${email}`, 5, 60 * 60_000);
  if (!byAddress.ok) {
    return NextResponse.json(
      { sent: true },
      { status: 200 }
    );
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    // No account, or already verified: answer as though a code went out. The
    // real work is skipped, but the caller cannot tell, and a genuine user in
    // either state is not harmed — one has no account to verify, the other is
    // already through.
    if (user && !user.emailVerified) {
      const result = await issueVerificationCode(user);
      if (!result.ok && result.reason === "COOLDOWN") {
        return NextResponse.json(
          { sent: true, cooldown: true },
          { status: 200, headers: { "Retry-After": String(result.retryAfterSec) } }
        );
      }
      if (!result.ok) {
        // Worth telling the truth about: the caller is a real user, waiting for
        // a code that is not coming, and silence would leave them retrying.
        return NextResponse.json(
          { error: "We could not send the verification email right now. Please try again shortly." },
          { status: 502 }
        );
      }
    }

    return NextResponse.json({ sent: true });
  } catch (error) {
    logger.error("Verification send failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Could not send a verification code." }, { status: 500 });
  }
}
