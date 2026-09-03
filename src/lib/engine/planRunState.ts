/**
 * Whether the plan on screen can still be run.
 *
 * THE BUG THIS CLOSES
 *
 * The execution page offered "Begin Approved Execution" for a decision that had
 * already executed. The state machine refused, correctly, and the operator was
 * told the plan "has already run" only AFTER pressing a button that promised
 * the opposite — beside a heading reading "Awaiting Execution" for something
 * that was not awaiting anything.
 *
 * The API already returned the decision's status. The page simply never looked
 * at it, so its idea of progress came from what THIS browser session had done
 * rather than from what actually happened.
 *
 * WHY A TABLE RATHER THAN "STATUS === APPROVED"
 *
 * Ten statuses exist and they do not divide neatly. A plan can be un-runnable
 * because it already ran, because it was rejected, or because it is mid-flight
 * — and an operator needs to be told which, since only one of those is a
 * reason to go and build a new plan.
 */

export type PlanRunnability = "RUNNABLE" | "ALREADY_RUN" | "REFUSED" | "IN_FLIGHT" | "UNKNOWN";

export interface PlanRunState {
  runnability: PlanRunnability;
  canRun: boolean;
  heading: string;
  detail: string;
}

export function describePlanRunState(decisionStatus: string | null | undefined): PlanRunState {
  switch (decisionStatus) {
    case "GENERATED":
    case "PRESENTED":
    case "APPROVED":
      return {
        runnability: "RUNNABLE",
        canRun: true,
        heading: "Plan approved and awaiting execution",
        detail:
          "This strategy is authorised by human review. Running it issues test-mode payment links through Razorpay.",
      };

    case "EXECUTED":
    case "RECONCILED":
    case "OUTCOME_MEASURED":
      return {
        runnability: "ALREADY_RUN",
        canRun: false,
        heading: "This plan has already run",
        detail:
          "Its payment links were issued and it cannot be run a second time — doing so would ask the same customers to pay twice. If you still need to close a gap, build a new plan from the dashboard using your current figures.",
      };

    case "RECONCILIATION_MISMATCH":
      return {
        runnability: "ALREADY_RUN",
        canRun: false,
        heading: "This plan ran, and what settled did not match",
        detail:
          "It cannot be run again. The amounts recorded here disagree with what the provider reported, so the difference needs looking at before anything further is decided.",
      };

    case "REJECTED":
    case "NOT_EXECUTED":
      return {
        runnability: "REFUSED",
        canRun: false,
        heading: "This plan was not run",
        detail:
          "It was rejected or abandoned rather than executed, and cannot be started from here. Build a new plan from the dashboard.",
      };

    case "NOT_RECONCILED":
      return {
        runnability: "IN_FLIGHT",
        canRun: false,
        heading: "This plan is still settling",
        detail:
          "Its links were issued and the outcome is not yet established. Running it again would issue duplicates for money that may already be on its way.",
      };

    default:
      // A decision that predates status tracking, or a response that did not
      // carry one. Left runnable rather than blocked: the state machine is the
      // real authority and will refuse if it must, whereas guessing "blocked"
      // here would strand a perfectly good plan behind a screen with no button.
      return {
        runnability: "UNKNOWN",
        canRun: true,
        heading: "Plan approved and awaiting execution",
        detail:
          "This strategy is authorised by human review. Running it issues test-mode payment links through Razorpay.",
      };
  }
}
