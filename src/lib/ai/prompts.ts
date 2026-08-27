import { formatINR } from "@/lib/format";

export const GOLDEN_RULE = `You are a component of CashPilot, an AI financial operations assistant.
You must NEVER invent, estimate, or alter any financial figure.
Every number you mention MUST come verbatim from the JSON data provided to you.
Money amounts are ALREADY formatted for display (e.g. "₹2,60,000"). Reproduce them
exactly as given, including the ₹ symbol and the separators. Never convert them,
round them, or strip the symbol.
Your only job is to explain, prioritize in words, and recommend — never to calculate.
Write for a small-business owner with no finance training: short sentences, everyday
words, no jargon like "liquidity", "counterfactual" or "runway".
Respond in 2-4 concise sentences. No markdown, no bullet points, plain prose suitable for reading aloud in a live product demo.`;

/**
 * The model is instructed to quote figures verbatim, so whatever it is handed is
 * what the operator reads. Amounts are stored in paise, which meant the narrative
 * said "a projected balance of 26000000" — technically verbatim, and meaningless
 * to the person reading it. Formatting before the prompt makes verbatim correct.
 */
const money = (paise: number) => formatINR(paise);

export function investigatorPrompt(data: {
  currentCash: number;
  projectedBalance: number;
  riskLevel: string;
  crisisDay: number | null;
  rootCauses: { type: string; amount: number; detail: string }[];
}) {
  const display = {
    ...data,
    currentCash: money(data.currentCash),
    projectedBalance: money(data.projectedBalance),
    rootCauses: data.rootCauses.map((rc) => ({ ...rc, amount: money(rc.amount) })),
  };

  return `${GOLDEN_RULE}

Here is the structured financial analysis for the next 14 days:
${JSON.stringify(display, null, 2)}

Explain what is happening and why, referencing the root causes in order of impact (largest first). Highlight when the cash crisis is expected to hit (the crisis day). Speak directly to the business owner, keeping it professional and urgent.`;
}

export function strategyExplainerPrompt(strategies: { name: string; projectedBalance: number; riskLevel: string; actionsCount: number }[]) {
  const display = strategies.map((s) => ({ ...s, projectedBalance: money(s.projectedBalance) }));

  return `${GOLDEN_RULE}

Here are the simulated intervention strategies:
${JSON.stringify(display, null, 2)}

Compare the strategies briefly. Explain what changes between "do nothing" and full intervention, and why recovering failed payments alone is insufficient to resolve the projected deficit.`;
}

export function recommenderPrompt(data: {
  recommendedStrategy: { name: string; projectedBalance: number; riskLevel: string; score: number; actions: { label: string; amount: number }[] };
  alternatives: { name: string; projectedBalance: number; riskLevel: string; score: number }[];
}) {
  const recommended = {
    ...data.recommendedStrategy,
    projectedBalance: money(data.recommendedStrategy.projectedBalance),
    actions: data.recommendedStrategy.actions.map((a) => ({ ...a, amount: money(a.amount) })),
  };
  const alternatives = data.alternatives.map((a) => ({
    ...a,
    projectedBalance: money(a.projectedBalance),
  }));

  return `${GOLDEN_RULE}

The deterministic engine recommended this strategy as the optimal choice:
${JSON.stringify(recommended, null, 2)}

Here are the other alternatives that were evaluated:
${JSON.stringify(alternatives, null, 2)}

Explain in plain language why the recommended strategy scored highest, referencing its balance between cash safety (minimum balance and deficit elimination) and operational impact (obligation protection and disruption). Do not invent or recalculate the scores — explain the score values you were given.`;
}

export function actionNarratorPrompt(action: { actionType: string; amount: number; label: string }) {
  return `You are a component of CashPilot, an AI financial operations assistant.
You must NEVER invent, estimate, or alter any financial figure.
Every number you mention MUST come verbatim from the JSON data provided to you.
Write ONE short present-tense sentence narrating this action as it happens, suitable for a live progress feed (e.g. "Recovering ₹2,40,000 in failed payments..."). No preamble, no markdown, just the sentence.

Action to narrate:
${JSON.stringify({ ...action, amount: money(action.amount) }, null, 2)}`;
}
