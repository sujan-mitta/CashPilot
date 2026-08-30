/**
 * Presentation helpers for the execution timeline.
 *
 * These were named exports on `page.tsx` so they could be tested. A Next page
 * may only export a default plus a fixed set of route fields, so the generated
 * route types rejected them on every dev build — a standing typecheck error for
 * what was only a placement mistake. They are pure string helpers, so they move
 * cleanly.
 */

export const ACTION_LABEL: Record<string, string> = {
  RECOVER_FAILED_PAYMENTS: "failed payment recovery link",
  PRIORITIZE_COLLECTIONS: "overdue collection payment links",
  RESCHEDULE_PAYOUT: "supplier payout reschedule",
  PAUSE_EXPENSE: "subscription pause",
};

/**
 * One timeline line, derived from the step's REAL status.
 *
 * Every line used to end in "successfully" no matter what came back, so a
 * FAILED or EXECUTION_UNKNOWN step was announced as a success on the screen
 * where money moves - the exact opposite of what the operator needs to see.
 */
export function timelineLineFor(step: {
  action: string;
  status: string;
  result?: string;
}): string {
  const what = ACTION_LABEL[step.action] ?? step.action;

  switch (step.status) {
    case "COMPLETED":
    case "EXECUTED":
      return `Completed: ${what}.`;
    case "EXECUTING":
    case "RECONCILING":
      return `Issued: ${what}. Awaiting settlement - the money has not arrived yet.`;
    case "EXECUTION_UNKNOWN":
      return `UNDETERMINED: ${what} may or may not have taken effect. Verify at the provider before retrying.`;
    case "RECONCILIATION_MISMATCH":
      return `Mismatch: ${what} settled, but not for the amount expected.`;
    case "FAILED":
    case "RECONCILIATION_FAILED":
      return `Did not run: ${what}.${step.result ? ` ${step.result}` : ""}`;
    default:
      return `${what}: ${step.status}.`;
  }
}

/** Headline for a refused execution, from the API's own error code. */
export function executionErrorTitle(data: { error?: string }): string {
  switch (data?.error) {
    case "STRATEGY_STALE":
      return "Your figures moved since this plan was made";
    case "STATE_DRIFT_DETECTED":
      return "Your cash position has changed too much";
    case "FINANCIAL_CONFIGURATION_INVALID":
      return "This deployment is not configured to move money";
    case "PARAMETER_TAMPERING":
      return "This plan contains an invalid amount";
    case "REJECTED_ACTION_EXECUTION":
      return "This plan was already rejected";
    default:
      return "Could not run this plan";
  }
}

/** The detail the API supplied, or a status-appropriate fallback. */
export function executionErrorDetail(
  data: { message?: string; missing?: string[]; changes?: { field?: string }[] },
  httpStatus: number
): string {
  if (typeof data?.message === "string" && data.message) return data.message;
  if (Array.isArray(data?.missing) && data.missing.length > 0) {
    return `Missing configuration: ${data.missing.join(", ")}.`;
  }
  if (httpStatus === 409) return "This plan can no longer run in its current state.";
  if (httpStatus === 401) return "Your session has expired. Sign in again.";
  return "Something went wrong on our side.";
}
