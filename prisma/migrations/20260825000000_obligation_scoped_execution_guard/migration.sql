-- AlterTable
ALTER TABLE "ExecutionIntent" ADD COLUMN     "obligationKey" TEXT;

-- CreateIndex
CREATE INDEX "ExecutionIntent_businessId_obligationKey_status_idx" ON "ExecutionIntent"("businessId", "obligationKey", "status");

