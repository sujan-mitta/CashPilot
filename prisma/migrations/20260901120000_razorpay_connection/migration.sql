-- Per-business Razorpay connections.
--
-- Strictly additive: one new table, no existing column altered or dropped.
-- A business with no row here keeps using the deployment's own credentials, so
-- nothing changes on deploy and merchants connect their own account when they
-- choose to.
--
-- The secret columns hold AES-256-GCM ciphertext, never plaintext. The key
-- lives in the environment (CREDENTIAL_ENCRYPTION_KEY), deliberately not in
-- this database — the whole point is that a dump of it is inert.

CREATE TABLE IF NOT EXISTS "RazorpayConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "keySecretEnc" TEXT NOT NULL,
    "webhookSecretEnc" TEXT,
    "webhookToken" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),

    CONSTRAINT "RazorpayConnection_pkey" PRIMARY KEY ("id")
);

-- One account per business: a second would make "which account issued this
-- link" ambiguous during reconciliation.
CREATE UNIQUE INDEX IF NOT EXISTS "RazorpayConnection_businessId_key" ON "RazorpayConnection"("businessId");

-- The webhook token selects a business from the URL, so it must be unique and
-- is looked up on every inbound webhook.
CREATE UNIQUE INDEX IF NOT EXISTS "RazorpayConnection_webhookToken_key" ON "RazorpayConnection"("webhookToken");

CREATE INDEX IF NOT EXISTS "RazorpayConnection_businessId_idx" ON "RazorpayConnection"("businessId");

ALTER TABLE "RazorpayConnection"
    ADD CONSTRAINT "RazorpayConnection_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
