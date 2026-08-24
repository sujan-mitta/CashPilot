-- AlterTable
ALTER TABLE "ExecutionIntent" ADD COLUMN     "expectedState" JSONB,
ADD COLUMN     "lastReconciledAt" TIMESTAMP(3),
ADD COLUMN     "observedState" JSONB,
ADD COLUMN     "reconciliationResult" JSONB,
ADD COLUMN     "retrySafe" BOOLEAN NOT NULL DEFAULT false;

