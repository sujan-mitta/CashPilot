-- CreateEnum
CREATE TYPE "ExecutionOperation" AS ENUM ('CREATE_PAYMENT_LINK', 'RESCHEDULE_PAYOUT', 'PAUSE_EXPENSE');

-- CreateEnum
CREATE TYPE "ExecutionIntentStatus" AS ENUM ('RECORDED', 'DISPATCHING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OutcomePhase" AS ENUM ('NOT_STARTED', 'WINDOW_OPEN', 'WINDOW_COMPLETE', 'POST_HORIZON_PENDING', 'FINAL_MEASURED', 'UNRESOLVED_AFTER_WINDOW');

-- CreateEnum
CREATE TYPE "DecisionEventType" AS ENUM ('GENERATED', 'PRESENTED', 'APPROVED', 'REJECTED', 'STALE_BLOCKED', 'EXECUTION_STARTED', 'EXECUTION_UNKNOWN', 'EXECUTED', 'NOT_EXECUTED', 'RECONCILED', 'NOT_RECONCILED', 'RECONCILIATION_MISMATCH', 'OUTCOME_MEASURED', 'POST_HORIZON_PENDING', 'FINAL_OUTCOME_MEASURED');

-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "contextFingerprint" TEXT,
ADD COLUMN     "finalOutcomeMeasuredAt" TIMESTAMP(3),
ADD COLUMN     "fingerprintDetail" JSONB,
ADD COLUMN     "liquidityConfigVersion" TEXT NOT NULL DEFAULT '14.0.0',
ADD COLUMN     "obligationSnapshot" JSONB,
ADD COLUMN     "outcomeMeasurementHorizonDays" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "outcomePhase" "OutcomePhase" NOT NULL DEFAULT 'NOT_STARTED',
ADD COLUMN     "outcomeRulesVersion" TEXT NOT NULL DEFAULT '14.0.0',
ADD COLUMN     "scoringConfigVersion" TEXT NOT NULL DEFAULT '14.0.0';

-- CreateTable
CREATE TABLE "ExecutionIntent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "operation" "ExecutionOperation" NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "amount" INTEGER NOT NULL,
    "status" "ExecutionIntentStatus" NOT NULL DEFAULT 'RECORDED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "externalRef" TEXT,
    "externalStatus" TEXT,
    "lastError" TEXT,
    "unknownReason" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionEvent" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "eventType" "DecisionEventType" NOT NULL,
    "fromStatus" "DecisionStatus",
    "toStatus" "DecisionStatus",
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionIntent_idempotencyKey_key" ON "ExecutionIntent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ExecutionIntent_businessId_idx" ON "ExecutionIntent"("businessId");

-- CreateIndex
CREATE INDEX "ExecutionIntent_actionId_idx" ON "ExecutionIntent"("actionId");

-- CreateIndex
CREATE INDEX "ExecutionIntent_strategyId_idx" ON "ExecutionIntent"("strategyId");

-- CreateIndex
CREATE INDEX "ExecutionIntent_status_idx" ON "ExecutionIntent"("status");

-- CreateIndex
CREATE INDEX "ExecutionIntent_status_dispatchedAt_idx" ON "ExecutionIntent"("status", "dispatchedAt");

-- CreateIndex
CREATE INDEX "DecisionEvent_decisionId_createdAt_idx" ON "DecisionEvent"("decisionId", "createdAt");

-- CreateIndex
CREATE INDEX "DecisionEvent_businessId_createdAt_idx" ON "DecisionEvent"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "DecisionEvent_eventType_idx" ON "DecisionEvent"("eventType");

-- CreateIndex
CREATE INDEX "Decision_businessId_createdAt_idx" ON "Decision"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Decision_outcomePhase_idx" ON "Decision"("outcomePhase");

-- AddForeignKey
ALTER TABLE "ExecutionIntent" ADD CONSTRAINT "ExecutionIntent_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "AgentAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionEvent" ADD CONSTRAINT "DecisionEvent_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

