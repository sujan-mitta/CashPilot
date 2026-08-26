import { describe, it, expect } from "vitest";
import { parseJsonBody } from "../errors";

/**
 * TRANCHE 12 regression — malformed JSON must be a 400, not a 500.
 *
 * A bare `await req.json()` throws on malformed input and fell into the routes'
 * catch-all, returning 500 (server error) for what is actually a client error.
 * Verified live against production before the fix. parseJsonBody distinguishes
 * the two and never exposes the parser's internal error text.
 */
const post = (body: string) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

describe("parseJsonBody", () => {
  it("returns ok with the parsed data for valid JSON", async () => {
    const r = await parseJsonBody(post('{"email":"a@b.c","password":"secret"}'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ email: "a@b.c", password: "secret" });
  });

  it("THE FIX: malformed JSON yields a 400, not a thrown 500", async () => {
    for (const bad of ["not json{{{", "", "{unterminated", "[1,2,", '{"a":}']) {
      const r = await parseJsonBody(post(bad));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(400);
        const body = await r.response.json();
        expect(body.error).toMatch(/valid JSON/i);
      }
    }
  });

  it("never leaks parser internals (no SyntaxError text, no stack)", async () => {
    const r = await parseJsonBody(post("garbage"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const dump = JSON.stringify(await r.response.json());
      expect(dump).not.toMatch(/SyntaxError|Unexpected token|position \d+|stack/i);
    }
  });
});
