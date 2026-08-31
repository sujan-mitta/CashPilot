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

import {
  verificationCanBeRequired,
  loginRequiresVerification,
  VERIFICATION_REQUIRED_FROM,
} from "../verificationPolicy";
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

describe("An account is never barred over a rule that postdates it", () => {
  const before = new Date(VERIFICATION_REQUIRED_FROM.getTime() - 86_400_000);
  const after = new Date(VERIFICATION_REQUIRED_FROM.getTime() + 86_400_000);

  beforeEach(() => resolveMailerProvider.mockReturnValue("SMTP"));

  it("lets a pre-existing unverified account sign in", () => {
    // These were created when signup asked for no code, and many sit on
    // addresses that were never deliverable — mittal@company.com among them,
    // which owns the primary demo ledger. Barring them leaves no way back in:
    // the only route is a code to the address that does not work.
    expect(loginRequiresVerification({ createdAt: before, emailVerified: null })).toBe(false);
  });

  it("bars a NEW unverified account", () => {
    // Otherwise the signup step is bypassable: register, skip the code, sign in
    // instead.
    expect(loginRequiresVerification({ createdAt: after, emailVerified: null })).toBe(true);
  });

  it("treats the cutoff instant itself as requiring verification", () => {
    expect(
      loginRequiresVerification({ createdAt: VERIFICATION_REQUIRED_FROM, emailVerified: null })
    ).toBe(true);
  });

  it("never bars an account that is already verified", () => {
    for (const createdAt of [before, after]) {
      expect(loginRequiresVerification({ createdAt, emailVerified: new Date() })).toBe(false);
    }
  });

  it("bars nobody when no mailer is configured", () => {
    resolveMailerProvider.mockReturnValue("LOCAL_SANDBOX");
    expect(loginRequiresVerification({ createdAt: after, emailVerified: null })).toBe(false);
  });

  it("still refuses to MAIL a grandfathered account", () => {
    // The whole point of the cutoff is that it relaxes sign-in and nothing
    // else. If it leaked into the send decision, the dispatcher would start
    // mailing dead addresses again — the exact bounce this feature exists to
    // stop, reintroduced by the fix for it.
    expect(loginRequiresVerification({ createdAt: before, emailVerified: null })).toBe(false);
    expect(evaluateRecipient({ email: "mittal@company.com", emailVerified: null }).sendable).toBe(
      false
    );
  });
});
