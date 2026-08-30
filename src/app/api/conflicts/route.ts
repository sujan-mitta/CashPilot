import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { findOpenConflicts } from "@/lib/evidence/openConflicts";
import { errorMessage } from "@/lib/errors";
import { logger } from "@/lib/observability";

/**
 * Cross-source conflicts awaiting a human decision (spec §7).
 *
 * `brain:sync` has always been able to say "N source conflicts need a human
 * decision" and nothing more. This is what makes N inspectable.
 *
 * Read-only, deliberately. There is no POST here and that is not an omission:
 * resolving a conflict means declaring one source authoritative over another
 * about real money, and §14 and §41 both put that squarely with a human. A
 * resolution endpoint would also need somewhere to record the decision, the
 * actor and the reason — the schema has no such table yet, and inventing a
 * silent one would be worse than making the operator act on the underlying
 * record.
 */
export async function GET(req: Request) {
  try {
    const session = await getSession();
    if (!session?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;

    // Tenant from the session, never from the query. Conflicts expose amounts
    // and source record ids for real money.
    const conflicts = await findOpenConflicts(prisma, session.businessId, { limit });

    const byState = conflicts.reduce<Record<string, number>>((acc, c) => {
      acc[c.state] = (acc[c.state] ?? 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({
      conflicts,
      count: conflicts.length,
      byState,
      note:
        "Nothing here has been resolved. CashPilot never picks a side between two " +
        "sources that disagree about an amount — resolving one means declaring a " +
        "source authoritative, which is your decision to make against your own records.",
    });
  } catch (error) {
    logger.error("Conflict listing failed", {
      businessId: "redacted",
      error: errorMessage(error),
    });
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
