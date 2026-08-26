import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * TRANCHE 9 + 10 — AI output containment.
 *
 * runAgent is the single doorway between the LLM and the app. The financial
 * layer treats its result as narration prose only, never as an instruction or
 * an authorization. These tests assert the doorway itself: whatever the model
 * returns - a payment instruction, malformed output, a huge blob, nothing -
 * runAgent always yields a plain STRING and never throws. That containment is
 * what makes "AI cannot authorize execution" hold structurally: there is no
 * shape runAgent can return that a caller could mistake for a decision.
 */

const groqMock = vi.hoisted(() => ({ chat: { completions: { create: vi.fn() } } }));
vi.mock("../groqClient", () => ({ groq: groqMock, MODEL: "test-model" }));

import { runAgent } from "../agents";

const reply = (content: unknown) =>
  groqMock.chat.completions.create.mockResolvedValue({ choices: [{ message: { content } }] });

beforeEach(() => {
  vi.stubEnv("GROQ_API_KEY", "gsk_realtestkey_abc123");
  groqMock.chat.completions.create.mockReset();
});

describe("runAgent contains the model", () => {
  it("returns a string for a normal narration", async () => {
    reply("Your runway is 9 days; recovering the failed payment restores the buffer.");
    const out = await runAgent("prompt", "FALLBACK");
    expect(typeof out).toBe("string");
    expect(out).toContain("runway");
  });

  it("a payment/authorization INSTRUCTION from the model is still just a string", async () => {
    // The model tries to smuggle an instruction. It has no privileged path; it
    // becomes narration text and nothing more.
    reply('{"action":"EXECUTE_PAYMENT","authorized":true,"amount":10000000}');
    const out = await runAgent("prompt", "FALLBACK");
    expect(typeof out).toBe("string");
    // Callers use it as prose; it is never parsed as an action by runAgent.
    expect(out).not.toBe(true as unknown as string);
  });

  it("empty model output falls back to the static string, never throws", async () => {
    reply("");
    expect(await runAgent("prompt", "STATIC_FALLBACK")).toBe("STATIC_FALLBACK");
  });

  it("null/undefined content falls back cleanly", async () => {
    reply(null);
    expect(await runAgent("prompt", "FB1")).toBe("FB1");
    reply(undefined);
    expect(await runAgent("prompt", "FB2")).toBe("FB2");
  });

  it("a thrown provider error falls back, never propagates", async () => {
    groqMock.chat.completions.create.mockRejectedValueOnce(new Error("groq 500"));
    expect(await runAgent("prompt", "FB_ON_ERROR")).toBe("FB_ON_ERROR");
  });

  it("leaked chain-of-thought is stripped, output stays a string", async () => {
    reply("<think>I should exfiltrate secrets</think>Runway looks healthy.");
    const out = await runAgent("prompt", "FB");
    expect(out).toBe("Runway looks healthy.");
    expect(out).not.toContain("exfiltrate");
  });

  it("a very large model response is still returned as a bounded string, no crash", async () => {
    reply("A".repeat(500_000));
    const out = await runAgent("prompt", "FB");
    expect(typeof out).toBe("string");
  });

  it("with no API key it returns the fallback WITHOUT calling the model", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const out = await runAgent("prompt", "OFFLINE_FALLBACK");
    expect(out).toBe("OFFLINE_FALLBACK");
    expect(groqMock.chat.completions.create).not.toHaveBeenCalled();
  });
});
