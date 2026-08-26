/**
 * Fixed-window in-memory rate limiter.
 *
 * HONEST LIMITATION: this counts per serverless instance, not globally. On
 * Vercel a burst spread across several warm instances gets a higher effective
 * ceiling than the nominal one, and a cold start resets a window. It is a
 * meaningful brake on casual credential-stuffing from one client, not a
 * defence against a distributed attacker.
 *
 * A global limit needs a shared store (e.g. Upstash Redis). This is the
 * dependency-free floor until that is wired; it is deliberately conservative so
 * that if it errs, it errs toward blocking sooner rather than later.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

// Bound the map so a flood of distinct keys cannot grow it without limit.
const MAX_KEYS = 10_000;

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || now >= existing.resetAt) {
    if (windows.size >= MAX_KEYS) {
      // Evict everything already expired; cheap and keeps the map bounded.
      for (const [k, w] of windows) if (now >= w.resetAt) windows.delete(k);
    }
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSec: Math.ceil(windowMs / 1000) };
  }

  existing.count += 1;
  const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  if (existing.count > limit) {
    return { ok: false, remaining: 0, retryAfterSec };
  }
  return { ok: true, remaining: limit - existing.count, retryAfterSec };
}

/**
 * A best-effort client identifier from proxy headers.
 *
 * x-forwarded-for is client-controllable in general, but on Vercel the
 * platform sets it and appends the real edge IP, so the first hop is a usable
 * signal. Falls back to a constant so a missing header degrades to a shared
 * bucket rather than an unlimited one.
 */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim();
  return ip || req.headers.get("x-real-ip") || "unknown";
}
