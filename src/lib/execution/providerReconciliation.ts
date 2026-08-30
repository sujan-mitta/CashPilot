/**
 * ===========================================================================
 * PROVIDER RECONCILIATION ADAPTER  (Phase 16)
 * ===========================================================================
 *
 * The engine must not depend on Razorpay response shapes. Everything below is
 * expressed in terms of what CashPilot needs to know: did our operation happen,
 * or can we not tell?
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ACTUALLY VERIFIED ABOUT THE RAZORPAY SDK (razorpay@2.9.8)
 * ---------------------------------------------------------------------------
 * Verified by reading `node_modules/razorpay/dist/types/paymentLink.d.ts` and
 * `dist/resources/paymentLink.js`. NOT verified against a live account.
 *
 *   1. `reference_id` IS accepted on payment-link creation.
 *      `RazorpayPaymentLinkBaseRequestBody.reference_id?: string`.
 *
 *   2. `reference_id` IS returned on the entity.
 *      `RazorpayPaymentLink extends RazorpayPaymentLinkBaseRequestBody`.
 *
 *   3. Filtering `paymentLink.all()` by `reference_id` is **NOT SUPPORTED**.
 *      The typed parameter is `RazorpayPaginationOptions`, which is exactly
 *      `{ from?, to?, count?, skip? }`. The runtime implementation spreads
 *      whatever object it is given into the GET query string, so an unsupported
 *      key is transmitted and then ignored by the API - it does not error, it
 *      returns an UNFILTERED page.
 *
 * That third point invalidated the Phase 15 implementation, which did:
 *
 *      const match = items.find(l => l.reference_id === key) ?? items[0];
 *
 * With the filter ignored, `items` is the 10 most recent links for the whole
 * account and `?? items[0]` would attach an unrelated payment link to our
 * intent and mark it SUCCEEDED. That is a fabricated success on a financial
 * record. It is removed.
 *
 * ---------------------------------------------------------------------------
 * THE SUPPORTED APPROACH
 * ---------------------------------------------------------------------------
 * `from` / `to` / `count` / `skip` ARE supported. So we page through the links
 * created inside the intent's own time window and match `reference_id`
 * ourselves. Crucially the adapter tracks whether that scan was EXHAUSTIVE:
 *
 *   - scanned the whole window and found nothing  -> NOT_FOUND (safe conclusion)
 *   - scan truncated, errored, or hit its page cap -> UNKNOWN (unsafe to conclude)
 *
 * "We looked and it is not there" and "we could not finish looking" are
 * different facts and are never collapsed.
 */

import { FINANCIAL_CONFIG } from "../engine/financialConfig";

const PROVIDER_LIST_SETTLING_MS = FINANCIAL_CONFIG.PROVIDER_LIST_SETTLING_MS;
const PROVIDER_NOT_FOUND_COOLING_MS = FINANCIAL_CONFIG.PROVIDER_NOT_FOUND_COOLING_MS;

export type ReconciliationStatus =
  /** The operation exists at the provider and is settled. */
  | "CONFIRMED_SUCCESS"
  /** The operation demonstrably did not take effect. Retry is safe. */
  | "CONFIRMED_FAILURE"
  /** The operation exists but has not reached a terminal state yet. */
  | "PENDING"
  /** An exhaustive search found nothing. Retry is safe. */
  | "NOT_FOUND"
  /** We could not determine anything. Retry is NOT safe. */
  | "UNKNOWN";

export interface ReconciliationResult {
  status: ReconciliationStatus;
  /** Provider-side id, when one was found. */
  providerReference?: string;
  /** Raw provider status, for the operator to see. */
  providerStatus?: string;
  reason: string;
  /**
   * True only when the system has POSITIVE evidence the original operation did
   * not occur. The single gate on any retry (PART 5 / INVARIANT 5).
   */
  retrySafe: boolean;
  /** What we expected to find, for operator display (PART 9). */
  expectedEvidence: string;
  /** What we actually found. */
  observedEvidence: string;
  /** Whether the search covered everything it needed to. */
  searchExhaustive: boolean;
  checkedAt: string;
}

/** Terminal provider states for a payment link. */
const SETTLED_STATES = ["paid"];
const DEAD_STATES = ["cancelled", "expired"];

export interface PaymentLinkLike {
  id: string;
  status?: string;
  reference_id?: string;
  amount_paid?: number;
}

/**
 * Pages a provider listing looking for one reference id.
 *
 * `listPage` receives a bounded window plus a skip offset and must return the
 * page of links. It may throw - a throw means the scan is incomplete, and an
 * incomplete scan can never produce NOT_FOUND.
 */
export async function scanForReference(
  referenceId: string,
  window: { fromUnix: number; toUnix: number },
  listPage: (opts: { from: number; to: number; count: number; skip: number }) => Promise<PaymentLinkLike[]>,
  options: { pageSize?: number; maxPages?: number } = {}
): Promise<{ found: PaymentLinkLike | null; exhaustive: boolean; pagesScanned: number; error?: string }> {
  // Razorpay caps `count` at 100.
  const pageSize = Math.min(options.pageSize ?? 100, 100);
  const maxPages = options.maxPages ?? 20;

  let skip = 0;
  let pagesScanned = 0;

  while (pagesScanned < maxPages) {
    let page: PaymentLinkLike[];
    try {
      page = await listPage({ from: window.fromUnix, to: window.toUnix, count: pageSize, skip });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // The scan stopped early. We know nothing.
      return {
        found: null,
        exhaustive: false,
        pagesScanned,
        error: errMsg,
      };
    }

    pagesScanned++;

    // Match strictly. No positional fallback - an unrelated link is not ours.
    const match = page.find((l) => l.reference_id === referenceId);
    if (match) {
      return { found: match, exhaustive: true, pagesScanned };
    }

    // A short page means we have reached the end of the window.
    if (page.length < pageSize) {
      return { found: null, exhaustive: true, pagesScanned };
    }

    skip += pageSize;
  }

  // Hit the page cap without reaching the end: the window is larger than we
  // were willing to scan, so absence is not established.
  return { found: null, exhaustive: false, pagesScanned };
}

/**
 * Turns a scan result into a reconciliation verdict.
 *
 * Deliberately separate from the scan so the decision logic is testable without
 * any provider at all.
 */
export function interpretScan(
  referenceId: string,
  scan: { found: PaymentLinkLike | null; exhaustive: boolean; error?: string },
  now: Date = new Date(),
  /**
   * When the operation was first attempted. Required to distinguish "the
   * provider does not have this" from "the provider has not caught up yet".
   */
  operationRecordedAt?: Date
): ReconciliationResult {
  const base = {
    reason: "",
    expectedEvidence: `A payment link at the provider carrying reference_id "${referenceId}".`,
    searchExhaustive: scan.exhaustive,
    checkedAt: now.toISOString(),
  };

  if (scan.found) {
    const status = String(scan.found.status ?? "unknown");

    if (SETTLED_STATES.includes(status)) {
      return {
        ...base,
        status: "CONFIRMED_SUCCESS",
        providerReference: scan.found.id,
        providerStatus: status,
        reason: "The payment link exists at the provider and is paid.",
        observedEvidence: `Payment link ${scan.found.id} with status "${status}".`,
        retrySafe: false,
      };
    }

    if (DEAD_STATES.includes(status)) {
      // The link was created, so the operation DID happen. It simply did not
      // result in money. Re-issuing would be a second link for the same debt,
      // so this is not retry-safe.
      return {
        ...base,
        status: "CONFIRMED_FAILURE",
        providerReference: scan.found.id,
        providerStatus: status,
        reason: `The payment link exists but is ${status}; no money was collected.`,
        observedEvidence: `Payment link ${scan.found.id} with status "${status}".`,
        retrySafe: false,
      };
    }

    return {
      ...base,
      status: "PENDING",
      providerReference: scan.found.id,
      providerStatus: status,
      reason: "The payment link exists and is awaiting payment.",
      observedEvidence: `Payment link ${scan.found.id} with status "${status}".`,
      retrySafe: false,
    };
  }

  if (scan.error) {
    return {
      ...base,
      status: "UNKNOWN",
      reason: `The provider could not be searched: ${scan.error}`,
      observedEvidence: "The search did not complete.",
      retrySafe: false,
    };
  }

  if (!scan.exhaustive) {
    return {
      ...base,
      status: "UNKNOWN",
      reason:
        "The search reached its page limit before covering the whole window, so absence is not established.",
      observedEvidence: "Search incomplete; no match in the pages scanned.",
      retrySafe: false,
    };
  }

  // The scan was exhaustive and found nothing - but the provider's LIST endpoint
  // is eventually consistent (VERIFIED_LIVE, Phase 18: up to ~6s lag observed).
  // Inside the settling period, absence proves nothing.
  if (operationRecordedAt) {
    const ageMs = now.getTime() - operationRecordedAt.getTime();
    if (ageMs < PROVIDER_LIST_SETTLING_MS) {
      return {
        ...base,
        status: "UNKNOWN",
        reason:
          `The operation is only ${Math.round(ageMs / 1000)}s old and the provider's list endpoint is eventually consistent, so its absence does not establish that it never happened. Re-check after ${Math.round(PROVIDER_LIST_SETTLING_MS / 1000)}s.`,
        observedEvidence: "Not present in a fully scanned window, but within the provider settling period.",
        searchExhaustive: true,
        retrySafe: false,
      };
    }

    if (ageMs < PROVIDER_NOT_FOUND_COOLING_MS) {
      return {
        ...base,
        status: "UNKNOWN",
        reason: `The operation was not found in the paged listing scan, but it is within the 24-hour cooling-off window (operation age: ${(ageMs / (60 * 60 * 1000)).toFixed(1)}h). It cannot be marked FAILED or retried without manual verification.`,
        observedEvidence: "Not present in a fully scanned window, but within the provider cooling-off window.",
        searchExhaustive: true,
        retrySafe: false,
      };
    }
  }

  // Exhaustive scan, outside the settling period, nothing there. The link was
  // never created, so re-issuing it cannot duplicate anything.
  return {
    ...base,
    status: "NOT_FOUND",
    reason:
      "An exhaustive search of the creation window, outside the provider settling period, found no payment link with this reference. The operation did not take effect.",
    observedEvidence: "No matching payment link in a fully scanned window.",
    retrySafe: true,
  };
}

/** Result returned when no provider is configured at all. */
export function providerUnavailable(referenceId: string, why: string, now: Date = new Date()): ReconciliationResult {
  return {
    status: "UNKNOWN",
    reason: why,
    expectedEvidence: `A payment link at the provider carrying reference_id "${referenceId}".`,
    observedEvidence: "No provider was available to ask.",
    searchExhaustive: false,
    retrySafe: false,
    checkedAt: now.toISOString(),
  };
}
