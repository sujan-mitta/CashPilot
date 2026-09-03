import { describe, it, expect } from "vitest";
import { renderSettlementEmail } from "../settlementEmail";
import type { SafetyProgress } from "@/lib/engine/safetyProgress";

/**
 * The message an operator gets when money arrives.
 *
 * "You received Rs 2,40,000" is pleasant and not actionable. The question it
 * immediately raises is whether that was enough, and leaving it unanswered
 * means opening the app to work it out.
 */

const shortfall: SafetyProgress = {
  status: "SHORTFALL",
  projectedLow: -180_000_00,
  safeFloor: 429_000_00,
  recovered: 240_000_00,
  outstanding: 0,
  shortfall: 609_000_00,
  outstandingCoversShortfall: false,
  stillNeededBeyondOutstanding: 609_000_00,
  headline: "More is needed",
  detail: "Still below the floor.",
};

const safe: SafetyProgress = {
  ...shortfall,
  status: "SAFE",
  projectedLow: 500_000_00,
  shortfall: 0,
  stillNeededBeyondOutstanding: 0,
};

const base = {
  recipientName: "Sujan",
  businessName: "Sujan Verify Co",
  payment: { amount: 240_000_00, description: "Failed payment - Order #4790", paymentLinkId: "plink_x" },
  currentCash: 1_240_000_00,
};

describe("The subject carries the fact worth carrying", () => {
  it("states the amount and the business", () => {
    // Many people read only the subject line. It has to survive being the whole
    // message.
    const { subject } = renderSettlementEmail({ ...base, progress: shortfall });
    expect(subject).toContain("₹2,40,000");
    expect(subject).toContain("Sujan Verify Co");
  });
});

describe("It answers 'was that enough?' immediately", () => {
  it("says how far short you still are", () => {
    const { text, html } = renderSettlementEmail({ ...base, progress: shortfall });
    expect(text).toMatch(/still ₹6,09,000 below your safe floor/i);
    expect(html).toContain("₹6,09,000");
  });

  it("says plainly when nothing more is needed", () => {
    const { text } = renderSettlementEmail({ ...base, progress: safe });
    expect(text).toMatch(/clears your safe floor/i);
    expect(text).toMatch(/nothing further is needed/i);
  });

  it("does not tell a safe business how short it is", () => {
    const { text } = renderSettlementEmail({ ...base, progress: safe });
    expect(text).not.toMatch(/still short/i);
  });
});

describe("The figures behind the verdict are shown", () => {
  it("reports cash, projected low and the floor", () => {
    const { text } = renderSettlementEmail({ ...base, progress: shortfall });
    expect(text).toContain("₹12,40,000"); // cash
    expect(text).toContain("₹-1,80,000"); // projected low
    expect(text).toContain("₹4,29,000"); // floor
  });

  it("says the figures are current, not from when the link was issued", () => {
    // Otherwise a reader cannot tell whether the report predates their payment.
    const { text } = renderSettlementEmail({ ...base, progress: shortfall });
    expect(text).toMatch(/recalculated after this payment landed/i);
  });
});

describe("Money still out for collection", () => {
  it("says when it would be enough", () => {
    const covered = { ...shortfall, outstanding: 700_000_00, outstandingCoversShortfall: true, stillNeededBeyondOutstanding: 0 };
    const { text } = renderSettlementEmail({ ...base, progress: covered });
    expect(text).toMatch(/if it is all paid, you are clear/i);
  });

  it("says when it would not be", () => {
    const partial = { ...shortfall, outstanding: 100_000_00, stillNeededBeyondOutstanding: 509_000_00 };
    const { text } = renderSettlementEmail({ ...base, progress: partial });
    expect(text).toMatch(/still be ₹5,09,000 short/i);
  });

  it("says when there is nothing out at all", () => {
    const { text } = renderSettlementEmail({ ...base, progress: shortfall });
    expect(text).toMatch(/nothing else is currently out/i);
  });
});

describe("Ledger text is escaped", () => {
  it("does not let a description inject markup", () => {
    // A transaction description is operator-entered and reaches the email
    // unchanged. Unescaped, it would render as markup in the recipient's client.
    const nasty = { ...base.payment, description: '<img src=x onerror="alert(1)">' };
    const { html } = renderSettlementEmail({ ...base, payment: nasty, progress: shortfall });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("escapes the business name too", () => {
    const { html } = renderSettlementEmail({
      ...base,
      businessName: 'Acme "Ltd" & Co <script>',
      progress: shortfall,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("Both parts say the same things", () => {
  it("puts the amount and the verdict in text as well as html", () => {
    // The text part is what a screen reader and a text-only client render.
    for (const progress of [shortfall, safe]) {
      const { text, html } = renderSettlementEmail({ ...base, progress });
      expect(text).toContain("₹2,40,000");
      expect(html).toContain("₹2,40,000");
      expect(text.length).toBeGreaterThan(200);
    }
  });
});
