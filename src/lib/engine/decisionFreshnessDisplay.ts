import { FINANCIAL_CONFIG } from "./financialConfig";

/**
 * How fresh a recommendation is, in language an operator can act on.
 *
 * Expiry currently reaches the user exactly once: as a refusal, at the moment
 * they try to approve or execute. That is the worst possible time to learn it —
 * they have already read the plan, decided, and committed to acting, and the
 * system waits until then to say no.
 *
 * This computes the same fact earlier so a screen can show it while the
 * decision is still usable. It is display only: it changes no gate, refuses
 * nothing, and deliberately cannot — `checkDecisionValidity` remains the single
 * authority on whether a decision may be acted on. Two places deciding
 * executability would eventually disagree, and the one that ran second would
 * win by accident.
 */

export type FreshnessBand = "CURRENT" | "EXPIRING_SOON" | "EXPIRED" | "UNKNOWN";

export interface FreshnessDisplay {
  band: FreshnessBand;
  /** Whole hours until expiry. Negative once past. Null when not tracked. */
  hoursRemaining: number | null;
  /** Short label for a badge. */
  label: string;
  /** One sentence, safe to show a user. */
  detail: string;
}

/**
 * When "expiring soon" starts.
 *
 * A quarter of the TTL: long enough that an operator who checks daily always
 * sees the warning before the refusal, short enough that the badge is not
 * permanently on and therefore permanently ignored. Derived from the TTL rather
 * than fixed, so the two cannot drift apart if the TTL is ever tuned.
 */
export const EXPIRING_SOON_FRACTION = 0.25;

export function expiringSoonThresholdHours(): number {
  return FINANCIAL_CONFIG.DECISION_TTL_HOURS * EXPIRING_SOON_FRACTION;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function humanise(hours: number): string {
  if (hours >= 48) return plural(Math.floor(hours / 24), "day");
  if (hours >= 1) return plural(Math.floor(hours), "hour");
  const minutes = Math.max(1, Math.floor(hours * 60));
  return plural(minutes, "minute");
}

export function describeFreshness(
  expiresAt: Date | string | null | undefined,
  now: Date = new Date()
): FreshnessDisplay {
  // A decision created before expiry tracking existed genuinely has no expiry
  // recorded. That is not "expired" — those were deliberately never backfilled,
  // and treating an absent value as a refusal would retroactively invalidate
  // every older recommendation.
  if (!expiresAt) {
    return {
      band: "UNKNOWN",
      hoursRemaining: null,
      label: "Not tracked",
      detail:
        "This recommendation predates expiry tracking, so no validity window was recorded for it.",
    };
  }

  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) {
    return {
      band: "UNKNOWN",
      hoursRemaining: null,
      label: "Not tracked",
      detail: "The recorded expiry for this recommendation could not be read.",
    };
  }

  const hoursRemaining = (expiry.getTime() - now.getTime()) / (1000 * 60 * 60);

  if (hoursRemaining <= 0) {
    return {
      band: "EXPIRED",
      hoursRemaining: Math.round(hoursRemaining),
      label: "Expired",
      detail:
        `This recommendation expired ${humanise(Math.abs(hoursRemaining))} ago and can no longer ` +
        "be approved or executed. Re-run the comparison to get one built from current figures.",
    };
  }

  if (hoursRemaining <= expiringSoonThresholdHours()) {
    return {
      band: "EXPIRING_SOON",
      hoursRemaining: Math.round(hoursRemaining),
      label: `Expires in ${humanise(hoursRemaining)}`,
      detail:
        `This recommendation stops being executable in ${humanise(hoursRemaining)}. ` +
        "After that it must be re-run, because a week of silence in a live ledger is a " +
        "reason to distrust the figures it was built from.",
    };
  }

  return {
    band: "CURRENT",
    hoursRemaining: Math.round(hoursRemaining),
    label: `Current for ${humanise(hoursRemaining)}`,
    detail: `This recommendation was built from figures that are still considered current.`,
  };
}
