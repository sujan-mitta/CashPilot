-- Phase 2: Evidence + Claims.
-- Purely additive: one new enum + two new related tables (Evidence -> Claim).
-- No existing table is touched. The tables have no production consumers yet.

-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('ACTUAL', 'CONFIRMED', 'CONTRACTUAL', 'EXPECTED', 'PREDICTED', 'UNCERTAIN', 'CONTRADICTED', 'EXPIRED', 'RECONCILED');

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "claimType" "ClaimType" NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "assertion" JSONB NOT NULL,
    "amount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "effectiveAt" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "financialEventId" TEXT,
    "evidenceType" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "effectiveAt" TIMESTAMP(3),
    "reliabilityScore" DOUBLE PRECISION,
    "freshnessScore" DOUBLE PRECISION,
    "specificityScore" DOUBLE PRECISION,
    "historicalAccuracyScore" DOUBLE PRECISION,
    "consistencyScore" DOUBLE PRECISION,
    "derivedConfidence" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Claim_businessId_idx" ON "Claim"("businessId");

-- CreateIndex
CREATE INDEX "Claim_businessId_subjectType_subjectId_idx" ON "Claim"("businessId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "Claim_businessId_claimType_idx" ON "Claim"("businessId", "claimType");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_businessId_subjectType_subjectId_claimType_key" ON "Claim"("businessId", "subjectType", "subjectId", "claimType");

-- CreateIndex
CREATE INDEX "Evidence_businessId_idx" ON "Evidence"("businessId");

-- CreateIndex
CREATE INDEX "Evidence_claimId_idx" ON "Evidence"("claimId");

-- CreateIndex
CREATE INDEX "Evidence_businessId_sourceType_sourceRecordId_idx" ON "Evidence"("businessId", "sourceType", "sourceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_businessId_claimId_sourceType_sourceRecordId_evide_key" ON "Evidence"("businessId", "claimId", "sourceType", "sourceRecordId", "evidenceType");

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
