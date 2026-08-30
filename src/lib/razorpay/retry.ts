import { logger } from "@/lib/observability";
import { ProviderIndeterminateError } from "./client";

/**
 * Bounded exponential backoff for READ-ONLY provider calls.
 *
 * The rule this module exists to enforce is which calls may be retried at all.
 *
 * A mutation that returns an indeterminate error — a timeout, a 429, a 5xx —
 * MAY ALREADY HAVE LANDED. Retrying `createRecoveryPaymentLink` after a timeout
 * is how a business ends up with two live payment links for one invoice, and
 * the customer pays twice. That case is not a retry problem; it is the UNKNOWN
 * state the execution intent machinery exists to resolve, and it must stay
 * there. So this helper is deliberately not generic: it is for reads, and the
 * parameter is named to make a mutation call site look wrong.
 *
 * A read is different. Re-fetching a payment link's status has no financial
 * effect, so a rate-limited or briefly unavailable provider is worth waiting
 * out rather than immediately degrading to UNKNOWN — which is safe but blind,
 * and leaves an operator staring at an unresolved intent that a two-second
 * pause would have settled.
 *
 * What is NOT retried:
 *   · ProviderRejectedError — 400/401/404. The provider gave a definite answer.
 *     Repeating the question cannot change it, and hammering a 401 is how an
 *     account gets flagged.
 *   · ProviderDuplicateError — positive evidence the operation already exists.
 *   · Anything, once the attempt budget is spent. The last error propagates so
 *     the caller still reaches its UNKNOWN handling.
 */

export interface RetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number;
  /** Delay before the second attempt, in ms; doubled each time after. */
  baseDelayMs: number;
  /** Ceiling for a single delay, before jitter. */
  maxDelayMs: number;
}

export const PROVIDER_READ_RETRY: RetryPolicy = {
  // Three attempts spans a transient blip without turning one reconciliation
  // into a long-running request. A scan already runs behind a settling period,
  // so patience here is cheap but not free.
  maxAttempts: 3,
  baseDelayMs: 400,
  maxDelayMs: 4_000,
};

/**
 * Full jitter: a random point in [0, capped]. Equal-spaced retries from many
 * workers reconverge into the same burst that caused the rate limit; spreading
 * them is the point of the delay, not the delay itself.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy = PROVIDER_READ_RETRY,
  random: () => number = Math.random
): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return Math.round(random() * capped);
}

/** Only an indeterminate provider error is worth asking again. */
export function isRetryableProviderError(error: unknown): boolean {
  return error instanceof ProviderIndeterminateError;
}

export interface RetryOptions {
  policy?: RetryPolicy;
  /** Injected for tests, so a retry suite does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Included in logs so a retry storm can be traced to its caller. */
  operation?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run a READ-ONLY provider call, retrying only indeterminate failures.
 *
 * `read` must have no financial side effect. Passing a mutation here would
 * reintroduce exactly the duplicate-execution hazard the intent machinery
 * prevents.
 */
export async function withProviderReadRetry<T>(
  read: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const policy = options.policy ?? PROVIDER_READ_RETRY;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;

      if (!isRetryableProviderError(error)) throw error;

      if (attempt === policy.maxAttempts) {
        logger.warn("Provider read exhausted its retries", {
          operation: options.operation,
          attempts: attempt,
        });
        break;
      }

      const delay = backoffDelayMs(attempt, policy, random);
      logger.info("Retrying an indeterminate provider read", {
        operation: options.operation,
        attempt,
        nextDelayMs: delay,
      });
      await sleep(delay);
    }
  }

  // The original error, so the caller's UNKNOWN handling sees what happened
  // rather than a wrapper claiming the retry itself failed.
  throw lastError;
}
