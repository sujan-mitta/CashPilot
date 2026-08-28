-- Phase 11: forecast-method identity and recommendation expiry on Decision.
--
-- Purely additive: two NULLABLE columns, no defaults, NO BACKFILL.
--
-- The absence of a backfill is what keeps this inert. A decision made before
-- these existed carries null in both, which the freshness gate reads as
-- "untracked" and ignores - so no existing recommendation changes behaviour,
-- and in particular none is retroactively expired.

-- AlterTable
ALTER TABLE "Decision" ADD COLUMN "forecastVersion" TEXT;

-- AlterTable
ALTER TABLE "Decision" ADD COLUMN "expiresAt" TIMESTAMP(3);
