import { describe, it, expect } from "vitest";
import { checkoutUrlFor, withActionId } from "../actionExecutors";

/**
 * Where a payer is actually sent.
 *
 * THE BUG: `createRecoveryPaymentLink` returns the provider's own `short_url`,
 * and the executor discarded it — keeping only the link id and hardcoding
 * `/sandbox/checkout?...`. With Razorpay live in TEST mode that meant a real,
 * payable link was created at the provider and nobody was ever sent to it. The
 * customer landed on our simulation page instead.
 *
 * In production it is worse than a detour. The simulation refuses to run there
 * at all — `simulatePaid` is gated on NODE_ENV, because a query parameter must
 * never be able to assert that money arrived — so the payer hit a dead end
 * while a genuine obligation to pay sat unpaid at Razorpay. Observed live as
 * "Checkout Session Failure" against a real plink_ id.
 */

const ACTION = "cmth43lp000304l0jf52gue0";
const REAL_LINK = "https://rzp.io/rzp/ehhZEa0";
const LINK_ID = "plink_TWLaeJUgCh8OfL";

describe("The provider's own URL wins", () => {
  it("uses the real checkout URL when the provider returned one", () => {
    expect(checkoutUrlFor(REAL_LINK, null, LINK_ID)).toBe(REAL_LINK);
  });

  it("never sends a real provider link to the local sandbox", () => {
    // The whole failure. A real link routed to /sandbox/checkout is a dead end
    // in production, and the money is genuinely owed at the provider.
    const url = checkoutUrlFor(REAL_LINK, null, LINK_ID);
    expect(url).not.toContain("/sandbox/checkout");
  });

  it("prefers the provider URL even over a previously stored sandbox one", () => {
    // A row written before this fix holds the wrong URL. A fresh provider
    // response is better evidence than what was stored last time.
    const stale = `/sandbox/checkout?paymentLinkId=${LINK_ID}`;
    expect(checkoutUrlFor(REAL_LINK, stale, LINK_ID)).toBe(REAL_LINK);
  });
});

describe("Falling back", () => {
  it("uses the stored URL when the provider call did not re-run", () => {
    // A duplicate create (ALREADY_SUCCEEDED) short-circuits before the provider
    // is called, so nothing fresh comes back and whatever was stored the first
    // time still stands.
    const stored = "https://rzp.io/rzp/previously";
    expect(checkoutUrlFor(null, stored, LINK_ID)).toBe(stored);
  });

  it("falls back to the sandbox path only when there is nothing else", () => {
    // Which is what the simulated provider returns as its own short_url anyway.
    expect(checkoutUrlFor(null, null, LINK_ID)).toBe(
      `/sandbox/checkout?paymentLinkId=${LINK_ID}`
    );
  });
});

describe("The action id is attached correctly to whichever URL wins", () => {
  it("uses ? on a provider URL that has no query string", () => {
    const url = withActionId(checkoutUrlFor(REAL_LINK, null, LINK_ID), ACTION);
    expect(url).toBe(`${REAL_LINK}?actionId=${ACTION}`);
    // Not a different PATH, which is what "&" on a bare URL produces.
    expect(() => new URL(url)).not.toThrow();
  });

  it("uses & on the sandbox path, which already has one", () => {
    const url = withActionId(checkoutUrlFor(null, null, LINK_ID), ACTION);
    expect(url).toBe(`/sandbox/checkout?paymentLinkId=${LINK_ID}&actionId=${ACTION}`);
  });
});
