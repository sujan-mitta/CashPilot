import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { describeRazorpayIntegration } from "@/lib/razorpay/status";

/**
 * Whether Razorpay is usable, for the onboarding choice.
 *
 * Session-gated even though it exposes no secret and no per-tenant data: the
 * shape of a deployment's payment configuration is not something an anonymous
 * caller needs, and an endpoint that answers everyone is one more thing to
 * reason about later.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Returns mode and capability only. Never a key, masked or otherwise.
  return NextResponse.json(describeRazorpayIntegration());
}
