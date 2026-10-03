-- AlterTable
ALTER TABLE "Experiment" ADD COLUMN     "posthogExperimentId" INTEGER,
ADD COLUMN     "posthogExposureEvent" TEXT,
ADD COLUMN     "posthogFeatureFlagId" INTEGER,
ADD COLUMN     "posthogFeatureFlagKey" TEXT,
ADD COLUMN     "posthogSyncError" TEXT,
ADD COLUMN     "posthogSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PostHogOutbox" (
    "id" BIGSERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "distinctId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "properties" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "PostHogOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostHogOutbox_uuid_key" ON "PostHogOutbox"("uuid");

-- CreateIndex
CREATE INDEX "PostHogOutbox_sentAt_nextAttemptAt_id_idx" ON "PostHogOutbox"("sentAt", "nextAttemptAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Experiment_posthogFeatureFlagKey_key" ON "Experiment"("posthogFeatureFlagKey");
