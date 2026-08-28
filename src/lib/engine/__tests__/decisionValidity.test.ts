import { describe, it, expect } from "vitest";
import {
  checkDecisionValidity,
  tightenForValidity,
  decisionExpiryFrom,
} from "../decisionValidity";
import { FINANCIAL_CONFIG } from "../financialConfig";
import {
  currentForecastVersion,
  FORECAST_PIPELINE_LEDGER,
  FORECAST_PIPELINE_EVENT,
} from "@/lib/forecast/forecastEvent";
import type { FreshnessVerdict, StalenessClassification } from "../strategyFreshness";

const NOW = new Date("2026-09-10T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);
const ahead = (h: number) => new Date(NOW.getTime() + h * HOUR);

const opts = { now: NOW, currentForecastVersion: FORECAST_PIPELINE_LEDGER };

describe("an untracked decision is never blocked by this check", () => {
  it("is UNTRACKED when neither field was recorded", () => {
    // Every decision made before Phase 11 lands here.
    const v = checkDecisionValidity({ forecastVersion: null, expiresAt: null }, opts);
    expect(v.classification).toBe("UNTRACKED");
    expect(v.blocksExecution).toBe(false);
    expect(v.changes).toEqual([]);
  });

  it("is UNTRACKED for a null or missing decision", () => {
    expect(checkDecisionValidity(null, opts).classification).toBe("UNTRACKED");
    expect(checkDecisionValidity(undefined, opts).classification).toBe("UNTRACKED");
    expect(checkDecisionValidity({}, opts).classification).toBe("UNTRACKED");
  });

  it("checks each axis independently, so recording one does not require the other", () => {
    const onlyVersion = checkDecisionValidity({ forecastVersion: FORECAST_PIPELINE_LEDGER }, opts);
    const onlyExpiry = checkDecisionValidity({ expiresAt: ahead(1) }, opts);
    expect(onlyVersion.classification).toBe("VALID");
    expect(onlyExpiry.classification).toBe("VALID");
  });
});

describe("forecast method changes", () => {
  it("blocks a decision produced by a different pipeline", () => {
    // The case the fingerprint structurally cannot see: every fact identical,
    // but the numbers were produced a different way.
    const v = checkDecisionValidity({ forecastVersion: FORECAST_PIPELINE_EVENT }, opts);

    expect(v.classification).toBe("INVALID");
    expect(v.blocksExecution).toBe(true);
    expect(v.changes[0].field).toBe("forecastVersion");
    expect(v.changes[0].reason).toMatch(/forecasting method changed/);
  });

  it("passes a decision produced by the pipeline still in force", () => {
    const v = checkDecisionValidity({ forecastVersion: FORECAST_PIPELINE_LEDGER }, opts);
    expect(v.classification).toBe("VALID");
    expect(v.blocksExecution).toBe(false);
  });

  it("closes C-11 mechanically: flipping the flag invalidates old decisions", () => {
    // The whole point. Previously this depended on a human remembering to bump
    // a config version string in the same change.
    const madeUnderLedger = { forecastVersion: FORECAST_PIPELINE_LEDGER };

    const beforeFlip = checkDecisionValidity(madeUnderLedger, {
      now: NOW,
      currentForecastVersion: currentForecastVersion(false),
    });
    const afterFlip = checkDecisionValidity(madeUnderLedger, {
      now: NOW,
      currentForecastVersion: currentForecastVersion(true),
    });

    expect(beforeFlip.blocksExecution).toBe(false);
    expect(afterFlip.blocksExecution).toBe(true);
  });

  it("reports the two pipeline identities as distinct", () => {
    expect(FORECAST_PIPELINE_LEDGER).not.toBe(FORECAST_PIPELINE_EVENT);
    expect(currentForecastVersion(false)).toBe(FORECAST_PIPELINE_LEDGER);
    expect(currentForecastVersion(true)).toBe(FORECAST_PIPELINE_EVENT);
  });
});

describe("expiry", () => {
  it("passes a recommendation that has not expired", () => {
    const v = checkDecisionValidity({ expiresAt: ahead(1) }, opts);
    expect(v.classification).toBe("VALID");
  });

  it("blocks one that has", () => {
    const v = checkDecisionValidity({ expiresAt: ago(3) }, opts);
    expect(v.classification).toBe("INVALID");
    expect(v.changes[0].field).toBe("expiresAt");
    expect(v.changes[0].reason).toMatch(/expired 3 hour\(s\) ago/);
  });

  it("blocks exactly at the boundary rather than one tick after", () => {
    // An expiry that has arrived has arrived.
    expect(checkDecisionValidity({ expiresAt: NOW }, opts).classification).toBe("INVALID");
  });

  it("explains that nothing contradicted it — the problem is age, not error", () => {
    const v = checkDecisionValidity({ expiresAt: ago(1) }, opts);
    expect(v.changes[0].reason).toMatch(/Nothing in the ledger has contradicted it/);
  });

  it("derives expiry from the configured TTL", () => {
    const created = new Date("2026-09-01T00:00:00Z");
    const expiry = decisionExpiryFrom(created);
    expect(expiry.getTime() - created.getTime()).toBe(
      FINANCIAL_CONFIG.DECISION_TTL_HOURS * HOUR
    );
    // Half the forecast horizon, so a plan is never executed on a stale week.
    expect(FINANCIAL_CONFIG.DECISION_TTL_HOURS / 24).toBeLessThan(
      FINANCIAL_CONFIG.FORECAST_HORIZON_DAYS
    );
  });
});

describe("both axes at once", () => {
  it("reports every reason, not just the first", () => {
    const v = checkDecisionValidity(
      { forecastVersion: FORECAST_PIPELINE_EVENT, expiresAt: ago(5) },
      opts
    );
    expect(v.changes.map((c) => c.field).sort()).toEqual(["expiresAt", "forecastVersion"]);
  });
});

describe("tightenForValidity — the safety property", () => {
  const CLASSES: StalenessClassification[] = [
    "NO_CHANGE",
    "MINOR_CHANGE",
    "MATERIAL_CHANGE",
    "UNKNOWN",
  ];
  const RANK: Record<StalenessClassification, number> = {
    NO_CHANGE: 0,
    MINOR_CHANGE: 1,
    MATERIAL_CHANGE: 2,
    UNKNOWN: 3,
  };

  function verdict(c: StalenessClassification): FreshnessVerdict {
    return {
      classification: c,
      fresh: c === "NO_CHANGE" || c === "MINOR_CHANGE",
      blocksExecution: c === "MATERIAL_CHANGE" || c === "UNKNOWN",
      changes: [],
      decisionFingerprint: "abc",
      currentFingerprint: c === "NO_CHANGE" ? "abc" : "def",
    };
  }

  it("never returns a less severe verdict than it was given", () => {
    const invalid = checkDecisionValidity({ expiresAt: ago(1) }, opts);
    for (const c of CLASSES) {
      const out = tightenForValidity(verdict(c), invalid);
      expect(RANK[out.classification]).toBeGreaterThanOrEqual(RANK[c]);
    }
  });

  it("never unblocks something that was blocked", () => {
    for (const c of CLASSES) {
      for (const validity of [
        checkDecisionValidity(null, opts),
        checkDecisionValidity({ expiresAt: ahead(1) }, opts),
        checkDecisionValidity({ expiresAt: ago(1) }, opts),
      ]) {
        const v = verdict(c);
        const out = tightenForValidity(v, validity);
        if (v.blocksExecution) expect(out.blocksExecution).toBe(true);
      }
    }
  });

  it("returns the input by identity when untracked", () => {
    const untracked = checkDecisionValidity(null, opts);
    for (const c of CLASSES) {
      const v = verdict(c);
      // Identity, not equivalence: a pre-Phase-11 decision is untouched.
      expect(tightenForValidity(v, untracked)).toBe(v);
    }
  });

  it("leaves a valid decision untouched", () => {
    const valid = checkDecisionValidity({ expiresAt: ahead(10) }, opts);
    const v = verdict("NO_CHANGE");
    expect(tightenForValidity(v, valid)).toBe(v);
  });

  it("can block a fingerprint-clean, state-clean recommendation on age alone", () => {
    // The gap Phase 11 exists to close.
    const expired = checkDecisionValidity({ expiresAt: ago(1) }, opts);
    const out = tightenForValidity(verdict("NO_CHANGE"), expired);

    expect(out.classification).toBe("MATERIAL_CHANGE");
    expect(out.blocksExecution).toBe(true);
    expect(out.fresh).toBe(false);
    expect(out.changes[0].field).toBe("expiresAt");
  });

  it("keeps the original reasons alongside the new one", () => {
    const v = verdict("MINOR_CHANGE");
    v.changes = [
      { field: "startingCash", severity: "MINOR", from: 1, to: 2, reason: "cash nudged" },
    ];
    const out = tightenForValidity(v, checkDecisionValidity({ expiresAt: ago(1) }, opts));
    expect(out.changes.map((c) => c.field)).toEqual(["startingCash", "expiresAt"]);
  });
});
