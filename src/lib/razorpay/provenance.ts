import { createHash } from "node:crypto";
import { describeRazorpayIntegration, type RazorpayMode } from "./status";

/**
 * Which provider account, in which mode, produced a settlement.
 *
 * WHY THE LEDGER NEEDS THIS
 *
 * A settlement from a Razorpay TEST payment and one from a LIVE payment are
 * written to the same FinancialEvent spine and are, today, indistinguishable.
 * Nothing records where the money came from — only that it arrived.
 *
 * That is a correctness problem, not a tidiness one. Test payments are real
 * events at the provider: they settle, they credit the ledger, and they move
 * the forecast. They are also not money. The moment a deployment's key changes
 * from rzp_test_ to rzp_live_, every test-mode row already in the book becomes
 * permanently unidentifiable, and every forecast built afterwards silently
 * counts cash that does not exist.
 *
 * Stamping has to happen BEFORE that flip. Afterwards there is nothing left to
 * infer from — which is exactly why this is worth doing while the deployment is
 * still test-only.
 *
 * WHY AN ACCOUNT FINGERPRINT AND NOT THE KEY
 *
 * Mode alone cannot tell two live accounts apart, and "which merchant account
 * received this" is the question an auditor actually asks. The key id would
 * answer it and must never be written to a row that gets exported, logged or
 * shown. A truncated SHA-256 answers the same question — two settlements either
 * share an account or they do not — while being useless to anyone who obtains
 * it. It is not reversible into a key, and it carries no secret.
 */

export interface ProviderProvenance {
  /** TEST, LIVE, or NOT_CONFIGURED when the provider was simulated. */
  mode: RazorpayMode;
  /**
   * Stable, non-reversible identifier for the merchant account. Null when no
   * real provider was involved, because a simulation has no account.
   */
  accountFingerprint: string | null;
}

/**
 * Twelve hex characters.
 *
 * Long enough that two distinct keys colliding is not a practical concern at
 * any number of accounts this will ever see, short enough to read in a payload
 * without hunting for the end of it.
 */
const FINGERPRINT_LENGTH = 12;

export function fingerprintAccount(keyId: string | undefined): string | null {
  if (!keyId) return null;
  return createHash("sha256").update(keyId, "utf8").digest("hex").slice(0, FINGERPRINT_LENGTH);
}

export function describeProviderProvenance(
  keyId: string | undefined = process.env.RAZORPAY_KEY_ID,
  keySecret: string | undefined = process.env.RAZORPAY_KEY_SECRET
): ProviderProvenance {
  const status = describeRazorpayIntegration(keyId, keySecret);

  // An unconfigured or unrecognised provider gets no fingerprint. Recording one
  // would imply a merchant account was involved when none was, and a simulated
  // settlement must never look like it came from somewhere real.
  if (!status.connected) {
    return { mode: status.mode, accountFingerprint: null };
  }

  return { mode: status.mode, accountFingerprint: fingerprintAccount(keyId) };
}

/**
 * Money in the book that did not come from the account now in use.
 *
 * Pure, so the rule is testable without a database and without a provider.
 *
 * The dangerous direction is asymmetric and worth stating plainly: TEST-mode
 * money sitting in a ledger whose provider is now LIVE is counted as real cash
 * by every forecast, and overstates the runway — the same direction of error as
 * every other bug worth catching in this codebase. The reverse (live money in a
 * test-mode ledger) is a misconfiguration worth surfacing but does not flatter
 * the numbers.
 *
 * Events with no recorded provenance are NOT counted as foreign. They predate
 * stamping, and treating "unknown" as "wrong" would raise an alarm about every
 * row written before this existed — which is most of them, and none of which
 * this can say anything true about.
 */
export interface SettlementProvenanceRow {
  mode?: string | null;
  accountFingerprint?: string | null;
}

export interface ProvenanceMismatch {
  /** Settlements recorded under a mode other than the one now configured. */
  foreignModeCount: number;
  /** True only when the ledger holds test money and the provider is now live. */
  testMoneyInLiveLedger: boolean;
  /** How many rows carry no provenance at all, and so cannot be judged. */
  unattributedCount: number;
  detail: string | null;
}

export function detectProvenanceMismatch(
  rows: SettlementProvenanceRow[],
  currentMode: RazorpayMode
): ProvenanceMismatch {
  let foreignModeCount = 0;
  let unattributedCount = 0;
  let testRows = 0;

  for (const r of rows) {
    if (!r.mode) {
      unattributedCount++;
      continue;
    }
    if (r.mode === "TEST") testRows++;
    if (r.mode !== currentMode) foreignModeCount++;
  }

  const testMoneyInLiveLedger = currentMode === "LIVE" && testRows > 0;

  let detail: string | null = null;
  if (testMoneyInLiveLedger) {
    detail =
      `This ledger contains ${testRows} settlement${testRows === 1 ? "" : "s"} from Razorpay TEST ` +
      "mode while the provider is now LIVE. That money does not exist, and every forecast built " +
      "from this ledger currently counts it as cash.";
  } else if (foreignModeCount > 0) {
    detail =
      `${foreignModeCount} settlement${foreignModeCount === 1 ? "" : "s"} were recorded under a ` +
      `different provider mode than the one now configured (${currentMode}).`;
  }

  return { foreignModeCount, testMoneyInLiveLedger, unattributedCount, detail };
}

/**
 * Provenance for a specific business, which is the only kind worth recording.
 *
 * THE BUG THIS CLOSES
 *
 * `describeProviderProvenance()` reads the DEPLOYMENT's environment. Once a
 * merchant connects their own account, links are issued there and the money
 * lands there — but every settlement was still stamped with the deployment's
 * fingerprint, so the ledger asserted that we received money that had in fact
 * gone to them.
 *
 * Observed live: a connection made at 04:21, a link created on that account at
 * 04:23, settled at 04:25, and stamped with the deployment's account. The one
 * question this stamp exists to answer — which merchant account received this —
 * was answered wrongly, and confidently.
 *
 * Falls back to the deployment's own when a business has connected nothing,
 * which is correct: that is genuinely the account that received it.
 */
export async function describeProviderProvenanceFor(
  businessId: string
): Promise<ProviderProvenance> {
  try {
    // Imported lazily for the same reason the provider client does it: a static
    // import drags Prisma into every consumer of this module, including pure
    // unit tests that never touch a database.
    const { credentialsForBusiness } = await import("./connection");
    const creds = await credentialsForBusiness(businessId);
    if (creds) {
      return { mode: creds.mode, accountFingerprint: fingerprintAccount(creds.keyId) };
    }
  } catch {
    // Unreadable connection state falls through to the deployment's. A
    // settlement must still be recorded; an imperfect stamp beats none, and the
    // failure is visible in the logs of the call that failed.
  }
  return describeProviderProvenance();
}
