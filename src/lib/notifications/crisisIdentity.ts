/**
 * Deterministic Crisis Identity generator for CashPilot.
 *
 * Generates structured, deterministic crisis keys so cooldowns and deduplication
 * apply precisely to the same crisis instance without suppressing materially new
 * financial events.
 *
 * Format Examples:
 * - DEFICIT:YYYY-MM-DD
 * - RUNWAY_LT_14:YYYY-MM-DD
 * - OBLIGATION_RISK:obligation-id-or-date
 * - SAFETY_BUFFER_BREACH:buffer-level-or-date
 */

import type { CrisisType } from "./types";

export interface CrisisIdentityInput {
  type: CrisisType;
  projectedDeficitDate?: string | null;
  firstBelowSafetyDate?: string | null;
  criticalObligationDate?: string | null;
  obligationId?: string | null;
}

/**
 * Builds a deterministic crisisKey string.
 */
export function buildCrisisKey(input: CrisisIdentityInput): string | null {
  if (input.type === "HEALTHY") {
    return null;
  }

  if (input.type === "DEFICIT") {
    const datePart = input.projectedDeficitDate
      ? input.projectedDeficitDate.split("T")[0]
      : "immediate";
    return `DEFICIT:${datePart}`;
  }

  if (input.type === "RUNWAY_LT_14") {
    const datePart = input.firstBelowSafetyDate
      ? input.firstBelowSafetyDate.split("T")[0]
      : "immediate";
    return `RUNWAY_LT_14:${datePart}`;
  }

  if (input.type === "OBLIGATION_RISK") {
    const idOrDate = input.obligationId || (input.criticalObligationDate ? input.criticalObligationDate.split("T")[0] : "immediate");
    return `OBLIGATION_RISK:${idOrDate}`;
  }

  if (input.type === "SAFETY_BUFFER_BREACH") {
    const datePart = input.firstBelowSafetyDate
      ? input.firstBelowSafetyDate.split("T")[0]
      : "current_balance";
    return `SAFETY_BUFFER_BREACH:${datePart}`;
  }

  return `CUSTOM:${input.type}`;
}

/**
 * Checks if two crisis keys represent the exact same crisis instance.
 */
export function isSameCrisis(keyA: string | null | undefined, keyB: string | null | undefined): boolean {
  if (!keyA || !keyB) return false;
  return keyA.trim().toLowerCase() === keyB.trim().toLowerCase();
}
