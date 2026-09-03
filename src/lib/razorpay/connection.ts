import { randomBytes } from "node:crypto";
import Razorpay from "razorpay";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret, secretFingerprint, encryptionAvailable } from "@/lib/crypto/secretBox";
import { logger } from "@/lib/observability";

/**
 * Connecting a merchant's own Razorpay account.
 *
 * WHAT THIS IS FOR
 *
 * Without it, every business's payment links are issued on the DEPLOYMENT's
 * account, and the money lands there. Correct for a single-merchant install,
 * wrong the moment there are two.
 *
 * WHAT IT REFUSES, AND WHY
 *
 * Live keys. This system has not been audited for custody of credentials that
 * move real money, and the honest position is to say so rather than accept them
 * and hope. A merchant can connect a test account today and nothing about their
 * real revenue is at risk if this code is wrong.
 *
 * Credentials it has not verified. A key pair is checked against Razorpay
 * before it is stored, so a typo fails at the moment it is entered rather than
 * silently at the moment somebody is owed money.
 *
 * Anything, if encryption is unavailable. Storing a merchant's secret in
 * plaintext is not a degraded mode, it is a breach waiting to be discovered.
 */

export type ConnectMode = "TEST" | "LIVE";

export type ConnectFailure =
  | "ENCRYPTION_UNAVAILABLE"
  | "LIVE_KEYS_REFUSED"
  | "MALFORMED_KEY_ID"
  | "MISSING_SECRET"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNREACHABLE";

export interface ConnectResult {
  ok: boolean;
  failure?: ConnectFailure;
  message?: string;
  /** Only ever the token, never a secret. */
  webhookToken?: string;
  mode?: ConnectMode;
}

/** Razorpay key ids carry their environment in the prefix. */
function modeOf(keyId: string): ConnectMode | null {
  if (keyId.startsWith("rzp_test_")) return "TEST";
  if (keyId.startsWith("rzp_live_")) return "LIVE";
  return null;
}

/**
 * Prove the credentials work before storing them.
 *
 * A read, and the cheapest one available. Creating anything to test a key would
 * leave real objects in a merchant's account as a side effect of pressing
 * "connect", which is not a thing a connect button should do.
 */
async function verifyAgainstProvider(
  keyId: string,
  keySecret: string
): Promise<{ ok: true } | { ok: false; failure: ConnectFailure; message: string }> {
  try {
    const client = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const all = client.paymentLink.all as unknown as (opts: { count: number }) => Promise<unknown>;
    await all({ count: 1 });
    return { ok: true };
  } catch (error) {
    const err = error as { statusCode?: number; error?: { description?: string } };
    const status = err?.statusCode;

    // 401 is a definite answer: these credentials are wrong. Anything else may
    // be the provider having a bad minute, and refusing to store a valid key
    // because Razorpay was briefly unreachable would be its own bug.
    if (status === 401) {
      return {
        ok: false,
        failure: "PROVIDER_REJECTED",
        message: "Razorpay rejected these credentials. Check the key id and secret and try again.",
      };
    }
    logger.warn("Razorpay credential check could not complete", { status });
    return {
      ok: false,
      failure: "PROVIDER_UNREACHABLE",
      message:
        "We could not reach Razorpay to check these credentials. Nothing was saved — please try again shortly.",
    };
  }
}

export async function connectRazorpay(
  businessId: string,
  input: { keyId: string; keySecret: string; webhookSecret?: string }
): Promise<ConnectResult> {
  const keyId = input.keyId?.trim() ?? "";
  const keySecret = input.keySecret?.trim() ?? "";
  const webhookSecret = input.webhookSecret?.trim() || undefined;

  // Checked first: without it there is no safe way to hold what follows, and
  // failing here means nothing was transmitted onwards or written down.
  if (!encryptionAvailable()) {
    return {
      ok: false,
      failure: "ENCRYPTION_UNAVAILABLE",
      message:
        "This deployment cannot store credentials securely yet, so it will not store them at all. Ask an administrator to configure credential encryption.",
    };
  }

  const mode = modeOf(keyId);
  if (!mode) {
    return {
      ok: false,
      failure: "MALFORMED_KEY_ID",
      message: "That does not look like a Razorpay key id. It should begin with rzp_test_.",
    };
  }

  if (mode === "LIVE") {
    return {
      ok: false,
      failure: "LIVE_KEYS_REFUSED",
      message:
        "Live keys are not accepted. CashPilot has not been audited for holding credentials that move real money, so connecting a live account is refused rather than accepted on trust. Use your Razorpay test keys.",
    };
  }

  if (!keySecret) {
    return { ok: false, failure: "MISSING_SECRET", message: "The key secret is required." };
  }

  const verified = await verifyAgainstProvider(keyId, keySecret);
  if (!verified.ok) {
    return { ok: false, failure: verified.failure, message: verified.message };
  }

  // A fresh token on every connect, including a reconnect. If a merchant is
  // replacing credentials because the old ones leaked, the old webhook URL
  // should stop being useful at the same moment.
  const webhookToken = randomBytes(24).toString("base64url");

  await prisma.razorpayConnection.upsert({
    where: { businessId },
    create: {
      businessId,
      keyId,
      keySecretEnc: encryptSecret(keySecret),
      webhookSecretEnc: webhookSecret ? encryptSecret(webhookSecret) : null,
      webhookToken,
      mode,
      keyFingerprint: secretFingerprint(keyId),
      lastVerifiedAt: new Date(),
    },
    update: {
      keyId,
      keySecretEnc: encryptSecret(keySecret),
      webhookSecretEnc: webhookSecret ? encryptSecret(webhookSecret) : null,
      webhookToken,
      mode,
      keyFingerprint: secretFingerprint(keyId),
      lastVerifiedAt: new Date(),
    },
  });

  // Nothing about the credentials is logged, at any level.
  logger.info("Razorpay account connected", { businessId, mode });

  return { ok: true, webhookToken, mode };
}

/**
 * Add or replace only the webhook secret, keeping the same URL.
 *
 * WHY THIS EXISTS SEPARATELY
 *
 * Setting up webhooks is inherently a loop: Razorpay needs the URL before it
 * can be configured, and the secret only exists once the merchant invents one
 * there. Without this, the only way to save that secret was to reconnect —
 * which issues a FRESH token, changing the URL they had just pasted into
 * Razorpay, so it had to be pasted again. A setup step that invalidates itself.
 *
 * The token is deliberately untouched here. Rotating it is the right response
 * to credentials being REPLACED, which is what connect does; adding the webhook
 * secret is completing the same setup, not replacing anything.
 */
export async function setWebhookSecret(
  businessId: string,
  webhookSecret: string
): Promise<{ ok: boolean; message?: string }> {
  if (!encryptionAvailable()) {
    return {
      ok: false,
      message:
        "This deployment cannot store credentials securely yet, so it will not store them at all.",
    };
  }

  const secret = webhookSecret?.trim();
  if (!secret) return { ok: false, message: "The webhook secret is required." };

  const existing = await prisma.razorpayConnection.findUnique({ where: { businessId } });
  if (!existing) {
    return { ok: false, message: "Connect your Razorpay account before adding a webhook secret." };
  }

  await prisma.razorpayConnection.update({
    where: { businessId },
    data: { webhookSecretEnc: encryptSecret(secret) },
  });

  logger.info("Razorpay webhook secret set", { businessId });
  return { ok: true };
}

export async function disconnectRazorpay(businessId: string): Promise<boolean> {
  const existing = await prisma.razorpayConnection.findUnique({ where: { businessId } });
  if (!existing) return false;
  await prisma.razorpayConnection.delete({ where: { businessId } });
  logger.info("Razorpay account disconnected", { businessId });
  return true;
}

export interface ConnectionSummary {
  connected: boolean;
  mode: ConnectMode | null;
  /** Identifies the account without being the key. */
  keyFingerprint: string | null;
  webhooksConfigured: boolean;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  /**
   * The webhook token, so the URL can be shown whenever it is needed rather
   * than only in the seconds after connecting.
   *
   * Not a secret: it selects WHICH key a signature is verified against, and
   * verification still has to pass. Returned only to authenticated members of
   * the business that owns it, which the route enforces.
   */
  webhookToken: string | null;
}

/**
 * What is safe to show about a connection.
 *
 * No key, no secret, not even partially masked. A masked key is still a value
 * that ends up in screenshots and issue trackers, and it answers no question
 * anyone actually has — "which account is this" is answered by the fingerprint.
 */
export async function describeConnection(businessId: string): Promise<ConnectionSummary> {
  const c = await prisma.razorpayConnection.findUnique({ where: { businessId } });
  if (!c) {
    return {
      connected: false,
      mode: null,
      keyFingerprint: null,
      webhooksConfigured: false,
      connectedAt: null,
      lastVerifiedAt: null,
      webhookToken: null,
    };
  }
  return {
    connected: true,
    mode: c.mode as ConnectMode,
    keyFingerprint: c.keyFingerprint,
    webhooksConfigured: Boolean(c.webhookSecretEnc),
    connectedAt: c.connectedAt.toISOString(),
    lastVerifiedAt: c.lastVerifiedAt?.toISOString() ?? null,
    webhookToken: c.webhookToken,
  };
}

/**
 * The decrypted credentials, for making a provider call.
 *
 * Server-only, and never returned through any route. Null when the business has
 * not connected an account, so callers fall back to the deployment's own.
 */
export async function credentialsForBusiness(
  businessId: string
): Promise<{ keyId: string; keySecret: string; mode: ConnectMode } | null> {
  const c = await prisma.razorpayConnection.findUnique({ where: { businessId } });
  if (!c) return null;
  try {
    return { keyId: c.keyId, keySecret: decryptSecret(c.keySecretEnc), mode: c.mode as ConnectMode };
  } catch {
    // An unreadable credential is treated as absent rather than fatal: the
    // caller falls back, and the failure is visible in logs without the
    // ciphertext or the reason being echoed to a user.
    logger.error("Stored Razorpay credential could not be decrypted", { businessId });
    return null;
  }
}

/** The webhook secret for a token, used to verify an inbound request. */
export async function webhookSecretForToken(
  token: string
): Promise<{ businessId: string; secret: string } | null> {
  const c = await prisma.razorpayConnection.findUnique({ where: { webhookToken: token } });
  if (!c?.webhookSecretEnc) return null;
  try {
    return { businessId: c.businessId, secret: decryptSecret(c.webhookSecretEnc) };
  } catch {
    logger.error("Stored webhook secret could not be decrypted", { businessId: c.businessId });
    return null;
  }
}
