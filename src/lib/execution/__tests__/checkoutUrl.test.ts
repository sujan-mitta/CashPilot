import { describe, it, expect, vi } from "vitest";
import { withActionId } from "../actionExecutors";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/**
 * REGRESSION: a PAYMENT_PENDING recovery was handed to the operator as
 *   https://rzp.io/rzp/ehhZEa0&actionId=cmt4nhg7v000nwouknug0rsys
 * observed live in the database. `&` was appended unconditionally, so a
 * provider short_url - which carries no query string - gained a longer PATH
 * rather than a parameter, and the link 404s.
 *
 * It was also self-perpetuating: the old guard skipped any URL that already
 * contained "actionId=", so a corrupted value was never repaired and every
 * later action re-served the same dead link.
 */
describe("withActionId", () => {
  const ACTION = "action-123";

  it("uses ? on a provider short_url that has no query string", () => {
    expect(withActionId("https://rzp.io/rzp/ehhZEa0", ACTION)).toBe(
      `https://rzp.io/rzp/ehhZEa0?actionId=${ACTION}`
    );
  });

  it("uses & on our own checkout URL, which already has a query string", () => {
    expect(withActionId("/sandbox/checkout?paymentLinkId=plink_1", ACTION)).toBe(
      `/sandbox/checkout?paymentLinkId=plink_1&actionId=${ACTION}`
    );
  });

  it("leaves a correctly-formed URL that already carries an actionId alone", () => {
    const url = "/sandbox/checkout?paymentLinkId=plink_1&actionId=other-action";
    expect(withActionId(url, ACTION)).toBe(url);
  });

  it("repairs the exact corrupted value found in the database", () => {
    expect(
      withActionId("https://rzp.io/rzp/ehhZEa0&actionId=cmt4nhg7v000nwouknug0rsys", ACTION)
    ).toBe("https://rzp.io/rzp/ehhZEa0?actionId=cmt4nhg7v000nwouknug0rsys");
  });

  it("produces a URL whose path is the untouched provider link", () => {
    // The whole point: the payment link itself must survive intact.
    const parsed = new URL(withActionId("https://rzp.io/rzp/ehhZEa0", ACTION));
    expect(parsed.pathname).toBe("/rzp/ehhZEa0");
    expect(parsed.searchParams.get("actionId")).toBe(ACTION);
  });

  it("passes an absent URL through without inventing one", () => {
    expect(withActionId(null, ACTION)).toBe("");
    expect(withActionId("", ACTION)).toBe("");
  });
});
