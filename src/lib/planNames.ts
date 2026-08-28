/**
 * The one place a strategy gets a human name.
 *
 * There used to be two competing schemes on the same screen: `scenarioLabel`
 * lettered the plans A-D in engine order (RECOVER_AND_COLLECT = "Scenario C"),
 * while `strategyPrettyName` lettered only the three ACTIVE plans A-C
 * (RECOVER_AND_COLLECT = "Strategy B"). So the recommended plan appeared as
 * "Scenario C" on its card and "Strategy B" in the comparison table directly
 * below it, and nothing on screen said they were the same thing.
 *
 * The letters carried no information anyone needed — they were an index into a
 * list the reader cannot see. What a person actually needs to know is what the
 * plan DOES, so that is the name.
 */

export const PLAN_NAME: Record<string, string> = {
  DO_NOTHING: "Do nothing",
  RECOVER_ONLY: "Chase the failed payment",
  RECOVER_AND_COLLECT: "Chase the failed payment + overdue invoices",
  FULL_INTERVENTION: "Chase everything + delay one supplier",
};

/** Short form, for table headers and chips where the full name will not fit. */
export const PLAN_NAME_SHORT: Record<string, string> = {
  DO_NOTHING: "Do nothing",
  RECOVER_ONLY: "Failed payment only",
  RECOVER_AND_COLLECT: "Payment + invoices",
  FULL_INTERVENTION: "Everything + delay",
};

/** One line on what the plan actually does to the business. */
export const PLAN_SUMMARY: Record<string, string> = {
  DO_NOTHING: "Change nothing and accept the shortfall.",
  RECOVER_ONLY: "Send a new payment link for the card payment that failed.",
  RECOVER_AND_COLLECT:
    "Send a new payment link, and ask overdue customers to pay early.",
  FULL_INTERVENTION:
    "All of the above, and push one low-priority supplier payment back.",
};

export function planName(name: string | undefined): string {
  if (!name) return "Unknown plan";
  return PLAN_NAME[name] ?? name;
}

export function planNameShort(name: string | undefined): string {
  if (!name) return "Unknown";
  return PLAN_NAME_SHORT[name] ?? name;
}

export function planSummary(name: string | undefined): string {
  if (!name) return "";
  return PLAN_SUMMARY[name] ?? "";
}
