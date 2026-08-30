import { describe, it, expect } from "vitest";
import {
  describeFreshness,
  expiringSoonThresholdHours,
  EXPIRING_SOON_FRACTION,
} from "../decisionFreshnessDisplay";
import { FINANCIAL_CONFIG } from "../financialConfig";

/**
 * Telling an operator a recommendation is ageing, before it refuses.
 *
 * Expiry currently reaches the user exactly once: as a refusal, at the moment
 * they try to approve. That is the worst possible time to learn it — they have
 * read the plan, decided, and committed to acting.
 *
 * This is DISPLAY ONLY. The property that matters most is what it does not do:
 * it must never become a second authority on whether a decision is executable.
 * `checkDecisionValidity` owns that, and two places deciding would eventually
 * disagree, with the one that ran second winning by accident.
 */

const T0 = new Date("2026-09-10T12:00:00.000Z");
const hoursFromNow = (h: number) => new Date(T0.getTime() + h * 60 * 60 * 1000);

describe("The three bands", () => {
  it("is CURRENT well inside the window", () => {
    const r = describeFreshness(hoursFromNow(FINANCIAL_CONFIG.DECISION_TTL_HOURS - 1), T0);
    expect(r.band).toBe("CURRENT");
  });

  it("is EXPIRING_SOON inside the warning threshold", () => {
    const r = describeFreshness(hoursFromNow(expiringSoonThresholdHours() - 1), T0);
    expect(r.band).toBe("EXPIRING_SOON");
    expect(r.label).toMatch(/expires in/i);
  });

  it("is EXPIRED once past", () => {
    const r = describeFreshness(hoursFromNow(-1), T0);
    expect(r.band).toBe("EXPIRED");
    expect(r.detail).toMatch(/re-run/i);
  });

  it("treats the exact boundary as expired, not current", () => {
    // At the instant of expiry the gate refuses. The display must not disagree
    // with the gate at its own boundary.
    expect(describeFreshness(T0, T0).band).toBe("EXPIRED");
  });
});

describe("An absent expiry is not an expiry", () => {
  it("reports UNKNOWN rather than EXPIRED for a null", () => {
    // Decisions predating expiry tracking were deliberately never backfilled.
    // Treating an absent value as expired would retroactively invalidate every
    // older recommendation on screen.
    const r = describeFreshness(null, T0);
    expect(r.band).toBe("UNKNOWN");
    expect(r.hoursRemaining).toBeNull();
  });

  it("reports UNKNOWN for undefined and for an unparseable value", () => {
    expect(describeFreshness(undefined, T0).band).toBe("UNKNOWN");
    expect(describeFreshness("not a date", T0).band).toBe("UNKNOWN");
  });
});

describe("The threshold is derived, not fixed", () => {
  it("is a quarter of the configured TTL", () => {
    // Derived so the two cannot drift apart if the TTL is ever tuned. A fixed
    // warning window against a changed TTL either never fires or never stops.
    expect(expiringSoonThresholdHours()).toBe(
      FINANCIAL_CONFIG.DECISION_TTL_HOURS * EXPIRING_SOON_FRACTION
    );
  });

  it("leaves a daily checker at least one warning before the refusal", () => {
    // The warning window has to exceed 24 hours, or an operator who looks once
    // a day can go from CURRENT straight to EXPIRED and never see it coming.
    expect(expiringSoonThresholdHours()).toBeGreaterThan(24);
  });
});

describe("Wording", () => {
  it("accepts an ISO string as well as a Date", () => {
    const iso = hoursFromNow(10).toISOString();
    expect(describeFreshness(iso, T0).band).toBe("EXPIRING_SOON");
  });

  it("says days for long windows and hours for short ones", () => {
    expect(describeFreshness(hoursFromNow(72), T0).label).toMatch(/day/);
    expect(describeFreshness(hoursFromNow(3), T0).label).toMatch(/hour/);
  });

  it("never renders a bare zero", () => {
    // "Expires in 0 minutes" reads as broken. Under an hour it rounds up.
    const r = describeFreshness(new Date(T0.getTime() + 20 * 1000), T0);
    expect(r.label).not.toMatch(/\b0 /);
  });

  it("always carries a sentence a user can read", () => {
    for (const at of [hoursFromNow(200), hoursFromNow(10), hoursFromNow(-5), null]) {
      const r = describeFreshness(at, T0);
      expect(r.detail.length).toBeGreaterThan(20);
      expect(r.label.length).toBeGreaterThan(0);
    }
  });
});
