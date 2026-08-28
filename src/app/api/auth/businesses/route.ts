import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { errorMessage } from "@/lib/errors";
import { logger } from "@/lib/observability";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      include: {
        businesses: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    return NextResponse.json({ businesses: user.businesses });
  } catch (error) {
    logger.error("Fetch user businesses API error", { error: errorMessage(error) });
    return NextResponse.json({ error: "Could not load your businesses." }, { status: 500 });
  }
}
