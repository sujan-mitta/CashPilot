-- Email verification.
--
-- Strictly additive. One nullable column and one new table; no existing column
-- is altered, dropped or backfilled.
--
-- "User"."emailVerified" is NULL for every existing account, which means
-- "unproven" rather than "invalid". Those accounts keep working; they simply do
-- not receive outbound alerts until the address is confirmed, which is the
-- point: a bounce from a non-existent recipient comes back to us.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerified" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "EmailVerificationCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EmailVerificationCode_userId_idx" ON "EmailVerificationCode"("userId");
CREATE INDEX IF NOT EXISTS "EmailVerificationCode_email_idx" ON "EmailVerificationCode"("email");
CREATE INDEX IF NOT EXISTS "EmailVerificationCode_expiresAt_idx" ON "EmailVerificationCode"("expiresAt");

ALTER TABLE "EmailVerificationCode"
    ADD CONSTRAINT "EmailVerificationCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
