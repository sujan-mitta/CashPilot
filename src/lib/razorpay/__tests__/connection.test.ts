import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Accepting custody of someone else's Razorpay credentials.
 *
 * These secrets authorise moving a merchant's money. What matters is mostly
 * what this REFUSES: live keys, unverified keys, and anything at all when the
 * credentials cannot be encrypted.
 */

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
  delete: vi.fn(),
  paymentLinkAll: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    razorpayConnection: {
      upsert: mocks.upsert,
      findUnique: mocks.findUnique,
      delete: mocks.delete,
    },
  },
}));

vi.mock("razorpay", () => ({
  default: class {
    paymentLink = { all: mocks.paymentLinkAll };
  },
}));

vi.mock("@/lib/observability", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { connectRazorpay, describeConnection } from "../connection";

const KEY = "an-encryption-key-long-enough-for-the-tests-0123456789";
const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
  mocks.paymentLinkAll.mockResolvedValue({ payment_links: [] });
  mocks.upsert.mockResolvedValue({});
});

afterEach(() => {
  if (saved === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CREDENTIAL_ENCRYPTION_KEY = saved;
});

const good = { keyId: "rzp_test_abc123", keySecret: "a-real-secret" };

describe("Live keys are refused", () => {
  it("will not accept a live key at all", async () => {
    // This system has not been audited for custody of credentials that move
    // real money. Refusing is the honest position; accepting on trust is not.
    const r = await connectRazorpay("biz", { keyId: "rzp_live_abc", keySecret: "s" });
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("LIVE_KEYS_REFUSED");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not even ask the provider about a live key", async () => {
    // Refused before the secret leaves the process.
    await connectRazorpay("biz", { keyId: "rzp_live_abc", keySecret: "s" });
    expect(mocks.paymentLinkAll).not.toHaveBeenCalled();
  });

  it("says why, rather than just failing", async () => {
    const r = await connectRazorpay("biz", { keyId: "rzp_live_abc", keySecret: "s" });
    expect(r.message).toMatch(/audited/i);
    expect(r.message).toMatch(/test keys/i);
  });
});

describe("Nothing is stored without encryption", () => {
  it("refuses when no encryption key is configured", async () => {
    // Plaintext storage is not a degraded mode, it is a breach waiting to be
    // discovered.
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    const r = await connectRazorpay("biz", good);
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("ENCRYPTION_UNAVAILABLE");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("checks that before contacting the provider", async () => {
    // Failing here means the secret was never transmitted anywhere.
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    await connectRazorpay("biz", good);
    expect(mocks.paymentLinkAll).not.toHaveBeenCalled();
  });
});

describe("Credentials are proven before they are trusted", () => {
  it("stores a key pair the provider accepts", async () => {
    const r = await connectRazorpay("biz", good);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("TEST");
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("refuses a pair the provider rejects", async () => {
    // A typo should fail when it is entered, not silently when somebody is owed
    // money.
    mocks.paymentLinkAll.mockRejectedValue({ statusCode: 401 });
    const r = await connectRazorpay("biz", good);
    expect(r.ok).toBe(false);
    expect(r.failure).toBe("PROVIDER_REJECTED");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("distinguishes a bad credential from an unreachable provider", async () => {
    // Refusing to store a VALID key because Razorpay had a bad minute would be
    // its own bug, so this is reported separately and is retryable.
    mocks.paymentLinkAll.mockRejectedValue({ statusCode: 500 });
    const r = await connectRazorpay("biz", good);
    expect(r.failure).toBe("PROVIDER_UNREACHABLE");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses a key id that is not one", async () => {
    const r = await connectRazorpay("biz", { keyId: "not-a-key", keySecret: "s" });
    expect(r.failure).toBe("MALFORMED_KEY_ID");
  });

  it("refuses an empty secret", async () => {
    const r = await connectRazorpay("biz", { keyId: "rzp_test_abc", keySecret: "  " });
    expect(r.failure).toBe("MISSING_SECRET");
  });
});

describe("What reaches the database", () => {
  it("never writes the secret in plaintext", async () => {
    await connectRazorpay("biz", good);
    const written = JSON.stringify(mocks.upsert.mock.calls[0][0]);
    expect(written).not.toContain("a-real-secret");
    expect(written).toContain("v1:"); // the encrypted envelope
  });

  it("stores a fingerprint rather than relying on the key for identity", async () => {
    await connectRazorpay("biz", good);
    const create = mocks.upsert.mock.calls[0][0].create;
    expect(create.keyFingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("issues a fresh webhook token on every connect", async () => {
    // Including a reconnect. If credentials are being replaced because the old
    // ones leaked, the old webhook URL must stop being useful at the same
    // moment.
    const first = await connectRazorpay("biz", good);
    const second = await connectRazorpay("biz", good);
    expect(first.webhookToken).toBeTruthy();
    expect(second.webhookToken).toBeTruthy();
    expect(first.webhookToken).not.toBe(second.webhookToken);
  });

  it("leaves the webhook secret null when none was given", async () => {
    // An account can be connected before webhooks are configured at Razorpay.
    await connectRazorpay("biz", good);
    expect(mocks.upsert.mock.calls[0][0].create.webhookSecretEnc).toBeNull();
  });

  it("encrypts the webhook secret when one is given", async () => {
    await connectRazorpay("biz", { ...good, webhookSecret: "wh-secret" });
    const written = JSON.stringify(mocks.upsert.mock.calls[0][0]);
    expect(written).not.toContain("wh-secret");
  });
});

describe("What is safe to show back", () => {
  it("reports the connection without any credential in it", async () => {
    mocks.findUnique.mockResolvedValue({
      mode: "TEST",
      keyId: "rzp_test_abc123",
      keyFingerprint: "abcdef123456",
      webhookSecretEnc: "v1:x:y:z",
      connectedAt: new Date("2026-09-01T00:00:00.000Z"),
      lastVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    const summary = await describeConnection("biz");
    const serialized = JSON.stringify(summary);

    expect(summary.connected).toBe(true);
    expect(summary.webhooksConfigured).toBe(true);
    // Not the key, not even masked: a masked key is still a value that ends up
    // in screenshots, and answers no question the fingerprint does not.
    expect(serialized).not.toContain("rzp_test_abc123");
    expect(serialized).not.toContain("v1:x:y:z");
  });

  it("reports an absent connection plainly", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const summary = await describeConnection("biz");
    expect(summary.connected).toBe(false);
    expect(summary.keyFingerprint).toBeNull();
  });
});
