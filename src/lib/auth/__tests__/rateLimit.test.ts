import { describe, it, expect } from "vitest";
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
    const key = `t-${Math.random()}`;
    expect(rateLimit(key, 1, 1).ok).toBe(true);   // consume the single slot
    expect(rateLimit(key, 1, 1).ok).toBe(false);  // immediately blocked
    // window of 1ms has now passed
    const later = Date.now();
    while (Date.now() <= later + 2) { /* spin briefly */ }
    expect(rateLimit(key, 1, 1).ok).toBe(true);
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
