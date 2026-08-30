import { describe, it, expect } from "vitest";
// Only the error classes are needed statically. Everything else is imported
// dynamically inside each test, deliberately: the tier must load the client
// AFTER the live credentials are in the environment, not when this file parses.
import { ProviderIndeterminateError, ProviderDuplicateError } from "../client";

/**
 * TIER C — the LIVE provider certification tier.
 *
 * Split into its own `.live.test.ts` file rather than living behind
 * `it.skipIf` inside the main contract suite. Same safety, better reporting:
 * the default vitest config excludes `*.live.test.ts` entirely, so an ordinary
 * `npm test` finishes with ZERO skipped tests instead of five permanently
 * greyed-out lines that every reader has to re-establish are intentional.
 *
 * `npm run test:live` includes this file and runs it against the real Razorpay
 * TEST account. It fails loudly, never silently, if the flag is set without
 * credentials or with live-mode keys.
 */

const LIVE = process.env.RAZORPAY_LIVE_TEST === "1";

/**
 * Spaces out real link creations so the tier certifies the provider CONTRACT
 * rather than its rate limiter.
 *
 * Three of the tests below create a payment link, and vitest runs them back to
 * back - three creates inside about a second. Razorpay's test mode answers that
 * with HTTP 429, which `classifyProviderError` correctly turns into a
 * ProviderIndeterminateError, so the tests failed with "Too many requests"
 * instead of the contract assertion they exist to make. Observed across
 * repeated runs: 1-3 failures per run, always from the creating tests, never
 * the same set twice.
 *
 * A 429 is a real provider behaviour and tier B already pins how we classify
 * it. Deliberately provoking it here just makes the suite unreliable.
 */
const pace = async (ms = 2500) => {
  if (LIVE) await new Promise((r) => setTimeout(r, ms));
};

/**
 * Retries a live creation past provider THROTTLING only.
 *
 * Razorpay's test mode rate-limits an account that is creating links quickly -
 * repeated suite runs reliably provoke HTTP 429. `classifyProviderError` turns
 * that into a ProviderIndeterminateError, which is correct and is already
 * pinned by tier B, but it made this tier fail on the account being busy rather
 * than on the contract being wrong. Measured across consecutive runs before
 * this: 1-3 failures per run, always the creating tests, always 429.
 *
 * ONLY an indeterminate (429/5xx/timeout) is retried. A ProviderRejectedError
 * or ProviderDuplicateError is a real verdict about the request and is
 * rethrown immediately - retrying those would hide exactly what we certify.
 */
async function createPastThrottle<T>(attempt: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof ProviderIndeterminateError)) throw err;
      last = err;
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// TIER B FIXTURES - verbatim shapes observed against the real test account
// on the Phase 17 certification run. Do not "tidy" these.
// ---------------------------------------------------------------------------

describe("TIER C (LIVE) - real Razorpay test account", () => {
  it("live credentials are test-mode and present when live testing is requested", () => {
    if (!LIVE) {
      // Not a silent skip: the assertion documents why nothing ran.
      expect(process.env.RAZORPAY_LIVE_TEST).not.toBe("1");
      return;
    }
    const key = process.env.RAZORPAY_KEY_ID ?? "";
    expect(key, "RAZORPAY_LIVE_TEST=1 but RAZORPAY_KEY_ID is missing").not.toBe("");
    expect(key.startsWith("rzp_live_"), "REFUSING: live-mode key in a test run").toBe(false);
    expect(key.startsWith("rzp_test_"), "RAZORPAY_KEY_ID must be a rzp_test_ key").toBe(true);
    expect(process.env.RAZORPAY_KEY_SECRET ?? "").not.toBe("");
  });

  it.skipIf(!LIVE)("creates a link and round-trips reference_id", async () => {
    const { createRecoveryPaymentLink, reconcilePaymentLink } = await import("../client");
    await pace();
    const ref = `cp_phase17_ct_${Date.now().toString(36)}`;
    const recordedAt = new Date();

    const link = await createPastThrottle(() => createRecoveryPaymentLink(100000, "contract test", ref));
    expect(link.id).toMatch(/^plink_/);
    expect(link.status).toBe("created");

    // Immediately after creation the provider's LIST endpoint has not caught up
    // (VERIFIED_LIVE: ~2-6s lag). Absence here must NOT be read as absence.
    const immediate = await reconcilePaymentLink(
      ref, { from: recordedAt, to: new Date() }, new Date(), recordedAt
    );
    expect(immediate.status).not.toBe("NOT_FOUND");
    expect(immediate.retrySafe).toBe(false);

    // Once the list catches up, the link must be found and bound correctly.
    await new Promise((r) => setTimeout(r, 12000));
    const settled = await reconcilePaymentLink(
      ref, { from: recordedAt, to: new Date() }, new Date(), recordedAt
    );
    expect(settled.status).toBe("PENDING");
    expect(settled.providerReference).toBe(link.id);
    expect(settled.searchExhaustive).toBe(true);
  }, 90000);

  it.skipIf(!LIVE)("rejects a duplicate reference_id", async () => {
    const { createRecoveryPaymentLink } = await import("../client");
    await pace();
    const ref = `cp_phase17_ctdup_${Date.now().toString(36)}`;
    await createPastThrottle(() => createRecoveryPaymentLink(100000, "contract dup", ref));

    // Retry only if the provider throttles; a ProviderDuplicateError is the
    // verdict under test and propagates on the first occurrence.
    let duplicateError: unknown;
    let throttled: ProviderIndeterminateError | undefined;
    for (let i = 0; i < 4; i++) {
      try {
        await createRecoveryPaymentLink(100000, "contract dup", ref);
        duplicateError = new Error("second create was accepted; expected a duplicate rejection");
        break;
      } catch (err) {
        if (err instanceof ProviderIndeterminateError) {
          throttled = err;
          await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
          continue;
        }
        duplicateError = err;
        break;
      }
    }

    // Say what actually happened. Falling through with `duplicateError` unset
    // asserted "expected undefined to be an instance of ProviderDuplicateError",
    // which reads like a contract break when the real cause is an exhausted
    // account - and sends the reader looking in entirely the wrong place.
    expect(
      throttled === undefined || duplicateError !== undefined,
      `provider still throttling after 4 attempts (${throttled?.message}); the account is rate-limited, not the contract broken - re-run once it has settled`
    ).toBe(true);

    expect(duplicateError).toBeInstanceOf(ProviderDuplicateError);
  }, 60000);

  it.skipIf(!LIVE)("does NOT report NOT_FOUND for a link it just created", async () => {
    // The Phase 18 defect, as a live regression test.
    const { createRecoveryPaymentLink, reconcilePaymentLink } = await import("../client");
    await pace();
    const ref = `cp_phase18_reg_${Date.now().toString(36)}`;
    const recordedAt = new Date();
    const link = await createPastThrottle(() => createRecoveryPaymentLink(100000, "settling regression", ref));
    expect(link.id).toMatch(/^plink_/);

    const immediate = await reconcilePaymentLink(ref, { from: recordedAt, to: new Date() }, new Date(), recordedAt);
    expect(immediate.status).not.toBe("NOT_FOUND");
    expect(immediate.retrySafe).toBe(false);
  }, 60000);

  it.skipIf(!LIVE)("a missing reference stays UNKNOWN inside the 24h cooling-off window", async () => {
    const { reconcilePaymentLink } = await import("../client");
    // Ten minutes old: the paged scan completes and finds nothing, but the
    // implemented policy refuses to call that proven absence for 24 hours.
    const from = new Date(Date.now() - 10 * 60 * 1000);
    const verdict = await reconcilePaymentLink(
      `cp_phase20_ghost_${Date.now()}`,
      { from, to: new Date() },
      new Date(),
      from
    );

    // The scan itself must genuinely have completed - otherwise this test would
    // pass for the wrong reason (an errored scan also yields UNKNOWN).
    expect(verdict.searchExhaustive).toBe(true);
    expect(verdict.status).toBe("UNKNOWN");
    expect(verdict.retrySafe).toBe(false);
    expect(verdict.providerReference).toBeUndefined();
  }, 60000);

  it.skipIf(!LIVE)("returns retry-safe NOT_FOUND once past the cooling-off window", async () => {
    const { reconcilePaymentLink } = await import("../client");
    // Aged past 24 hours: absence is now treated as proven.
    const from = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const verdict = await reconcilePaymentLink(
      `cp_phase20_ghost_old_${Date.now()}`,
      { from, to: new Date() },
      new Date(),
      from
    );

    expect(verdict.searchExhaustive).toBe(true);
    expect(verdict.status).toBe("NOT_FOUND");
    expect(verdict.retrySafe).toBe(true);
    expect(verdict.providerReference).toBeUndefined();
  }, 60000);
});
