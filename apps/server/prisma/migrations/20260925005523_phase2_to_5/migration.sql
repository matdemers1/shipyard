-- CreateEnum
CREATE TYPE "DriftResolution" AS ENUM ('adopt_live', 'redeploy_recorded');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserRole" ADD VALUE 'deployer';
ALTER TYPE "UserRole" ADD VALUE 'viewer';

-- AlterTable
ALTER TABLE "app" ADD COLUMN     "drifted_at" TIMESTAMPTZ(3),
ADD COLUMN     "foreman_environment" TEXT,
ADD COLUMN     "running_digests" JSONB;

-- AlterTable
ALTER TABLE "deploy" ADD COLUMN     "group_name" TEXT;

-- AlterTable
ALTER TABLE "deploy_target" ADD COLUMN     "current_step" TEXT,
ADD COLUMN     "dispatched_at" TIMESTAMPTZ(3),
ADD COLUMN     "rollback_to_deploy_id" UUID;

-- CreateTable
CREATE TABLE "agent_nonce" (
    "nonce" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_nonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "drift_event" (
    "id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "observed" JSONB NOT NULL,
    "recorded" JSONB NOT NULL,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution" "DriftResolution",
    "reason" TEXT,
    "resolved_by_user_id" UUID,

    CONSTRAINT "drift_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" UUID NOT NULL,
    "deploy_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "approved_at" TIMESTAMPTZ(3),
    "denied_at" TIMESTAMPTZ(3),
    "expired_at" TIMESTAMPTZ(3),
    "decided_by_user_id" UUID,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "freeze" (
    "id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "by_user_id" UUID NOT NULL,
    "from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "until" TIMESTAMPTZ(3),
    "cleared_at" TIMESTAMPTZ(3),

    CONSTRAINT "freeze_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule" (
    "id" UUID NOT NULL,
    "deploy_id" UUID NOT NULL,
    "fire_at" TIMESTAMPTZ(3) NOT NULL,
    "fired_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "by_user_id" UUID NOT NULL,

    CONSTRAINT "schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_artifact" (
    "id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "target_id" UUID,
    "path" TEXT NOT NULL,
    "size" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "backup_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_nonce_expires_at_idx" ON "agent_nonce"("expires_at");

-- CreateIndex
CREATE INDEX "drift_event_app_id_detected_at_idx" ON "drift_event"("app_id", "detected_at");

-- CreateIndex
CREATE UNIQUE INDEX "approval_deploy_id_key" ON "approval"("deploy_id");

-- CreateIndex
CREATE INDEX "freeze_app_id_cleared_at_idx" ON "freeze"("app_id", "cleared_at");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_deploy_id_key" ON "schedule"("deploy_id");

-- CreateIndex
CREATE INDEX "schedule_fire_at_idx" ON "schedule"("fire_at");

-- CreateIndex
CREATE INDEX "backup_artifact_app_id_created_at_idx" ON "backup_artifact"("app_id", "created_at");

-- AddForeignKey
ALTER TABLE "drift_event" ADD CONSTRAINT "drift_event_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drift_event" ADD CONSTRAINT "drift_event_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_deploy_id_fkey" FOREIGN KEY ("deploy_id") REFERENCES "deploy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freeze" ADD CONSTRAINT "freeze_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "freeze" ADD CONSTRAINT "freeze_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_deploy_id_fkey" FOREIGN KEY ("deploy_id") REFERENCES "deploy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_by_user_id_fkey" FOREIGN KEY ("by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_artifact" ADD CONSTRAINT "backup_artifact_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
