import { describe, it, expect, vi } from "vitest";
import { rateLimit, clientKey } from "../rateLimit";

describe("rateLimit", () => {
  it("allows up to the limit, then blocks", () => {
    const key = `t-${Math.random()}`;
    for (let i = 0; i < 5; i++) expect(rateLimit(key, 5, 60_000).ok).toBe(true);
    const blocked = rateLimit(key, 5, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("resets after the window elapses", () => {
    // Fake timers make this deterministic: the previous real-clock version
    // raced across millisecond boundaries under load and flaked.
    vi.useFakeTimers();
    try {
      const key = `t-${Math.random()}`;
      const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
      vi.setSystemTime(t0);
      expect(rateLimit(key, 1, 60_000).ok).toBe(true);   // consume the slot
      expect(rateLimit(key, 1, 60_000).ok).toBe(false);  // blocked within window
      vi.setSystemTime(t0 + 60_001);                     // window has elapsed
      expect(rateLimit(key, 1, 60_000).ok).toBe(true);   // slot available again
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks keys independently", () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    expect(rateLimit(a, 1, 60_000).ok).toBe(true);
    expect(rateLimit(a, 1, 60_000).ok).toBe(false);
    // b is unaffected by a being exhausted
    expect(rateLimit(b, 1, 60_000).ok).toBe(true);
  });
});

describe("clientKey", () => {
  const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });

  it("uses the first x-forwarded-for hop", () => {
    expect(clientKey(req({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
  });

  it("falls back to a shared bucket rather than unlimited", () => {
    expect(clientKey(req({}))).toBe("unknown");
  });
});
