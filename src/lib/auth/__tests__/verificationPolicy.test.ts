import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Whether verification may be REQUIRED, as opposed to whether an alert may be
 * SENT.
 *
 * These are different questions and conflating them is how a safety feature
 * becomes an outage. Requiring a code is only defensible when a code can
 * actually arrive; with no mail provider configured the mailer runs in its
 * local sandbox, reports success, and sends nothing. Barring sign-in in that
 * state locks every account out permanently, and nobody can fix it from inside
 * the product because the only route back in is the email that never comes.
 */

const resolveMailerProvider = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notifications/mailer", () => ({ resolveMailerProvider }));

import { verificationCanBeRequired } from "../verificationPolicy";
import { evaluateRecipient } from "@/lib/notifications/recipientEligibility";

beforeEach(() => resolveMailerProvider.mockReset());
afterEach(() => vi.clearAllMocks());

describe("Verification is only required when a code can arrive", () => {
  it("is required when a real provider is configured", () => {
    for (const provider of ["SMTP", "RESEND"]) {
      resolveMailerProvider.mockReturnValue(provider);
      expect(verificationCanBeRequired()).toBe(true);
    }
  });

  it("stands down when the mailer is the local sandbox", () => {
    // The sandbox reports success and sends nothing. Demanding a code here
    // denies every sign-in with no recovery path.
    resolveMailerProvider.mockReturnValue("LOCAL_SANDBOX");
    expect(verificationCanBeRequired()).toBe(false);
  });
});

describe("Standing down does not weaken the thing it protects", () => {
  it("still refuses to email an unverified address in the sandbox", () => {
    // The point of verification is to stop mail reaching addresses that do not
    // exist. Relaxing the SIGN-IN gate must not relax the SEND gate — those are
    // separate decisions, and only one of them can lock a user out.
    resolveMailerProvider.mockReturnValue("LOCAL_SANDBOX");
    expect(verificationCanBeRequired()).toBe(false);
    expect(evaluateRecipient({ email: "a@b.com", emailVerified: null }).sendable).toBe(false);
  });

  it("a deployment that sends nothing cannot produce a bounce", () => {
    // Which is why standing down costs nothing that matters: there is no
    // outbound mail to bounce in the first place.
    resolveMailerProvider.mockReturnValue("LOCAL_SANDBOX");
    expect(evaluateRecipient({ email: "a@b.com", emailVerified: new Date() }).sendable).toBe(true);
  });
});
