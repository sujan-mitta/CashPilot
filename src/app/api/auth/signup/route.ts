import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { signSession } from "@/lib/auth";
import { cookies } from "next/headers";
import { errorMessage } from "@/lib/errors";

export async function POST(req: Request) {
  try {
    const { name, email, businessName } = await req.json();

    if (!name || !email || !businessName) {
      return NextResponse.json({ error: "Missing required parameters." }, { status: 400 });
    }

    // Find or create Business
    let business = await prisma.business.findFirst({
      where: { name: businessName },
    });

    if (!business) {
      business = await prisma.business.create({
        data: {
          name: businessName,
          currentCash: 100000000, // ₹10.0L default in paise
        },
      });
    }

    // Find or create User and connect to Business
    let user = await prisma.user.findUnique({
      where: { email },
      include: { businesses: true },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          name,
          email,
          businesses: {
            connect: { id: business.id },
          },
        },
        include: { businesses: true },
      });
    } else {
      // Connect to business if not already linked
      const isLinked = user.businesses.some((b) => b.id === business.id);
      if (!isLinked) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            businesses: {
              connect: { id: business.id },
            },
          },
          include: { businesses: true },
        });
      }
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
    console.error("Signup API error:", error);
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
