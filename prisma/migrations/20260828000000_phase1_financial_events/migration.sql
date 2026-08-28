-- Phase 1: Canonical Financial Events.
-- Purely additive: one new enum + one new table. No existing table is touched,
-- so every existing row reads back identically. The table has no consumers yet.

-- CreateEnum
CREATE TYPE "FinancialEventType" AS ENUM ('INVOICE_CREATED', 'INVOICE_DUE', 'INVOICE_OVERDUE', 'INVOICE_PAID', 'PAYMENT_RECEIVED', 'PAYMENT_FAILED', 'PAYOUT_SCHEDULED', 'PAYOUT_SETTLED', 'PAYOUT_RESCHEDULED', 'PAYOUT_PAUSED', 'BANK_TRANSACTION', 'SETTLEMENT', 'USER_ADJUSTMENT');

-- CreateTable
CREATE TABLE "FinancialEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "eventType" "FinancialEventType" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "entityId" TEXT,
    "amount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT,
    "normalizedData" JSONB,
    "rawReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinancialEvent_businessId_idx" ON "FinancialEvent"("businessId");

-- CreateIndex
CREATE INDEX "FinancialEvent_businessId_effectiveAt_idx" ON "FinancialEvent"("businessId", "effectiveAt");

-- CreateIndex
CREATE INDEX "FinancialEvent_businessId_entityId_idx" ON "FinancialEvent"("businessId", "entityId");

-- CreateIndex
CREATE INDEX "FinancialEvent_eventType_idx" ON "FinancialEvent"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialEvent_businessId_sourceType_sourceRecordId_key" ON "FinancialEvent"("businessId", "sourceType", "sourceRecordId");
