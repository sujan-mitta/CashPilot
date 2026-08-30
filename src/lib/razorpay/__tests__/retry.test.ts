import { describe, it, expect, vi } from "vitest";
import {
  withProviderReadRetry,
  backoffDelayMs,
  isRetryableProviderError,
  PROVIDER_READ_RETRY,
} from "../retry";
import {
  ProviderIndeterminateError,
  ProviderRejectedError,
  ProviderDuplicateError,
} from "../client";

/**
 * Backoff for read-only provider calls.
 *
 * The property that matters most here is not "it retries" — it is WHAT it
 * refuses to retry. A definite provider answer must not be asked again, and a
 * mutation must never be routed through this at all: an indeterminate write may
 * already have landed, and repeating it is how one invoice acquires two live
 * payment links.
 */

const noSleep = async () => {};

describe("Which failures are retryable", () => {
  it("retries an indeterminate error", () => {
    expect(isRetryableProviderError(new ProviderIndeterminateError("timeout", null))).toBe(true);
  });

  it("never retries a rejection", () => {
    // 400/401/404 are definite. Repeating the question cannot change it, and
    // hammering a 401 is how an account gets flagged.
    expect(isRetryableProviderError(new ProviderRejectedError("unauthorized", 401))).toBe(false);
    expect(isRetryableProviderError(new ProviderRejectedError("not found", 404))).toBe(false);
  });

  it("never retries a duplicate", () => {
    // Positive evidence the operation already exists. Retrying would be asking
    // to create it again.
    expect(isRetryableProviderError(new ProviderDuplicateError("exists", "ref"))).toBe(false);
  });

  it("does not retry an unclassified error", () => {
    expect(isRetryableProviderError(new Error("something else"))).toBe(false);
  });
});

describe("Backoff shape", () => {
  it("grows exponentially", () => {
    const full = () => 1; // no jitter, to read the envelope
    expect(backoffDelayMs(1, PROVIDER_READ_RETRY, full)).toBe(400);
    expect(backoffDelayMs(2, PROVIDER_READ_RETRY, full)).toBe(800);
    expect(backoffDelayMs(3, PROVIDER_READ_RETRY, full)).toBe(1600);
  });

  it("is capped", () => {
    const full = () => 1;
    expect(backoffDelayMs(20, PROVIDER_READ_RETRY, full)).toBe(PROVIDER_READ_RETRY.maxDelayMs);
  });

  it("applies full jitter rather than a fixed delay", () => {
    // Equal-spaced retries from many workers reconverge into the burst that
    // caused the rate limit. Spreading them is the point.
    expect(backoffDelayMs(3, PROVIDER_READ_RETRY, () => 0)).toBe(0);
    expect(backoffDelayMs(3, PROVIDER_READ_RETRY, () => 0.5)).toBe(800);
    expect(backoffDelayMs(3, PROVIDER_READ_RETRY, () => 1)).toBe(1600);
  });

  it("never returns a negative delay", () => {
    for (let a = 1; a <= 6; a++) {
      expect(backoffDelayMs(a, PROVIDER_READ_RETRY, () => 0)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("Retrying a read", () => {
  it("returns the first success without waiting", async () => {
    const read = vi.fn(async () => "ok");
    const sleep = vi.fn(noSleep);

    await expect(withProviderReadRetry(read, { sleep })).resolves.toBe("ok");
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("recovers when a rate limit clears", async () => {
    let calls = 0;
    const read = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new ProviderIndeterminateError("rate limited", null);
      return "settled";
    });

    await expect(withProviderReadRetry(read, { sleep: noSleep })).resolves.toBe("settled");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("gives up after the attempt budget and rethrows the provider's own error", async () => {
    const failure = new ProviderIndeterminateError("rate limited", null);
    const read = vi.fn(async () => {
      throw failure;
    });

    // The ORIGINAL error propagates, so the caller still reaches its UNKNOWN
    // handling rather than seeing a wrapper about the retry.
    await expect(withProviderReadRetry(read, { sleep: noSleep })).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(PROVIDER_READ_RETRY.maxAttempts);
  });

  it("does not retry a rejection even once", async () => {
    const read = vi.fn(async () => {
      throw new ProviderRejectedError("unauthorized", 401);
    });

    await expect(withProviderReadRetry(read, { sleep: noSleep })).rejects.toBeInstanceOf(
      ProviderRejectedError
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("waits between attempts, once per gap and never after the last", async () => {
    const read = vi.fn(async () => {
      throw new ProviderIndeterminateError("timeout", null);
    });
    const sleep = vi.fn(noSleep);

    await expect(withProviderReadRetry(read, { sleep })).rejects.toThrow();

    // Three attempts means two gaps. A sleep after the final failure would be
    // latency charged for nothing.
    expect(sleep).toHaveBeenCalledTimes(PROVIDER_READ_RETRY.maxAttempts - 1);
  });

  it("honours a custom policy", async () => {
    const read = vi.fn(async () => {
      throw new ProviderIndeterminateError("timeout", null);
    });

    await expect(
      withProviderReadRetry(read, {
        sleep: noSleep,
        policy: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 50 },
      })
    ).rejects.toThrow();

    expect(read).toHaveBeenCalledTimes(5);
  });
});
