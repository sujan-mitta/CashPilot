import { NextResponse } from "next/server";
import { getSession, signSession, requireBusinessAccess } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { cookies } from "next/headers";
import { errorMessage, parseJsonBody } from "@/lib/errors";
import { logger } from "@/lib/observability";

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = await parseJsonBody<{ businessId?: unknown }>(req);
    if (!parsed.ok) return parsed.response;
    const businessId = parsed.data.businessId;
    if (typeof businessId !== "string" || businessId.trim() === "") {
      return NextResponse.json({ error: "Missing or invalid businessId parameter." }, { status: 400 });
    }

    // Verify user has access to this business
    const hasAccess = await requireBusinessAccess(session.userId, businessId);
    if (!hasAccess) {
      return NextResponse.json({ error: "Access denied." }, { status: 403 });
    }

    // Find the business details
    const business = await prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business) {
      return NextResponse.json({ error: "Business not found." }, { status: 404 });
    }

    // Generate new session token with the switched business
    const newSessionPayload = {
      userId: session.userId,
      name: session.name,
      email: session.email,
      businessId: business.id,
      businessName: business.name,
    };

    const token = signSession(newSessionPayload);
    const cookieStore = await cookies();
    cookieStore.set("cashpilot_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 604800, // 7 days
      path: "/",
    });

    return NextResponse.json({ success: true, user: newSessionPayload });
  } catch (error) {
    logger.error("Switch business API error", { error: errorMessage(error) });
    return NextResponse.json({ error: "Could not switch business. Please try again." }, { status: 500 });
  }
}
