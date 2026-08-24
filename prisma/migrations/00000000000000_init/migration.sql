-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."ActionStatus" AS ENUM ('PENDING', 'APPROVED', 'EXECUTING', 'COMPLETED', 'FAILED', 'REJECTED', 'STALE', 'EXECUTION_REQUESTED', 'EXECUTION_UNKNOWN', 'EXECUTED', 'RECONCILING', 'RECONCILIATION_FAILED', 'RECONCILIATION_MISMATCH');

-- CreateEnum
CREATE TYPE "public"."ActionType" AS ENUM ('RECOVER_FAILED_PAYMENTS', 'PRIORITIZE_COLLECTIONS', 'RESCHEDULE_PAYOUT', 'PAUSE_EXPENSE');

-- CreateEnum
CREATE TYPE "public"."DecisionStatus" AS ENUM ('GENERATED', 'PRESENTED', 'APPROVED', 'REJECTED', 'EXECUTED', 'NOT_EXECUTED', 'RECONCILED', 'NOT_RECONCILED', 'RECONCILIATION_MISMATCH', 'OUTCOME_MEASURED');

-- CreateEnum
CREATE TYPE "public"."InvoiceStatus" AS ENUM ('PAID', 'OVERDUE', 'PENDING');

-- CreateEnum
CREATE TYPE "public"."PayoutCriticality" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "public"."PayoutStatus" AS ENUM ('SCHEDULED', 'PAID', 'RESCHEDULED', 'PAUSED');

-- CreateEnum
CREATE TYPE "public"."Priority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "public"."RecoveryStatus" AS ENUM ('RECOVERY_CANDIDATE', 'RECOVERY_INITIATED', 'PAYMENT_LINK_CREATED', 'PAYMENT_PENDING', 'RECOVERED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "public"."TransactionStatus" AS ENUM ('SUCCESS', 'FAILED', 'PENDING');

-- CreateEnum
CREATE TYPE "public"."TransactionType" AS ENUM ('INFLOW', 'OUTFLOW');

-- CreateTable
CREATE TABLE "public"."AgentAction" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "actionType" "public"."ActionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "public"."ActionStatus" NOT NULL DEFAULT 'PENDING',
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetPayoutId" TEXT,
    "targetTransactionId" TEXT,
    "auditLog" JSONB,
    "predictionActual" JSONB,

    CONSTRAINT "AgentAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currentCash" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CashForecast" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "openingBalance" INTEGER NOT NULL,
    "expectedInflows" INTEGER NOT NULL,
    "expectedOutflows" INTEGER NOT NULL,
    "projectedBalance" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashForecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Decision" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "public"."DecisionStatus" NOT NULL DEFAULT 'GENERATED',
    "engineVersion" TEXT NOT NULL DEFAULT '13.0.0',
    "baselineSnapshot" JSONB NOT NULL,
    "recommendedSnapshot" JSONB NOT NULL,
    "approvalSnapshot" JSONB,
    "executionSnapshot" JSONB,
    "reconciliationSnapshot" JSONB,
    "actualOutcome" JSONB,
    "outcomeMeasuredAt" TIMESTAMP(3),

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Invoice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "public"."InvoiceStatus" NOT NULL,
    "priority" "public"."Priority" NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PaymentRecovery" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "status" "public"."RecoveryStatus" NOT NULL DEFAULT 'RECOVERY_CANDIDATE',
    "paymentLinkId" TEXT,
    "shortUrl" TEXT,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Payout" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "criticality" "public"."PayoutCriticality" NOT NULL,
    "status" "public"."PayoutStatus" NOT NULL DEFAULT 'SCHEDULED',

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProcessedEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Strategy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "actions" JSONB NOT NULL,
    "projectedBalance" INTEGER NOT NULL,
    "riskLevel" "public"."RiskLevel" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualOutcome" JSONB,
    "startingCash" INTEGER NOT NULL DEFAULT 0,
    "scoring" JSONB,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Transaction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" "public"."TransactionType" NOT NULL,
    "status" "public"."TransactionStatus" NOT NULL,
    "description" TEXT,
    "expectedDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password" TEXT NOT NULL DEFAULT 'mock-password-hash',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."_BusinessToUser" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BusinessToUser_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "AgentAction_strategyId_idx" ON "public"."AgentAction"("strategyId" ASC);

-- CreateIndex
CREATE INDEX "AgentAction_targetPayoutId_idx" ON "public"."AgentAction"("targetPayoutId" ASC);

-- CreateIndex
CREATE INDEX "AgentAction_targetTransactionId_idx" ON "public"."AgentAction"("targetTransactionId" ASC);

-- CreateIndex
CREATE INDEX "CashForecast_businessId_idx" ON "public"."CashForecast"("businessId" ASC);

-- CreateIndex
CREATE INDEX "Decision_businessId_idx" ON "public"."Decision"("businessId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Decision_strategyId_key" ON "public"."Decision"("strategyId" ASC);

-- CreateIndex
CREATE INDEX "Invoice_businessId_idx" ON "public"."Invoice"("businessId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecovery_transactionId_key" ON "public"."PaymentRecovery"("transactionId" ASC);

-- CreateIndex
CREATE INDEX "Payout_businessId_idx" ON "public"."Payout"("businessId" ASC);

-- CreateIndex
CREATE INDEX "Strategy_businessId_idx" ON "public"."Strategy"("businessId" ASC);

-- CreateIndex
CREATE INDEX "Transaction_businessId_idx" ON "public"."Transaction"("businessId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email" ASC);

-- CreateIndex
CREATE INDEX "_BusinessToUser_B_index" ON "public"."_BusinessToUser"("B" ASC);

-- AddForeignKey
ALTER TABLE "public"."AgentAction" ADD CONSTRAINT "AgentAction_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "public"."Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CashForecast" ADD CONSTRAINT "CashForecast_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "public"."Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Decision" ADD CONSTRAINT "Decision_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "public"."Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Decision" ADD CONSTRAINT "Decision_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "public"."Strategy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Invoice" ADD CONSTRAINT "Invoice_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "public"."Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PaymentRecovery" ADD CONSTRAINT "PaymentRecovery_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "public"."Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payout" ADD CONSTRAINT "Payout_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "public"."Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Strategy" ADD CONSTRAINT "Strategy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "public"."Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Transaction" ADD CONSTRAINT "Transaction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "public"."Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_BusinessToUser" ADD CONSTRAINT "_BusinessToUser_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_BusinessToUser" ADD CONSTRAINT "_BusinessToUser_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

