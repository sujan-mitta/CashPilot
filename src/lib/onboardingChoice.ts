/**
 * Whether this browser has already made the starting-point choice.
 *
 * The choice itself is not stored server-side, and does not need to be for the
 * case that matters. Picking sample data writes transactions, so the ledger
 * stops being empty and the fork never comes up again on its own. Only one
 * branch leaves no trace — choosing Razorpay, which deliberately keeps the
 * ledger empty — and without a marker that branch would send the user back to
 * the fork on every visit, forever.
 *
 * Keyed per business, because one account can hold several and each starts
 * separately.
 *
 * Reads and writes are wrapped: storage throws outright in some privacy modes,
 * and a thrown read here would break the dashboard. A failure is deliberately
 * treated as ALREADY CHOSEN rather than not — being unable to remember the
 * answer must not trap someone in a redirect they can never get past.
 */

const key = (businessId: string) => `cp_onboarding_choice_${businessId}`;

export function hasChosenStart(businessId: string | null | undefined): boolean {
  if (!businessId) return true;
  try {
    return localStorage.getItem(key(businessId)) === "1";
  } catch {
    return true;
  }
}

export function rememberChosenStart(businessId: string | null | undefined): void {
  if (!businessId) return;
  try {
    localStorage.setItem(key(businessId), "1");
  } catch {
    // Nothing to do. The consequence is one extra visit to the fork, which the
    // user can walk past; there is no correct way to surface this.
  }
}
