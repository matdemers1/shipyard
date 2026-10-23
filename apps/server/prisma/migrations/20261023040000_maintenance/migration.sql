-- Shipyard-Migration: expand
-- SHP-T-17.3 (SHP-ADR-012; SHP-REQ-201, SHP-REQ-202, SHP-REQ-203, SHP-REQ-204, SHP-REQ-205): volume
-- backups, restores and deletes and prunes as maintenance jobs handed to the agent, and the volume
-- archives in each agent's own ledger, mirrored from its reports. Additive only: two new tables, one
-- new enum, nothing existing altered.

-- CreateEnum
CREATE TYPE "MaintenanceState" AS ENUM ('queued', 'dispatched', 'running', 'succeeded', 'failed', 'refused', 'cancelled');

-- CreateTable
CREATE TABLE "maintenance_job" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "state" "MaintenanceState" NOT NULL DEFAULT 'queued',
    "step" TEXT,
    "volume" TEXT,
    "owner_kind" TEXT,
    "owner_name" TEXT,
    "job" JSONB NOT NULL,
    "dry_run_of" UUID,
    "requester_kind" TEXT NOT NULL,
    "requester_user_id" UUID,
    "requester_token_id" UUID,
    "requester_label" TEXT NOT NULL,
    "requester_repo" TEXT,
    "requester_branch" TEXT,
    "result" JSONB,
    "refusal" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "maintenance_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volume_archive" (
    "archive_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "volume" TEXT NOT NULL,
    "owner_kind" TEXT,
    "owner_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "quiesced" BOOLEAN NOT NULL,
    "seen_at" TIMESTAMPTZ(3) NOT NULL,
    "retired_at" TIMESTAMPTZ(3),

    CONSTRAINT "volume_archive_pkey" PRIMARY KEY ("archive_id")
);

-- CreateIndex
CREATE INDEX "maintenance_job_agent_id_state_created_at_idx" ON "maintenance_job"("agent_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "maintenance_job_created_at_id_idx" ON "maintenance_job"("created_at", "id");

-- CreateIndex
CREATE INDEX "maintenance_job_volume_kind_created_at_idx" ON "maintenance_job"("volume", "kind", "created_at");

-- CreateIndex
CREATE INDEX "maintenance_job_state_idx" ON "maintenance_job"("state");

-- CreateIndex
CREATE INDEX "volume_archive_volume_created_at_idx" ON "volume_archive"("volume", "created_at");

-- CreateIndex
CREATE INDEX "volume_archive_agent_id_retired_at_idx" ON "volume_archive"("agent_id", "retired_at");

-- AddForeignKey
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_dry_run_of_fkey" FOREIGN KEY ("dry_run_of") REFERENCES "maintenance_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_job" ADD CONSTRAINT "maintenance_job_requester_token_id_fkey" FOREIGN KEY ("requester_token_id") REFERENCES "api_token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volume_archive" ADD CONSTRAINT "volume_archive_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written: Prisma cannot express a partial index. The agent runs one maintenance job at a time,
-- so at most one per agent is dispatched or running, enforced by the database: two polls racing to
-- claim cannot both hand one out. Any number may be queued (the nightly backups queue one per
-- volume and run in order). The state list mirrors IN_FLIGHT_MAINTENANCE_STATES in
-- src/maintenance/service.ts; keep the two in sync by hand.
CREATE UNIQUE INDEX "maintenance_job_one_in_flight_per_agent" ON "maintenance_job" ("agent_id")
  WHERE "state" IN ('dispatched','running');
