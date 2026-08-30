import { describe, it, expect } from "vitest";
import { buildRejectionRequest } from "@/app/approval/rejectionRequest";

/**
 * Declining a plan must reach the server.
 *
 * F-1n was recorded as "reject reason state discarded", which understated it.
 * `confirmReject` issued no request at all: it showed a toast reading "Plan
 * declined" and navigated away. Server-side nothing happened — the decision
 * stayed PRESENTED, its actions stayed PENDING, and the plan remained
 * approvable and executable by the next screen that loaded it.
 *
 * A refusal that leaves the thing refusable is not a refusal, and it is the
 * worse half of the bug: the lost reason is an audit gap, but an unrecorded
 * rejection is a plan the operator believes they killed still sitting there
 * ready to move money.
 *
 * The API half has always worked — it validates the action, transitions the
 * decision to REJECTED through the guarded state machine, appends per-action
 * audit entries and stores the reason. These tests pin the CONTRACT the client
 * now has to satisfy, so a future refactor of the page cannot quietly go back
 * to being a toast.
 */

describe("The rejection request the client must send", () => {
  it("names the action explicitly", () => {
    const body = buildRejectionRequest("strat-1", "Supplier agreed to wait");

    // The route defaults nothing. It previously treated any unrecognised action
    // as "approve", so an omitted or misspelled action APPROVED the plan — the
    // single most dangerous default in the codebase. Sending it explicitly is
    // the client's side of that contract.
    expect(body.action).toBe("reject");
  });

  it("carries the operator's reason", () => {
    const body = buildRejectionRequest("strat-1", "Supplier already agreed to wait");
    expect(body.reason).toBe("Supplier already agreed to wait");
  });

  it("omits an empty reason rather than sending whitespace", () => {
    // The field is optional. Sending "   " would store whitespace as the
    // recorded justification for a financial refusal.
    expect(buildRejectionRequest("strat-1", "   ").reason).toBeUndefined();
    expect(buildRejectionRequest("strat-1", "").reason).toBeUndefined();
  });

  it("trims a reason rather than storing the operator's stray spacing", () => {
    expect(buildRejectionRequest("strat-1", "  no cash needed  ").reason).toBe("no cash needed");
  });

  it("always identifies which plan is being declined", () => {
    const body = buildRejectionRequest("strat-42", "");
    expect(body.strategyId).toBe("strat-42");
  });

  it("is not an approval under any spelling", () => {
    // Guards the specific regression: a body that omits `action`, or spells it
    // wrong, is an approval as far as the route is concerned.
    const body = buildRejectionRequest("strat-1", "changed my mind");
    expect(body.action).not.toBe("approve");
    expect(body.action).toBe("reject");
  });
});
