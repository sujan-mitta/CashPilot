import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { parseJsonBody, errorMessage } from "@/lib/errors";
import { findMergeSuggestions } from "@/lib/entities/mergeSuggestions";
import { mergeCounterparties } from "@/lib/entities/store";
import { logger } from "@/lib/observability";

/**
 * Counterparty merge review (spec §6, closing C-3 and C-4).
 *
 * `mergeCounterparties` has been implemented, guarded and tested since Phase 4,
 * but no user could reach it: `brain:sync` printed a COUNT of suggestions and
 * nothing acted on them. This is the suggestion → confirmation loop.
 *
 * The safety rule this endpoint exists to preserve is that a near-match is
 * never merged automatically. Two customers wrongly merged silently poison one
 * customer's payment history with another's, and the behaviour model then makes
 * confident predictions from fabricated history. So GET only ever proposes, and
 * POST only ever executes a merge a human named explicitly — it does not accept
 * a "merge everything above 0.8" instruction, because that is automatic merging
 * with extra steps.
 *
 * Every guard lives in `mergeCounterparties` (no self-merge, no double-merge, no
 * cross-type, no cross-tenant) and is exercised there. This route adds the two
 * things a library function cannot: the session, and the transaction (C-4 —
 * the merge orders its statements so a crash part-way converges, but it does
 * not open a transaction itself).
 */

/** Suggested duplicates for the caller's own tenant. */
export async function GET(req: Request) {
  try {
    const session = await getSession();
    if (!session?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;

    // Tenant comes from the session, never from the request. A businessId
    // parameter here would be an invitation to read another tenant's entities.
    const suggestions = await findMergeSuggestions(prisma, session.businessId, { limit });

    return NextResponse.json({
      suggestions,
      count: suggestions.length,
      note:
        "Suggestions are derived from normalised name overlap only. Confirm each one " +
        "against your own records before merging; a wrong merge attaches one customer's " +
        "payment history to another.",
    });
  } catch (error) {
    logger.error("Merge suggestion listing failed", { error: errorMessage(error) });
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

/** Execute one merge a human has confirmed. */
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session?.businessId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = await parseJsonBody<{ sourceId?: unknown; targetId?: unknown }>(req);
    if (!parsed.ok) {
      return NextResponse.json({ error: "Malformed request body" }, { status: 400 });
    }

    const sourceId = typeof parsed.data.sourceId === "string" ? parsed.data.sourceId : null;
    const targetId = typeof parsed.data.targetId === "string" ? parsed.data.targetId : null;

    if (!sourceId || !targetId) {
      return NextResponse.json(
        { error: "Both sourceId and targetId are required." },
        { status: 400 }
      );
    }

    // C-4: the merge moves aliases, writes a new alias and stamps mergedIntoId.
    // Its statement order is chosen so a crash part-way converges, but partial
    // convergence is not the same as atomicity — a reviewer clicking Approve is
    // entitled to all of it or none.
    const result = await prisma.$transaction((tx) =>
      mergeCounterparties(tx, session.businessId, sourceId, targetId)
    );

    logger.info("Counterparty merge confirmed by operator", {
      businessId: session.businessId,
      actorId: session.userId,
      sourceId,
      targetId,
      aliasesMoved: result.aliasesMoved,
    });

    return NextResponse.json({ ok: true, merge: result });
  } catch (error) {
    const message = errorMessage(error);

    // The library's guards are refusals, not faults: merging into yourself, a
    // already-merged entity, a different type, or another tenant's row. A 500
    // would read as "we broke" when the honest answer is "we declined".
    const isRefusal =
      /cannot merge|already been merged|not found for this tenant|different types/i.test(message);

    if (isRefusal) {
      logger.warn("Counterparty merge refused", { error: message });
      // 404-shaped messages are deliberately returned as 409 alongside the
      // others, so the response cannot be used to probe which ids exist in
      // another tenant.
      return NextResponse.json({ error: message }, { status: 409 });
    }

    logger.error("Counterparty merge failed", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
