import { describe, it, expect } from "vitest";
import { checkoutUrlFor, withActionId, resolveCheckoutUrl } from "../actionExecutors";
import { vi, beforeEach } from "vitest";

const fetchPaymentLink = vi.hoisted(() => vi.fn());
vi.mock("../../razorpay/client", () => ({
  createRecoveryPaymentLink: vi.fn(),
  fetchPaymentLink,
}));

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

describe("Re-running an action recovers the real address", () => {
  beforeEach(() => fetchPaymentLink.mockReset());

  it("asks the provider when nothing fresh or stored is available", async () => {
    // A re-run short-circuits on ALREADY_SUCCEEDED, so the dispatch never runs
    // and no fresh short_url comes back. Falling back to /sandbox/checkout for
    // a REAL link is a dead end in production, where the simulation refuses to
    // run at all. Observed live on three links at once.
    fetchPaymentLink.mockResolvedValue({ id: LINK_ID, short_url: REAL_LINK, status: "created" });

    expect(await resolveCheckoutUrl(null, null, LINK_ID)).toBe(REAL_LINK);
    // Called with the business too, so the link is looked up on the account
    // that actually issued it. Asking the wrong account returns nothing and
    // strands a payer on a link that is perfectly real.
    expect(fetchPaymentLink).toHaveBeenCalledWith(LINK_ID, undefined);
  });

  it("ignores a stored sandbox URL and asks instead", async () => {
    // Rows written before this hold the sandbox path. Trusting it would keep
    // sending payers to the dead end forever.
    fetchPaymentLink.mockResolvedValue({ id: LINK_ID, short_url: REAL_LINK, status: "created" });

    const stale = `/sandbox/checkout?paymentLinkId=${LINK_ID}`;
    expect(await resolveCheckoutUrl(null, stale, LINK_ID)).toBe(REAL_LINK);
  });

  it("does not ask when a fresh provider URL is already in hand", async () => {
    expect(await resolveCheckoutUrl(REAL_LINK, null, LINK_ID)).toBe(REAL_LINK);
    expect(fetchPaymentLink).not.toHaveBeenCalled();
  });

  it("does not ask about a simulated link", async () => {
    // plink_sim_ never existed at the provider; its sandbox URL is correct.
    const sim = "plink_sim_abc";
    expect(await resolveCheckoutUrl(null, null, sim)).toBe(
      `/sandbox/checkout?paymentLinkId=${sim}`
    );
    expect(fetchPaymentLink).not.toHaveBeenCalled();
  });

  it("keeps the sandbox path when the provider cannot answer", async () => {
    // Fails soft. Inventing an address for money that is genuinely owed would
    // be worse than an honest dead end.
    fetchPaymentLink.mockResolvedValue(null);

    expect(await resolveCheckoutUrl(null, null, LINK_ID)).toBe(
      `/sandbox/checkout?paymentLinkId=${LINK_ID}`
    );
  });

  it("prefers a stored REAL url without asking", async () => {
    const stored = "https://rzp.io/rzp/previously";
    expect(await resolveCheckoutUrl(null, stored, LINK_ID)).toBe(stored);
    expect(fetchPaymentLink).not.toHaveBeenCalled();
  });
});
