import Razorpay from "razorpay";
import {
  ReconciliationResult,
  PaymentLinkLike,
  scanForReference,
  interpretScan,
  providerUnavailable,
} from "../execution/providerReconciliation";
import { logger } from "../observability";

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;

// Check if keys are placeholders or not configured
const isPlaceholder = !keyId || !keySecret || keyId.includes("placeholder") || keySecret.includes("placeholder");

let razorpay: Razorpay | null = null;
if (!isPlaceholder) {
  try {
    razorpay = new Razorpay({
      key_id: keyId!,
      key_secret: keySecret!,
    });
  } catch (err) {
    logger.error("Failed to initialize Razorpay SDK", { error: String(err) });
  }
}

export interface PaymentLinkResult {
  id: string;
  short_url: string;
  status: string;
}

/**
 * A provider call that we know did NOT take effect.
 *
 * Reserved for definite negatives: validation rejections, 4xx responses,
 * business-rule refusals. The caller may mark the action FAILED.
 */
export class ProviderRejectedError extends Error {
  readonly kind = "REJECTED";
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "ProviderRejectedError";
  }
}

/**
 * A provider call whose outcome we genuinely cannot determine.
 *
 * Timeouts, socket resets, 5xx, DNS failures. The request may well have been
 * processed. The caller must record EXECUTION_UNKNOWN and reconcile - never
 * treat this as failure and never blindly retry the mutation.
 */
export class ProviderIndeterminateError extends Error {
  readonly kind = "INDETERMINATE";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ProviderIndeterminateError";
  }
}

/**
 * A rejection meaning the operation ALREADY EXISTS at the provider.
 *
 * VERIFIED_LIVE (Phase 17): Razorpay enforces `reference_id` uniqueness and
 * rejects a duplicate create with HTTP 400 and
 *   "payment link with given reference_id: <id> already exists".
 *
 * This is NOT a failure. It is positive evidence that a PREVIOUS attempt with
 * our idempotency key succeeded. Treating it as a plain rejection would mark a
 * live payment link as FAILED and invite an operator to "fix" it.
 */
export class ProviderDuplicateError extends Error {
  readonly kind = "DUPLICATE";
  constructor(message: string, readonly referenceId?: string) {
    super(message);
    this.name = "ProviderDuplicateError";
  }
}

/**
 * Extracts a human-readable reason from a Razorpay error.
 *
 * VERIFIED_LIVE (Phase 17): `err.message` is an EMPTY STRING on every real
 * Razorpay SDK error observed (400/401/404/429). The actual text lives at
 * `err.error.description`. Reading `err.message` - as this module previously
 * did - recorded every provider failure with a blank reason, leaving an
 * operator staring at "could not be created: " with nothing to act on.
 */
export interface RazorpayErrorDescription {
  code?: string;
  description?: string;
  reason?: string;
  field?: string;
}

export interface RazorpayErrorLike {
  statusCode?: number;
  status?: number;
  message?: string;
  error?: RazorpayErrorDescription;
}

export function describeProviderError(error: unknown): string {
  const err = error as RazorpayErrorLike | null | undefined;
  const nested = err?.error;
  const parts = [nested?.description, nested?.reason, nested?.field]
    .filter((v) => typeof v === "string" && v.length > 0);

  if (parts.length > 0) {
    const code = typeof nested?.code === "string" ? `${nested.code}: ` : "";
    return `${code}${parts.join(" | ")}`;
  }

  const direct = String(err?.message ?? "");
  if (direct.length > 0) return direct;

  const status = err?.statusCode ?? err?.status;
  if (typeof status === "number") return `Provider returned HTTP ${status} with no description.`;

  return "Unknown provider error.";
}

/**
 * Classifies a provider error into "definitely did not happen", "already
 * happened", or "cannot tell".
 *
 * The distinction is the whole basis of the EXECUTION_UNKNOWN state. Getting it
 * wrong in the safe direction (calling a rejection indeterminate) costs a
 * reconciliation query. Getting it wrong in the unsafe direction (calling a
 * timeout a failure) risks issuing a second payment link for the same debt, so
 * anything not recognisably a client-side rejection is treated as indeterminate.
 *
 * VERIFIED_LIVE (Phase 17) against the real test account:
 *   negative amount   -> 400  -> rejection
 *   zero amount       -> 400  -> rejection
 *   bad currency      -> 400  -> rejection
 *   invalid auth      -> 401  -> rejection (nothing was created)
 *   missing resource  -> 404  -> rejection
 *   rate limited      -> 429  -> INDETERMINATE (the request may have landed)
 *   duplicate ref     -> 400  -> DUPLICATE (the operation already exists)
 *
 * `error.error.code` is "BAD_REQUEST_ERROR" even for a 401, so `statusCode` -
 * not `code` - is the reliable discriminator.
 */
export function classifyProviderError(
  error: unknown
): ProviderRejectedError | ProviderIndeterminateError | ProviderDuplicateError {
  const err = error as RazorpayErrorLike | null | undefined;
  const message = describeProviderError(err);
  const statusCode: number | undefined =
    typeof err?.statusCode === "number"
      ? err.statusCode
      : typeof err?.status === "number"
      ? err.status
      : undefined;

  let classification = "unknown provider error";
  let result: ProviderRejectedError | ProviderIndeterminateError | ProviderDuplicateError;

  // Duplicate reference: the provider is telling us our operation already ran.
  // Checked before the generic 4xx branch, which would otherwise bury it.
  if (/already exists/i.test(message) && /reference_id/i.test(message)) {
    const ref = message.match(/reference_id:\s*(\S+?)[\s.]/i)?.[1];
    classification = "duplicate reference";
    result = new ProviderDuplicateError(message, ref);
  } else if (statusCode === 401) {
    classification = "authentication failure";
    result = new ProviderRejectedError(message, statusCode);
  } else if (statusCode === 404) {
    classification = "not found";
    result = new ProviderRejectedError(message, statusCode);
  } else if (statusCode === 429) {
    classification = "rate limited";
    result = new ProviderIndeterminateError(message, error);
  } else if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 408) {
    classification = "bad request";
    result = new ProviderRejectedError(message, statusCode);
  } else if (statusCode && statusCode >= 500) {
    classification = "provider unavailable";
    result = new ProviderIndeterminateError(message, error);
  } else if (/timeout|etimedout|socket hang up/i.test(message) || statusCode === 408) {
    classification = "timeout";
    result = new ProviderIndeterminateError(message, error);
  } else if (/econnreset|econnrefused|enotfound|gateway|unavailable/i.test(message)) {
    classification = "provider unavailable";
    result = new ProviderIndeterminateError(message, error);
  } else {
    classification = "provider indeterminate";
    result = new ProviderIndeterminateError(message, error);
  }

  logger.info("Razorpay error classified", {
    classification,
    httpStatus: statusCode,
    errorCode: err?.error?.code,
    description: err?.error?.description,
  });

  return result;
}

/** True when the SDK is running against simulated (non-live) credentials. */
export function isSimulatedProvider(): boolean {
  return isPlaceholder || !razorpay;
}

/**
 * Creates a Razorpay payment link.
 *
 * `idempotencyKey` becomes the link's `reference_id`, which Razorpay enforces as
 * unique per account. That is the provider's own idempotency mechanism: a
 * repeated create with the same reference_id is rejected rather than duplicated,
 * and the same reference_id also lets us look the link up during reconciliation.
 *
 * This function NO LONGER fabricates a fake link when the provider errors. The
 * previous implementation caught every failure and returned a synthetic
 * `plink_err_...` id as though it had succeeded, which meant a network timeout
 * was reported to the user as a working payment URL and made EXECUTION_UNKNOWN
 * unreachable for the two link-issuing action types.
 */
export interface PaymentLinkCustomer {
  name?: string;
  email?: string;
  contact?: string;
}

export async function createRecoveryPaymentLink(
  amountInPaise: number,
  customerDescription: string,
  idempotencyKey?: string,
  customer?: PaymentLinkCustomer
): Promise<PaymentLinkResult> {
  if (isPlaceholder || !razorpay) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CRITICAL: Razorpay credentials are missing or placeholders in production. Refusing to run simulated operations.");
    }
    // Simulated provider. The id is derived from the idempotency key so a
    // repeated call in local development yields the same link, exactly as the
    // live provider would.
    const mockId = idempotencyKey
      ? `plink_sim_${idempotencyKey}`
      : "plink_sim_" + Math.random().toString(36).substring(2, 9);
    return {
      id: mockId,
      short_url: `/sandbox/checkout?paymentLinkId=${mockId}`,
      status: "created",
    };
  }

  try {
    // Razorpay expects amount in paise. Our DB amount is already in paise.
    // `customer` is a REQUIRED field on RazorpayPaymentLinkCreateRequestBody
    // (razorpay@2.9.8 types). The previous call omitted it entirely, so a live
    // creation would have been rejected by the provider. Contact details are
    // supplied by the caller when known; the notify flags are off so CashPilot
    // never emails or texts a customer on its own initiative.
    const link = await (razorpay.paymentLink.create({
      amount: amountInPaise,
      currency: "INR",
      description: `CashPilot Auto Recovery: ${customerDescription}`,
      customer: {
        name: customer?.name ?? customerDescription.slice(0, 50),
        email: customer?.email ?? "",
        contact: customer?.contact ?? "",
      },
      notify: { email: false, sms: false },
      reminder_enable: false,
      ...(idempotencyKey ? { reference_id: idempotencyKey } : {}),
      notes: { source: "cashpilot-auto-recovery", ...(idempotencyKey ? { cashpilot_key: idempotencyKey } : {}) },
    }) as unknown as RazorpayPaymentLinkResponse);

    return {
      id: link.id,
      short_url: link.short_url,
      status: link.status,
    };
  } catch (error) {
    // Propagate a classified error. The caller decides FAILED vs UNKNOWN.
    throw classifyProviderError(error);
  }
}

/**
 * Reconciles one payment-link operation against the provider.
 *
 * IMPORTANT - what this does NOT do: it does not ask Razorpay to filter by
 * `reference_id`. That filter is not part of the documented or typed API
 * (`paymentLink.all` accepts only `from`/`to`/`count`/`skip`), and passing it
 * anyway yields an UNFILTERED page rather than an error. The previous
 * implementation then took `items[0]` as a fallback match, which would have
 * bound an unrelated payment link to our intent and reported a success that
 * never happened.
 *
 * Instead: page through the links created inside the intent's own time window -
 * `from`/`to` ARE supported - and match `reference_id` locally, tracking whether
 * the scan actually completed. An incomplete scan yields UNKNOWN, never
 * NOT_FOUND.
 */
export async function reconcilePaymentLink(
  referenceId: string,
  window: { from: Date; to: Date },
  now: Date = new Date(),
  /** When the operation was first attempted; gates the NOT_FOUND conclusion. */
  operationRecordedAt?: Date
): Promise<ReconciliationResult> {
  if (isPlaceholder || !razorpay) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("CRITICAL: Razorpay credentials are missing or placeholders in production. Refusing to run simulated operations.");
    }
    return providerUnavailable(
      referenceId,
      "No live payment provider is configured, so the existence of this operation cannot be verified.",
      now
    );
  }

  const scan = await scanForReference(
    referenceId,
    {
      // Razorpay expects Unix seconds. Widen by a minute on each side so a
      // clock skew between us and the provider cannot hide our own link.
      fromUnix: Math.floor(window.from.getTime() / 1000) - 60,
      toUnix: Math.ceil(window.to.getTime() / 1000) + 60,
    },
    async ({ from, to, count, skip }) => {
      const allMethod = razorpay!.paymentLink.all as unknown as (opts: { from: number; to: number; count: number; skip: number }) => Promise<RazorpayPaymentLinkListResponse>;
      const response = await allMethod({ from, to, count, skip });
      return (response?.payment_links ?? response?.items ?? []) as PaymentLinkLike[];
    }
  );

  return interpretScan(referenceId, scan, now, operationRecordedAt ?? window.from);
}

export interface RazorpayPaymentLinkResponse {
  id: string;
  short_url: string;
  status: string;
}

export interface RazorpayPaymentLinkListResponse {
  payment_links?: PaymentLinkLike[];
  items?: PaymentLinkLike[];
}
