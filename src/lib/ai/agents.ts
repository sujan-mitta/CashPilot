import { groq, MODEL } from "./groqClient";

/** Hard ceiling on a narration call. Cosmetic output never blocks a decision. */
export const AGENT_TIMEOUT_MS = 8000;

/**
 * Removes any chain-of-thought the model leaks into the response body.
 * Qwen3 emits reasoning inside <think> tags; disabling reasoning should prevent
 * this, but a truncated or unterminated block would otherwise reach the UI.
 */
function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .trim();
}

/**
 * Runs an AI agent with a given prompt, calling Groq and catching errors with clean fallbacks.
 */
export async function runAgent(prompt: string, fallback: string): Promise<string> {
  // If the Groq key is not configured or is a placeholder, return the fallback immediately to avoid latency
  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY.includes("placeholder")) {
    console.warn("Using static fallback narration (Groq API key is not set/placeholder).");
    return fallback;
  }

  try {
    const completion = await groq.chat.completions.create(
      {
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 350,
        // The narrations are short prose read by a business owner. Without this the
        // model spends the whole token budget thinking and returns its scratchpad
        // (or nothing at all) instead of the answer.
        reasoning_effort: "none",
      },
      // Narration is cosmetic and runs INSIDE /api/execute, once per action, on
      // the request that has already dispatched payment links. With no bound, a
      // hung provider held that request open indefinitely while the operator
      // watched a spinner over money that had genuinely moved. The fallback
      // prose is always available, so waiting longer than this buys nothing.
      { timeout: AGENT_TIMEOUT_MS, maxRetries: 0 }
    );

    const content = stripReasoning(completion.choices[0]?.message?.content ?? "");
    if (!content) {
      throw new Error("Empty response from Groq");
    }
    return content;
  } catch (error) {
    console.error("Groq API error, falling back to static narration:", error);
    return fallback;
  }
}
