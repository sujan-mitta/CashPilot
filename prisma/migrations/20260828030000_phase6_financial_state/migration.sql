-- Phase 6: the materialised Unified Financial State.
--
-- Purely additive: one new table. No existing table is touched, so every
-- existing row reads back identically. The table has no consumers yet -
-- buildForecast still reads the canonical rows directly.
--
-- Append-only by design: a changed reality inserts a new row with the next
-- stateVersion. There is no updatedAt because a state is never modified.

-- CreateTable
CREATE TABLE "FinancialState" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "stateHash" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "cashPosition" INTEGER NOT NULL,
    "receivables" INTEGER NOT NULL,
    "payables" INTEGER NOT NULL,
    "expectedInflows" INTEGER NOT NULL,
    "expectedOutflows" INTEGER NOT NULL,
    "activeCommitments" INTEGER NOT NULL,
    "requiredBuffer" INTEGER NOT NULL,
    "projectedMinimumBalance" INTEGER,
    "riskState" TEXT NOT NULL,
    "reconciliation" JSONB,
    "detail" JSONB NOT NULL,
    "evidenceRefs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinancialState_businessId_idx" ON "FinancialState"("businessId");

-- CreateIndex
CREATE INDEX "FinancialState_businessId_createdAt_idx" ON "FinancialState"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "FinancialState_businessId_stateHash_idx" ON "FinancialState"("businessId", "stateHash");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialState_businessId_stateVersion_key" ON "FinancialState"("businessId", "stateVersion");
