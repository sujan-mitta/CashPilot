import { describe, it, expect, vi } from "vitest";
import {
  classifyProviderError,
  describeProviderError,
  ProviderRejectedError,
  ProviderIndeterminateError,
  ProviderDuplicateError,
} from "../client";
import { interpretScan, scanForReference } from "../../execution/providerReconciliation";
import { FINANCIAL_CONFIG } from "../../engine/financialConfig";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/**
 * ===========================================================================
 * PROVIDER CONTRACT TESTS  (Phase 17 PART 17)
 * ===========================================================================
 *
 * Three clearly separated tiers. Read the tier label before believing a claim.
 *
 *   A. PURE          - logic only, no provider concepts
 *   B. RECORDED-LIVE - replays error/response shapes CAPTURED FROM THE REAL
 *                      Razorpay test account during Phase 17 certification.
 *                      These are not invented fixtures; they are transcripts.
 *   C. LIVE          - actually calls the Razorpay test account. Gated on
 *                      RAZORPAY_LIVE_TEST=1 so they never run by accident, and
 *                      they FAIL LOUDLY (never silently skip) if the flag is
 *                      set but credentials are missing or are live-mode keys.
 *
 * A recorded-live fixture is evidence that our PARSING is right. It is not
 * evidence that the provider still behaves that way. Only tier C is that.
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
const REAL_ERRORS = {
  duplicateReference: {
    statusCode: 400,
    error: {
      code: "BAD_REQUEST_ERROR",
      description:
        "payment link with given reference_id: cp_phase17_dup_mt5wt6z8 already exists. Please create a payment link with a different reference_id",
      source: null,
      step: null,
      reason: null,
      field: null,
    },
    // Observed live: the SDK leaves `message` EMPTY on every error.
    message: "",
  },
  negativeAmount: {
    statusCode: 400,
    error: {
      code: "BAD_REQUEST_ERROR",
      description:
        "amount: amount should be minimum 1.00 for INR; first_min_partial_amount: 0 must be less than or equal to -500.",
      field: null,
    },
    message: "",
  },
  invalidAuth: {
    statusCode: 401,
    error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" },
    message: "",
  },
  notFound: {
    statusCode: 404,
    error: undefined,
    message: "",
  },
  rateLimited: {
    statusCode: 429,
    error: { code: "BAD_REQUEST_ERROR", description: "Too many requests" },
    message: "",
  },
};

/** A payment-link entity exactly as the live API returned it. */
const REAL_LINK = {
  id: "plink_TTFNCrlMdjokHY",
  reference_id: "cp_phase17_adapter_mt5wwydi",
  status: "created",
  amount: 100000,
  amount_paid: 0,
  currency: "INR",
  created_at: 1787495915,
  short_url: "https://rzp.io/rzp/example",
};

// ===========================================================================
describe("TIER B (recorded-live) - error classification against real shapes", () => {
  it("extracts a non-empty reason even though message is empty", () => {
    // This is the defect Phase 17 found: every real error carries message === "".
    expect(REAL_ERRORS.negativeAmount.message).toBe("");
    const text = describeProviderError(REAL_ERRORS.negativeAmount);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("amount should be minimum");
    expect(text).toContain("BAD_REQUEST_ERROR");
  });

  it("classifies a duplicate reference as DUPLICATE, never as a plain failure", () => {
    const c = classifyProviderError(REAL_ERRORS.duplicateReference);
    expect(c).toBeInstanceOf(ProviderDuplicateError);
    expect(c).not.toBeInstanceOf(ProviderRejectedError);
    expect((c as ProviderDuplicateError).referenceId).toBe("cp_phase17_dup_mt5wt6z8");
  });

  it("classifies a 400 validation error as a definite rejection", () => {
    const c = classifyProviderError(REAL_ERRORS.negativeAmount);
    expect(c).toBeInstanceOf(ProviderRejectedError);
    expect((c as ProviderRejectedError).statusCode).toBe(400);
  });

  it("classifies a 401 as a definite rejection - nothing was created", () => {
    expect(classifyProviderError(REAL_ERRORS.invalidAuth)).toBeInstanceOf(ProviderRejectedError);
  });

  it("classifies a 404 as a definite rejection", () => {
    expect(classifyProviderError(REAL_ERRORS.notFound)).toBeInstanceOf(ProviderRejectedError);
  });

  it("classifies a 429 as INDETERMINATE - the request may have landed", () => {
    const c = classifyProviderError(REAL_ERRORS.rateLimited);
    expect(c).toBeInstanceOf(ProviderIndeterminateError);
    expect(c).not.toBeInstanceOf(ProviderRejectedError);
  });

  it("a 404 still produces a usable message despite an absent error object", () => {
    expect(describeProviderError(REAL_ERRORS.notFound)).toMatch(/HTTP 404/);
  });

  it("error.code is NOT a reliable discriminator - 401 also reports BAD_REQUEST_ERROR", () => {
    // Observed live. This is why statusCode is used instead.
    expect(REAL_ERRORS.invalidAuth.error.code).toBe(REAL_ERRORS.negativeAmount.error.code);
    expect(classifyProviderError(REAL_ERRORS.invalidAuth)).toBeInstanceOf(ProviderRejectedError);
  });
});

// ===========================================================================
describe("TIER B (recorded-live) - reconciliation against real entity shape", () => {
  it("maps a real 'created' link to PENDING, not success", () => {
    const v = interpretScan(REAL_LINK.reference_id, { found: REAL_LINK, exhaustive: true });
    expect(v.status).toBe("PENDING");
    expect(v.retrySafe).toBe(false);
    expect(v.providerReference).toBe(REAL_LINK.id);
  });

  it("maps a 'paid' link to CONFIRMED_SUCCESS", () => {
    const v = interpretScan(REAL_LINK.reference_id, {
      found: { ...REAL_LINK, status: "paid", amount_paid: REAL_LINK.amount },
      exhaustive: true,
    });
    expect(v.status).toBe("CONFIRMED_SUCCESS");
  });

  it("maps 'cancelled' and 'expired' to a failure that is NOT retry safe", () => {
    for (const status of ["cancelled", "expired"]) {
      const v = interpretScan(REAL_LINK.reference_id, {
        found: { ...REAL_LINK, status },
        exhaustive: true,
      });
      expect(v.status).toBe("CONFIRMED_FAILURE");
      // The link exists; re-issuing would create a second one.
      expect(v.retrySafe).toBe(false);
    }
  });

  it("never binds a different reference to our intent", async () => {
    const scan = await scanForReference("cp_MINE", { fromUnix: 0, toUnix: 1 }, async () => [
      { ...REAL_LINK, reference_id: "cp_THEIRS" },
    ]);
    expect(scan.found).toBeNull();
    expect(interpretScan("cp_MINE", scan).providerReference).toBeUndefined();
  });
});

// ===========================================================================
describe("TIER B (recorded-live) - provider list eventual consistency", () => {
  /**
   * VERIFIED_LIVE (Phase 18). Measured against the real test account:
   *   fetch(id)  saw a new link at +1.0s
   *   all()      did NOT contain it at +1.8s
   *   all()      contained it at +6.0s
   *
   * Concluding NOT_FOUND inside that window marks a LIVE payment link as
   * never-created and sets retrySafe, which is how one debt gets two links.
   */
  const SETTLING = FINANCIAL_CONFIG.PROVIDER_LIST_SETTLING_MS;

  it("absence inside the settling period is UNKNOWN, never NOT_FOUND", () => {
    const now = new Date();
    const justNow = new Date(now.getTime() - 2000); // 2s old, inside the lag
    const v = interpretScan("cp_x", { found: null, exhaustive: true }, now, justNow);
    expect(v.status).toBe("UNKNOWN");
    expect(v.retrySafe).toBe(false);
    expect(v.reason).toMatch(/eventually consistent/i);
  });

  it("absence outside the settling period but inside cooling window is UNKNOWN", () => {
    const now = new Date();
    const old = new Date(now.getTime() - SETTLING - 1000);
    const v = interpretScan("cp_x", { found: null, exhaustive: true }, now, old);
    expect(v.status).toBe("UNKNOWN");
    expect(v.retrySafe).toBe(false);
  });

  it("absence outside the 24-hour cooling window is provable as NOT_FOUND", () => {
    const now = new Date();
    const olderThanCooling = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25h old
    const v = interpretScan("cp_x", { found: null, exhaustive: true }, now, olderThanCooling);
    expect(v.status).toBe("NOT_FOUND");
    expect(v.retrySafe).toBe(true);
  });

  it("the settling period exceeds the largest observed lag by a wide margin", () => {
    // Largest lag observed live was ~6s.
    expect(SETTLING).toBeGreaterThanOrEqual(30000);
  });

  it("a FOUND link is unaffected by the settling period", () => {
    const now = new Date();
    const justNow = new Date(now.getTime() - 1000);
    const v = interpretScan(
      "cp_x",
      { found: { id: "plink_1", reference_id: "cp_x", status: "paid" }, exhaustive: true },
      now,
      justNow
    );
    expect(v.status).toBe("CONFIRMED_SUCCESS");
  });

  it("without a recorded time the conservative path is unchanged", () => {
    // No age supplied: behaviour must not silently become permissive.
    const v = interpretScan("cp_x", { found: null, exhaustive: false });
    expect(v.status).toBe("UNKNOWN");
    expect(v.retrySafe).toBe(false);
  });
});

// ===========================================================================
// TIER C - real network calls. Gated, and loud when misconfigured.
// ===========================================================================
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
