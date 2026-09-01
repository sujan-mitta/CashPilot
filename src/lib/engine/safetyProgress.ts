/**
 * How far the business still is from its own safe floor, and what is left to do
 * about it.
 *
 * WHY THIS IS A SEPARATE, PURE FUNCTION
 *
 * An operator part-way through a recovery is asking three things at once: what
 * has landed, whether that was enough, and what is still available if it was
 * not. Those are arithmetic questions with exact answers, and the arithmetic is
 * easy to get subtly wrong — so it lives here, tested, rather than inside a
 * route or a component where it would be invisible.
 *
 * WHAT IS COMPARED, AND WHY IT IS NOT CASH
 *
 * The comparison is the PROJECTED LOW against the safe floor, never today's
 * balance against it. Cash in the bank right now says nothing about whether
 * payroll clears on the 5th: a business can hold plenty today and still breach
 * its floor next week, which is the entire reason this product exists. Judging
 * safety on current cash would call that business safe on exactly the days it
 * most needs a warning.
 *
 * A NOTE ON "ENOUGH"
 *
 * Outstanding links are money that MIGHT arrive, and they are reported as
 * exactly that. They are never added to the projection, never counted as
 * closing the gap, and never allowed to move the status to SAFE. Treating an
 * unpaid link as cash is the same error as banking an overdue receivable — it
 * flatters the numbers in the one direction that gets a company into trouble.
 */

export type SafetyStatus = "SAFE" | "SHORTFALL";

export interface SafetyProgressInput {
  /** Lowest projected closing balance across the horizon, in paise. */
  projectedLow: number;
  /** The recommended floor this business should not dip below, in paise. */
  safeFloor: number;
  /** Money already recovered and settled, in paise. */
  recovered: number;
  /** Money represented by payment links issued but not yet paid, in paise. */
  outstanding: number;
}

export interface SafetyProgress {
  status: SafetyStatus;
  projectedLow: number;
  safeFloor: number;
  recovered: number;
  outstanding: number;
  /** How far below the floor the projection still dips. Zero when safe. */
  shortfall: number;
  /** Whether the links already issued would, if all paid, close the gap. */
  outstandingCoversShortfall: boolean;
  /** What is still needed BEYOND every outstanding link. Zero when covered. */
  stillNeededBeyondOutstanding: number;
  /** One line, safe to render as a heading. */
  headline: string;
  /** One or two sentences a non-specialist can act on. */
  detail: string;
}

export function describeSafetyProgress(input: SafetyProgressInput): SafetyProgress {
  const { projectedLow, safeFloor, recovered, outstanding } = input;

  // Clamped: a projection comfortably above the floor produces a negative
  // difference, and a "shortfall of minus three lakh" is not a thing.
  const shortfall = Math.max(0, safeFloor - projectedLow);
  const status: SafetyStatus = shortfall === 0 ? "SAFE" : "SHORTFALL";

  const outstandingCoversShortfall = shortfall > 0 && outstanding >= shortfall;
  const stillNeededBeyondOutstanding = Math.max(0, shortfall - outstanding);

  if (status === "SAFE") {
    return {
      status,
      projectedLow,
      safeFloor,
      recovered,
      outstanding,
      shortfall: 0,
      outstandingCoversShortfall: false,
      stillNeededBeyondOutstanding: 0,
      headline: "You are above your safe floor",
      detail:
        recovered > 0
          ? "The money you recovered was enough. Your lowest projected balance now stays above the floor you set, so there is nothing further you need to do."
          : "Your lowest projected balance stays above the floor you set across this window, so there is nothing you need to do.",
    };
  }

  if (outstandingCoversShortfall) {
    return {
      status,
      projectedLow,
      safeFloor,
      recovered,
      outstanding,
      shortfall,
      outstandingCoversShortfall,
      stillNeededBeyondOutstanding: 0,
      headline: "Not there yet — but the links you have out would cover it",
      detail:
        "Your projection still dips below your safe floor. The payment links already issued are worth more than the gap, so if they are paid you are clear. Nothing new needs to be created.",
    };
  }

  return {
    status,
    projectedLow,
    safeFloor,
    recovered,
    outstanding,
    shortfall,
    outstandingCoversShortfall,
    stillNeededBeyondOutstanding,
    headline: "More is needed to clear your safe floor",
    detail:
      outstanding > 0
        ? "Your projection still dips below your safe floor, and the links already issued are not worth enough to close it on their own. The options below can make up the difference."
        : "Your projection dips below your safe floor and nothing is currently out for collection. The options below are what is available to close it.",
  };
}
