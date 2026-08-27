/**
 * Human-readable copy for the engine's strategy names.
 *
 * The engine identifies strategies by stable machine names (see STRATEGY_NAMES
 * in engine/strategyEngine.ts). The UI should never show those raw tokens to an
 * operator, so every surface routes them through here. History records can carry
 * a null/undefined strategyType (e.g. a plan captured before one was chosen), so
 * the argument is nullable and unknown values fall back to a readable title-case
 * of the token rather than a crash or a blank.
 */

interface PlanCopy {
  /** Full display name for headings and cards. */
  name: string;
  /** Compact label for tight spots (table headers, chips). */
  short: string;
  /** One-line description of what the plan actually does. */
  summary: string;
}

const PLAN_COPY: Record<string, PlanCopy> = {
  DO_NOTHING: {
    name: "Hold the course",
    short: "Hold",
    summary: "Take no action and let the forecast play out as it stands.",
  },
  RECOVER_ONLY: {
    name: "Recover failed payments",
    short: "Recover",
    summary: "Send recovery links to chase down customer payments that failed.",
  },
  RECOVER_AND_COLLECT: {
    name: "Recover & accelerate collections",
    short: "Recover + Collect",
    summary:
      "Recover failed payments and accelerate your highest-priority overdue collections.",
  },
  FULL_INTERVENTION: {
    name: "Full intervention",
    short: "Full",
    summary:
      "Recover payments, accelerate collections, reschedule non-critical payouts, and pause discretionary spend.",
  },
};

/** Convert an unknown machine token to a readable label, e.g. RESCHEDULE_PAYOUT -> "Reschedule payout". */
function titleCaseToken(raw: string): string {
  const cleaned = raw.trim().replace(/_/g, " ").toLowerCase();
  if (!cleaned) return "Unknown plan";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function lookup(name: string | null | undefined): PlanCopy | null {
  if (!name) return null;
  return PLAN_COPY[name] ?? null;
}

/** Full display name for a strategy. Safe on null/unknown input. */
export function planName(name: string | null | undefined): string {
  const copy = lookup(name);
  if (copy) return copy.name;
  return name ? titleCaseToken(name) : "No plan selected";
}

/** Compact label for tight layouts. Safe on null/unknown input. */
export function planNameShort(name: string | null | undefined): string {
  const copy = lookup(name);
  if (copy) return copy.short;
  return name ? titleCaseToken(name) : "—";
}

/** One-line description of what a strategy does. Safe on null/unknown input. */
export function planSummary(name: string | null | undefined): string {
  const copy = lookup(name);
  if (copy) return copy.summary;
  return name
    ? `Custom plan: ${titleCaseToken(name)}.`
    : "No plan has been selected yet.";
}
