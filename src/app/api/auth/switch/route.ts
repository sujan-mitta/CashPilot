import { NextResponse } from "next/server";
import { getSession, signSession, requireBusinessAccess } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { cookies } from "next/headers";
import { errorMessage } from "@/lib/errors";

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { businessId } = await req.json();
    if (!businessId) {
      return NextResponse.json({ error: "Missing businessId parameter." }, { status: 400 });
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
    console.error("Switch business API error:", error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
