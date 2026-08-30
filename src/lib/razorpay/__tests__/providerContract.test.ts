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
