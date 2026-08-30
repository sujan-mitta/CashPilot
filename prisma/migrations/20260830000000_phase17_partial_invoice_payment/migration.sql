-- Phase 17 (spec §17): partially paid invoices.
--
-- Strictly additive. One new enum member and one new column with a default, so
-- every existing row reads back identically and no invoice changes status.
--
--   · "PARTIALLY_PAID" is appended to the enum; nothing is reassigned to it.
--   · "paidAmount" defaults to 0, which is the TRUE value for every existing
--     row: none has had a confirmed part payment recorded in this field.
--
-- No column is altered, dropped or backfilled.

ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_PAID';

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "paidAmount" INTEGER NOT NULL DEFAULT 0;
