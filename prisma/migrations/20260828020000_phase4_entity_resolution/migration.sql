-- Phase 4: Entity Resolution (canonical Customer / Supplier).
--
-- Additive only:
--   * one new enum + two new tables (CounterpartyAlias -> Counterparty)
--   * one NULLABLE column on Invoice and on Payout, plus their indexes
--
-- No existing column is altered, dropped or backfilled by this migration, so
-- every existing row reads back identically and the engine (which never reads
-- counterpartyId) behaves exactly as before. Linking is done later by an
-- explicit backfill, not by DDL.

-- CreateEnum
CREATE TYPE "CounterpartyType" AS ENUM ('CUSTOMER', 'SUPPLIER');

-- CreateTable
CREATE TABLE "Counterparty" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "type" "CounterpartyType" NOT NULL,
    "displayName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "mergedIntoId" TEXT,
    "mergedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Counterparty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CounterpartyAlias" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "type" "CounterpartyType" NOT NULL,
    "rawName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "matchMethod" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CounterpartyAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Counterparty_businessId_idx" ON "Counterparty"("businessId");

-- CreateIndex
CREATE INDEX "Counterparty_businessId_type_idx" ON "Counterparty"("businessId", "type");

-- CreateIndex
CREATE INDEX "Counterparty_mergedIntoId_idx" ON "Counterparty"("mergedIntoId");

-- CreateIndex
CREATE UNIQUE INDEX "Counterparty_businessId_type_normalizedName_key" ON "Counterparty"("businessId", "type", "normalizedName");

-- CreateIndex
CREATE INDEX "CounterpartyAlias_businessId_idx" ON "CounterpartyAlias"("businessId");

-- CreateIndex
CREATE INDEX "CounterpartyAlias_counterpartyId_idx" ON "CounterpartyAlias"("counterpartyId");

-- CreateIndex
CREATE UNIQUE INDEX "CounterpartyAlias_businessId_type_normalizedName_key" ON "CounterpartyAlias"("businessId", "type", "normalizedName");

-- AddForeignKey
ALTER TABLE "CounterpartyAlias" ADD CONSTRAINT "CounterpartyAlias_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable (nullable, no default, no rewrite of existing rows)
ALTER TABLE "Invoice" ADD COLUMN "counterpartyId" TEXT;

-- AlterTable
ALTER TABLE "Payout" ADD COLUMN "counterpartyId" TEXT;

-- CreateIndex
CREATE INDEX "Invoice_businessId_counterpartyId_idx" ON "Invoice"("businessId", "counterpartyId");

-- CreateIndex
CREATE INDEX "Payout_businessId_counterpartyId_idx" ON "Payout"("businessId", "counterpartyId");
