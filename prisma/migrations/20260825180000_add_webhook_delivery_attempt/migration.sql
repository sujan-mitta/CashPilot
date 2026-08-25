-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'DUPLICATE');

-- CreateTable
CREATE TABLE "WebhookDeliveryAttempt" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "providerEventId" TEXT,
    "eventType" TEXT,
    "status" "WebhookDeliveryStatus" NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingStartedAt" TIMESTAMP(3),
    "processingCompletedAt" TIMESTAMP(3),
    "errorClass" TEXT,
    "errorMessage" TEXT,
    "correlationId" TEXT,
    "businessId" TEXT,
    "executionIntentId" TEXT,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookDeliveryAttempt_providerEventId_idx" ON "WebhookDeliveryAttempt"("providerEventId");

-- CreateIndex
CREATE INDEX "WebhookDeliveryAttempt_status_idx" ON "WebhookDeliveryAttempt"("status");

-- CreateIndex
CREATE INDEX "WebhookDeliveryAttempt_businessId_idx" ON "WebhookDeliveryAttempt"("businessId");

