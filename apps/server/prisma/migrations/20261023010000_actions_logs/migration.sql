-- SHP-T-15.4 (SHP-ADR-010, SHP-ADR-011): adopted stacks mirrored from agent reports, lifecycle actions,
-- and the API token's opt-in to reading container logs. Log content itself is never stored (SHP-REQ-191).
-- CreateEnum
CREATE TYPE "ActionTargetKind" AS ENUM ('app', 'stack');

-- CreateEnum
CREATE TYPE "LifecycleVerb" AS ENUM ('start', 'stop', 'restart', 'recreate');

-- CreateEnum
CREATE TYPE "ActionState" AS ENUM ('queued', 'dispatched', 'running', 'succeeded', 'failed', 'refused', 'cancelled');

-- AlterTable
ALTER TABLE "api_token" ADD COLUMN     "can_read_logs" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "stack" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "agent_id" UUID NOT NULL,
    "manifest_json" TEXT NOT NULL,
    "manifest_sha256" TEXT NOT NULL,
    "compose_project" TEXT NOT NULL,
    "reported_at" TIMESTAMPTZ(3) NOT NULL,
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action" (
    "id" UUID NOT NULL,
    "target_kind" "ActionTargetKind" NOT NULL,
    "target_name" TEXT NOT NULL,
    "agent_id" UUID NOT NULL,
    "service" TEXT,
    "verb" "LifecycleVerb" NOT NULL,
    "state" "ActionState" NOT NULL DEFAULT 'queued',
    "requester_user_id" UUID,
    "requester_token_id" UUID,
    "requester_label" TEXT NOT NULL,
    "output" TEXT,
    "refusal" JSONB,
    "dispatched_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "action_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stack_name_key" ON "stack"("name");

-- CreateIndex
CREATE INDEX "action_agent_id_state_created_at_idx" ON "action"("agent_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "action_created_at_id_idx" ON "action"("created_at", "id");

-- AddForeignKey
ALTER TABLE "stack" ADD CONSTRAINT "stack_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action" ADD CONSTRAINT "action_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action" ADD CONSTRAINT "action_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action" ADD CONSTRAINT "action_requester_token_id_fkey" FOREIGN KEY ("requester_token_id") REFERENCES "api_token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

