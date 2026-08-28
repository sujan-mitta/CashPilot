-- Phase 7: record which financial state a decision was generated against.
--
-- Purely additive: one NULLABLE column with no default and no backfill. Every
-- existing decision keeps a null, which the freshness gate reads as NOT_TRACKED
-- and ignores - so this migration cannot change the outcome of any freshness
-- check on any existing row.

-- AlterTable
ALTER TABLE "Decision" ADD COLUMN "financialStateVersion" INTEGER;
