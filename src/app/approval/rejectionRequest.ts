/**
 * The request body the approval screen sends when an operator declines a plan.
 *
 * Extracted from the page so it can be tested as production code rather than
 * re-described in a test. The shape matters more than it looks:
 *
 *  - `action` is sent EXPLICITLY. The route used to treat any unrecognised
 *    action as "approve", so an omitted or misspelled one approved the plan.
 *    That default is gone, but the client should still never rely on it.
 *  - `reason` is omitted rather than sent as whitespace, so a blank textarea
 *    does not store "   " as the recorded justification for a financial refusal.
 */
export interface RejectionRequest {
  strategyId: string;
  action: "reject";
  reason?: string;
}

export function buildRejectionRequest(strategyId: string, reason: string): RejectionRequest {
  const trimmed = reason.trim();
  return {
    strategyId,
    action: "reject",
    ...(trimmed ? { reason: trimmed } : {}),
  };
}
