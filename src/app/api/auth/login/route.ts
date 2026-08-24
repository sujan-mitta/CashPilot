import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { signSession } from "@/lib/auth";
import { cookies } from "next/headers";
import { errorMessage } from "@/lib/errors";

export async function POST(req: Request) {
  try {
    const { email, businessName } = await req.json();

    if (!email || !businessName) {
      return NextResponse.json({ error: "Missing required parameters." }, { status: 400 });
    }

    // Find Business
    const business = await prisma.business.findFirst({
      where: { name: businessName },
    });

    if (!business) {
      return NextResponse.json({ error: "Business not found." }, { status: 404 });
    }

    // Find User and check membership
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        businesses: {
          where: { id: business.id },
        },
      },
    });

    if (!user || user.businesses.length === 0) {
      return NextResponse.json({ error: "User is not authorized for this business." }, { status: 403 });
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
      maxAge: 604800, // 7 days
      path: "/",
    });

    return NextResponse.json({ success: true, user: sessionPayload });
  } catch (error) {
    console.error("Login API error:", error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
