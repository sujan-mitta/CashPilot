import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { rateLimit, clientKey } from "@/lib/auth/rateLimit";
import { parseJsonBody } from "@/lib/errors";
import {
  connectRazorpay,
  disconnectRazorpay,
  describeConnection,
  setWebhookSecret,
} from "@/lib/razorpay/connection";
import { logger } from "@/lib/observability";

/**
 * Connect or disconnect a merchant's own Razorpay account.
 *
 * The request body carries a live credential, so this route is deliberately
 * spare: it authenticates, rate-limits, hands the values to the connection
 * layer, and returns a summary that contains no secret. It never logs the body,
 * never echoes a submitted value back in an error, and never returns the key.
 */

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Each attempt costs a call to Razorpay, so this is also what stops the
  // endpoint being used to probe credentials at someone else's expense.
  const limited = rateLimit(`rzp-connect:${clientKey(req)}`, 5, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a minute and try again." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  const parsed = await parseJsonBody<Record<string, unknown>>(req);
  if (!parsed.ok) return parsed.response;

  const keyId = typeof parsed.data.keyId === "string" ? parsed.data.keyId : "";
  const keySecret = typeof parsed.data.keySecret === "string" ? parsed.data.keySecret : "";
  const webhookSecret =
    typeof parsed.data.webhookSecret === "string" ? parsed.data.webhookSecret : undefined;

  try {
    const result = await connectRazorpay(session.businessId, { keyId, keySecret, webhookSecret });

    if (!result.ok) {
      // The failure reason is safe to return; the submitted values are not, and
      // are never included.
      return NextResponse.json(
        { error: result.failure, message: result.message },
        { status: result.failure === "PROVIDER_UNREACHABLE" ? 503 : 400 }
      );
    }

    return NextResponse.json({
      connected: true,
      mode: result.mode,
      // The token is not a secret — it only selects which key a webhook is
      // verified against — and the merchant needs it to configure their
      // dashboard.
      webhookToken: result.webhookToken,
      summary: await describeConnection(session.businessId),
    });
  } catch (error) {
    logger.error("Razorpay connect failed", {
      businessId: session.businessId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ error: "Could not save that connection." }, { status: 500 });
  }
}

/**
 * Add the webhook secret to an existing connection, keeping the same URL.
 *
 * Separate from POST because reconnecting rotates the token, which would change
 * the URL the merchant has just finished pasting into Razorpay.
 */
export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = rateLimit(`rzp-webhook:${clientKey(req)}`, 10, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a minute and try again." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } }
    );
  }

  const parsed = await parseJsonBody<Record<string, unknown>>(req);
  if (!parsed.ok) return parsed.response;

  const webhookSecret =
    typeof parsed.data.webhookSecret === "string" ? parsed.data.webhookSecret : "";

  const result = await setWebhookSecret(session.businessId, webhookSecret);
  if (!result.ok) {
    return NextResponse.json({ error: "WEBHOOK_SECRET_REJECTED", message: result.message }, { status: 400 });
  }

  return NextResponse.json({ summary: await describeConnection(session.businessId) });
}

export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const removed = await disconnectRazorpay(session.businessId);
  return NextResponse.json({ disconnected: removed });
}
