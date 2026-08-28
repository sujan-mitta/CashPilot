-- Phase 9: record when an invoice was actually paid.
--
-- Purely additive: one NULLABLE column, no default, NO BACKFILL.
--
-- The absence of a backfill is deliberate. A historical invoice genuinely has
-- no recorded payment date, and deriving one from a row timestamp would
-- fabricate exactly the payment history the behaviour model exists to measure.
-- Null means "unknown", and the model reads unknown as "no opinion".

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "paidAt" TIMESTAMP(3);
