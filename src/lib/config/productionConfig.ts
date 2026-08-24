/**
 * ===========================================================================
 * PRODUCTION CONFIGURATION VALIDATION  (Phase 16 PART 7)
 * ===========================================================================
 *
 * Financial-integrity controls must not be silently disabled by a missing
 * environment variable. Phase 14 found exactly that failure mode: with
 * RAZORPAY_WEBHOOK_SECRET unset the webhook route skipped signature
 * verification entirely, turning an unauthenticated HTTP request into a
 * ledger-write primitive.
 *
 * This module states, in one place, which variables are load-bearing for
 * financial integrity and what happens when they are absent.
 *
 * No secret VALUE is ever read out, logged, or returned - only presence.
 */

export type ConfigSeverity = "FATAL" | "DEGRADED" | "OK";

export interface ConfigCheck {
  key: string;
  present: boolean;
  severity: ConfigSeverity;
  /** What breaks without it. */
  impact: string;
  /** Behaviour outside production, stated explicitly rather than implied. */
  nonProductionBehaviour: string;
}

export interface ConfigReport {
  environment: string;
  isProduction: boolean;
  checks: ConfigCheck[];
  /** Structural problems with values that ARE set. */
  defects: ConfigDefect[];
  /** True when at least one FATAL control is missing or malformed in production. */
  financiallyUnsafe: boolean;
  fatalKeys: string[];
  degradedKeys: string[];
}

function present(key: string): boolean {
  const v = process.env[key];
  return typeof v === "string" && v.trim().length > 0 && !v.includes("placeholder");
}

/**
 * Structural validation, separate from presence.
 *
 * A variable can be set and still be wrong in a way that silently disables a
 * control - a test-mode Razorpay key in production means every "payment" is a
 * sandbox no-op while the UI reports success.
 */
export interface ConfigDefect {
  key: string;
  problem: string;
  severity: ConfigSeverity;
}

export function detectMalformedConfiguration(isProduction: boolean): ConfigDefect[] {
  const defects: ConfigDefect[] = [];

  const keyId = process.env.RAZORPAY_KEY_ID ?? "";
  if (keyId && !/^rzp_(test|live)_/.test(keyId)) {
    defects.push({
      key: "RAZORPAY_KEY_ID",
      problem: "Does not look like a Razorpay key (expected an rzp_test_ or rzp_live_ prefix).",
      severity: isProduction ? "FATAL" : "DEGRADED",
    });
  }
  if (isProduction && keyId.startsWith("rzp_test_")) {
    // The most dangerous misconfiguration there is: everything "works", and no
    // money ever moves.
    defects.push({
      key: "RAZORPAY_KEY_ID",
      problem: "A TEST-mode Razorpay key is configured in production. Payments would be simulated while the system reports success.",
      severity: "FATAL",
    });
  }

  const db = process.env.DATABASE_URL ?? "";
  if (isProduction && /@localhost|@127\.0\.0\.1/.test(db)) {
    defects.push({
      key: "DATABASE_URL",
      problem: "Production is pointed at a local database.",
      severity: "FATAL",
    });
  }
  if (db && !/^postgres(ql)?:\/\//.test(db)) {
    defects.push({
      key: "DATABASE_URL",
      problem: "Is not a PostgreSQL connection string.",
      severity: isProduction ? "FATAL" : "DEGRADED",
    });
  }

  const session = process.env.SESSION_SECRET ?? "";
  if (session && session.length < 32) {
    defects.push({
      key: "SESSION_SECRET",
      problem: "Shorter than 32 characters; session signatures would be weak.",
      severity: isProduction ? "FATAL" : "DEGRADED",
    });
  }

  return defects;
}

/**
 * Checks every variable that carries financial weight.
 *
 * `FATAL` means: in production, this absence lets money move without a control
 * that is supposed to be guarding it. `DEGRADED` means the system stays safe but
 * loses a capability (and must say so rather than pretend).
 */
export function inspectConfiguration(env: string = process.env.NODE_ENV ?? "development"): ConfigReport {
  const isProduction = env === "production";

  const definitions: Omit<ConfigCheck, "present" | "severity">[] = [
    {
      key: "DATABASE_URL",
      impact:
        "Without a database there is no durable execution intent, so no external operation can be made recoverable.",
      nonProductionBehaviour: "Startup fails immediately in every environment; this is never optional.",
    },
    {
      key: "SESSION_SECRET",
      impact:
        "Sessions fall back to a hardcoded development key, so any party could forge a session and act as any tenant.",
      nonProductionBehaviour: "A known development default is used, and tenant isolation is not trustworthy.",
    },
    {
      key: "RAZORPAY_WEBHOOK_SECRET",
      impact:
        "Webhook signatures cannot be verified, making settlement callbacks unauthenticated ledger writes.",
      nonProductionBehaviour:
        "Signature checking is skipped and a warning is logged; the sandbox accepts unsigned webhooks.",
    },
    {
      key: "RAZORPAY_KEY_ID",
      impact:
        "No live payment provider, so payment links cannot be issued and UNKNOWN operations cannot be reconciled against the provider.",
      nonProductionBehaviour: "A simulated provider issues deterministic sandbox links.",
    },
    {
      key: "RAZORPAY_KEY_SECRET",
      impact: "Same as RAZORPAY_KEY_ID; the provider client cannot authenticate.",
      nonProductionBehaviour: "A simulated provider issues deterministic sandbox links.",
    },
  ];

  const fatalInProduction = new Set([
    "DATABASE_URL",
    "SESSION_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
  ]);

  const checks: ConfigCheck[] = definitions.map((d) => {
    const isPresent = present(d.key);
    let severity: ConfigSeverity = "OK";
    if (!isPresent) {
      severity = isProduction && fatalInProduction.has(d.key) ? "FATAL" : "DEGRADED";
    }
    return { ...d, present: isPresent, severity };
  });

  const defects = detectMalformedConfiguration(isProduction);

  const fatalKeys = [
    ...checks.filter((c) => c.severity === "FATAL").map((c) => c.key),
    ...defects.filter((d) => d.severity === "FATAL").map((d) => d.key),
  ];
  const degradedKeys = [
    ...checks.filter((c) => c.severity === "DEGRADED").map((c) => c.key),
    ...defects.filter((d) => d.severity === "DEGRADED").map((d) => d.key),
  ];

  return {
    environment: env,
    isProduction,
    checks,
    defects,
    financiallyUnsafe: fatalKeys.length > 0,
    fatalKeys: Array.from(new Set(fatalKeys)),
    degradedKeys: Array.from(new Set(degradedKeys)),
  };
}

export class ConfigurationError extends Error {
  readonly code = "FINANCIAL_CONFIGURATION_INVALID";
  constructor(readonly missing: string[]) {
    super(
      `Missing required financial-integrity configuration in production: ${missing.join(", ")}. ` +
        `Refusing to operate.`
    );
    this.name = "ConfigurationError";
  }
}

/**
 * Throws when production is missing a control that guards money movement.
 *
 * Call this from any route that can move money or accept an external financial
 * instruction. Deliberately a throw rather than a boolean - a caller that
 * forgets to check a boolean fails open, which is the failure mode this exists
 * to prevent.
 */
export function assertFinanciallySafeConfiguration(
  env: string = process.env.NODE_ENV ?? "development"
): ConfigReport {
  const report = inspectConfiguration(env);
  if (report.financiallyUnsafe) {
    throw new ConfigurationError(report.fatalKeys);
  }
  return report;
}

/**
 * A redacted summary safe to return over HTTP or write to a log.
 * Presence only - never a value, never a prefix, never a length.
 */
export function redactedConfigSummary(report: ConfigReport): {
  environment: string;
  financiallyUnsafe: boolean;
  controls: { key: string; configured: boolean; severity: ConfigSeverity }[];
  defects: { key: string; problem: string; severity: ConfigSeverity }[];
} {
  return {
    environment: report.environment,
    financiallyUnsafe: report.financiallyUnsafe,
    controls: report.checks.map((c) => ({
      key: c.key,
      configured: c.present,
      severity: c.severity,
    })),
    // Problem descriptions only - never the offending value.
    defects: report.defects.map((d) => ({ key: d.key, problem: d.problem, severity: d.severity })),
  };
}
