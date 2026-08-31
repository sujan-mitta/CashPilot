import { describe, it, expect } from "vitest";
import {
  describeProviderProvenance,
  fingerprintAccount,
  detectProvenanceMismatch,
} from "../provenance";

/**
 * Recording where settled money came from.
 *
 * A settlement from a Razorpay TEST payment and one from a LIVE payment are
 * written to the same FinancialEvent spine and were, until now, identical.
 * Both settle, both credit the ledger, both move the forecast. Only one of them
 * is money.
 *
 * The stamp has to exist BEFORE a deployment's key changes from rzp_test_ to
 * rzp_live_. Afterwards there is nothing left to infer from, and every test row
 * already in the book is permanently unattributable — counted as cash by every
 * forecast built from it.
 */

const TEST_KEY = "rzp_test_abc123";
const LIVE_KEY = "rzp_live_xyz789";
const SECRET = "a-secret-value";

describe("Provenance is recorded, the key is not", () => {
  it("records the mode", () => {
    expect(describeProviderProvenance(TEST_KEY, SECRET).mode).toBe("TEST");
    expect(describeProviderProvenance(LIVE_KEY, SECRET).mode).toBe("LIVE");
  });

  it("fingerprints the account without containing the key", () => {
    const p = describeProviderProvenance(LIVE_KEY, SECRET);
    expect(p.accountFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(p)).not.toContain(LIVE_KEY);
    expect(JSON.stringify(p)).not.toContain("xyz789");
    expect(JSON.stringify(p)).not.toContain(SECRET);
  });

  it("gives different accounts different fingerprints", () => {
    // The question an auditor asks is "which merchant account received this",
    // and mode alone cannot separate two live accounts.
    expect(fingerprintAccount(LIVE_KEY)).not.toBe(fingerprintAccount("rzp_live_other"));
  });

  it("gives the same account the same fingerprint every time", () => {
    expect(fingerprintAccount(TEST_KEY)).toBe(fingerprintAccount(TEST_KEY));
  });

  it("records no account when the provider was simulated", () => {
    // A simulated settlement must never look like it came from somewhere real.
    const p = describeProviderProvenance(undefined, undefined);
    expect(p.accountFingerprint).toBeNull();
    expect(p.mode).toBe("NOT_CONFIGURED");
    expect(fingerprintAccount(undefined)).toBeNull();
  });

  it("records no account for placeholder credentials", () => {
    expect(describeProviderProvenance("rzp_test_placeholder", SECRET).accountFingerprint).toBeNull();
  });
});

describe("Test money in a live ledger", () => {
  const test = { mode: "TEST", accountFingerprint: "aaaaaaaaaaaa" };
  const live = { mode: "LIVE", accountFingerprint: "bbbbbbbbbbbb" };

  it("is the case that actually matters", () => {
    // Test settlements in a live ledger are counted as real cash by every
    // forecast, which OVERSTATES the runway — the same direction of error as
    // every other bug worth catching here.
    const r = detectProvenanceMismatch([live, test, live], "LIVE");
    expect(r.testMoneyInLiveLedger).toBe(true);
    expect(r.detail).toMatch(/does not exist/i);
  });

  it("is not raised when the ledger is clean", () => {
    const r = detectProvenanceMismatch([live, live], "LIVE");
    expect(r.testMoneyInLiveLedger).toBe(false);
    expect(r.foreignModeCount).toBe(0);
    expect(r.detail).toBeNull();
  });

  it("is not raised for a test-mode deployment full of test money", () => {
    // Which is the normal, correct state of a test deployment.
    const r = detectProvenanceMismatch([test, test], "TEST");
    expect(r.testMoneyInLiveLedger).toBe(false);
    expect(r.detail).toBeNull();
  });

  it("still reports a plain mode mismatch in the harmless direction", () => {
    // Live money in a test ledger is a misconfiguration worth surfacing, but it
    // does not flatter the numbers, so it is reported without the alarm.
    const r = detectProvenanceMismatch([live], "TEST");
    expect(r.foreignModeCount).toBe(1);
    expect(r.testMoneyInLiveLedger).toBe(false);
    expect(r.detail).toMatch(/different provider mode/i);
  });
});

describe("Rows written before stamping existed", () => {
  it("are counted as unattributed, never as foreign", () => {
    // Treating "unknown" as "wrong" would raise an alarm about every row
    // written before this existed — which is most of them, and none of which
    // this can say anything true about.
    const r = detectProvenanceMismatch([{}, { mode: null }, { mode: "LIVE" }], "LIVE");
    expect(r.unattributedCount).toBe(2);
    expect(r.foreignModeCount).toBe(0);
    expect(r.detail).toBeNull();
  });

  it("does not claim test money purely because provenance is missing", () => {
    const r = detectProvenanceMismatch([{}, {}], "LIVE");
    expect(r.testMoneyInLiveLedger).toBe(false);
  });
});

describe("An empty ledger", () => {
  it("reports nothing", () => {
    const r = detectProvenanceMismatch([], "LIVE");
    expect(r).toMatchObject({
      foreignModeCount: 0,
      unattributedCount: 0,
      testMoneyInLiveLedger: false,
      detail: null,
    });
  });
});
