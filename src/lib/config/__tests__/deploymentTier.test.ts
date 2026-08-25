import { describe, it, expect, vi, afterEach } from "vitest";
import {
  inspectConfiguration,
  assertFinanciallySafeConfiguration,
  resolveDeploymentTier,
  ConfigurationError,
} from "../productionConfig";

/**
 * DEPLOYMENT TIER — separating "built for production" from "moves real money".
 *
 * Observed live: a Vercel deployment returned
 *   503 FINANCIAL_CONFIGURATION_INVALID  missing: ["RAZORPAY_KEY_ID"]
 * on every execute request. The guard was correct in intent — a test-mode key
 * in production means payments are simulated while the system reports success —
 * but Vercel sets NODE_ENV=production on EVERY deployment, including a
 * certification box whose entire purpose is to exercise the provider in test
 * mode. The guard had no way to tell those apart.
 *
 * The tier is the missing distinction. It fails safe: anything that is not
 * exactly "certification" is treated as production, so no deployment can
 * loosen a financial control through omission or a typo.
 */

const ENV = {
  live: "rzp_live_realkey123",
  test: "rzp_test_abcdef123456",
};

/** Minimum config for a report with no unrelated FATALs. */
function baseEnv(keyId: string) {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pw@db.example.com/app");
  vi.stubEnv("SESSION_SECRET", "x".repeat(64));
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "whsec_" + "y".repeat(40));
  vi.stubEnv("RAZORPAY_KEY_ID", keyId);
  vi.stubEnv("RAZORPAY_KEY_SECRET", "z".repeat(24));
}

afterEach(() => vi.unstubAllEnvs());

describe("resolveDeploymentTier fails safe", () => {
  it("defaults to production when unset", () => {
    expect(resolveDeploymentTier(undefined)).toBe("production");
  });

  it("treats a typo or unknown value as production, never as a loosened tier", () => {
    for (const v of ["", "  ", "certifcation", "cert", "staging", "CERTIFICATION!", "true"]) {
      expect(resolveDeploymentTier(v)).toBe("production");
    }
  });

  it("accepts only the exact word, case- and whitespace-insensitively", () => {
    for (const v of ["certification", "CERTIFICATION", " Certification "]) {
      expect(resolveDeploymentTier(v)).toBe("certification");
    }
  });
});

describe("production tier keeps the original guard intact", () => {
  it("THE ORIGINAL DEFECT still fires: a test key in real production is FATAL", () => {
    baseEnv(ENV.test);
    const r = inspectConfiguration("production", "production");
    expect(r.financiallyUnsafe).toBe(true);
    expect(r.fatalKeys).toContain("RAZORPAY_KEY_ID");
    expect(() => assertFinanciallySafeConfiguration("production")).toThrow(ConfigurationError);
  });

  it("a live key in production is accepted", () => {
    baseEnv(ENV.live);
    const r = inspectConfiguration("production", "production");
    expect(r.financiallyUnsafe).toBe(false);
    expect(r.fatalKeys).not.toContain("RAZORPAY_KEY_ID");
  });
});

describe("certification tier admits test keys, loudly", () => {
  it("THE FIX: a test key no longer blocks a certification deployment", () => {
    baseEnv(ENV.test);
    const r = inspectConfiguration("production", "certification");
    expect(r.financiallyUnsafe).toBe(false);
    expect(r.fatalKeys).not.toContain("RAZORPAY_KEY_ID");
  });

  it("but it is never silent — it is reported as DEGRADED with a reason", () => {
    baseEnv(ENV.test);
    const r = inspectConfiguration("production", "certification");
    expect(r.degradedKeys).toContain("RAZORPAY_KEY_ID");
    const d = r.defects.find((x) => x.key === "RAZORPAY_KEY_ID");
    expect(d?.problem).toMatch(/no real money can move/i);
    expect(r.tier).toBe("certification");
  });

  it("a LIVE key on a certification tier is FATAL — the mirror-image danger", () => {
    baseEnv(ENV.live);
    const r = inspectConfiguration("production", "certification");
    expect(r.financiallyUnsafe).toBe(true);
    expect(r.fatalKeys).toContain("RAZORPAY_KEY_ID");
    const d = r.defects.find((x) => x.key === "RAZORPAY_KEY_ID");
    expect(d?.problem).toMatch(/real money must never move from a certification tier/i);
  });
});

describe("the tier loosens nothing else", () => {
  it("a missing webhook secret stays FATAL on certification", () => {
    baseEnv(ENV.test);
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "");
    const r = inspectConfiguration("production", "certification");
    expect(r.fatalKeys).toContain("RAZORPAY_WEBHOOK_SECRET");
    expect(r.financiallyUnsafe).toBe(true);
  });

  it("a localhost database stays FATAL on certification", () => {
    baseEnv(ENV.test);
    vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:51214/postgres");
    const r = inspectConfiguration("production", "certification");
    expect(r.fatalKeys).toContain("DATABASE_URL");
  });

  it("a weak session secret stays FATAL on certification", () => {
    baseEnv(ENV.test);
    vi.stubEnv("SESSION_SECRET", "short");
    const r = inspectConfiguration("production", "certification");
    expect(r.fatalKeys).toContain("SESSION_SECRET");
  });

  it("no secret VALUE ever appears in the report", () => {
    baseEnv(ENV.test);
    const dump = JSON.stringify(inspectConfiguration("production", "certification"));
    expect(dump).not.toContain("z".repeat(24));
    expect(dump).not.toContain("x".repeat(64));
    expect(dump).not.toMatch(/whsec_y/);
  });
});
