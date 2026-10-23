-- SHP-T-16.3 (SHP-ADR-010; SHP-REQ-195, SHP-REQ-199, SHP-REQ-200): stack updates by digest — the request,
-- its approval, dispatch and outcome, kept forever — and the tracked services the agent reports on each stack.

-- CreateEnum
CREATE TYPE "StackUpdateKind" AS ENUM ('update', 'rollback');

-- CreateEnum
CREATE TYPE "StackUpdateState" AS ENUM ('queued', 'awaiting_approval', 'dispatched', 'running', 'succeeded', 'failed', 'rolled_back', 'refused', 'denied', 'cancelled');

-- AlterTable
ALTER TABLE "stack" ADD COLUMN     "services" JSONB;

-- CreateTable
CREATE TABLE "stack_update" (
    "id" UUID NOT NULL,
    "stack_id" UUID NOT NULL,
    "stack_name" TEXT NOT NULL,
    "agent_id" UUID NOT NULL,
    "kind" "StackUpdateKind" NOT NULL DEFAULT 'update',
    "state" "StackUpdateState" NOT NULL DEFAULT 'queued',
    "step" TEXT,
    "digests" JSONB,
    "to_update_id" UUID,
    "images" JSONB,
    "previous" JSONB,
    "soak_seconds" INTEGER NOT NULL DEFAULT 0,
    "requester_user_id" UUID,
    "requester_token_id" UUID,
    "requester_label" TEXT NOT NULL,
    "requester_repo" TEXT,
    "requester_branch" TEXT,
    "held_at" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_user_id" UUID,
    "decided_by_label" TEXT,
    "refusal" JSONB,
    "backup_artifact" JSONB,
    "dispatched_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stack_update_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stack_update_agent_id_state_created_at_idx" ON "stack_update"("agent_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "stack_update_stack_id_created_at_id_idx" ON "stack_update"("stack_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "stack_update_created_at_id_idx" ON "stack_update"("created_at", "id");

-- CreateIndex
CREATE INDEX "stack_update_state_idx" ON "stack_update"("state");

-- AddForeignKey
ALTER TABLE "stack_update" ADD CONSTRAINT "stack_update_stack_id_fkey" FOREIGN KEY ("stack_id") REFERENCES "stack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stack_update" ADD CONSTRAINT "stack_update_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stack_update" ADD CONSTRAINT "stack_update_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stack_update" ADD CONSTRAINT "stack_update_requester_token_id_fkey" FOREIGN KEY ("requester_token_id") REFERENCES "api_token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stack_update" ADD CONSTRAINT "stack_update_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written: Prisma cannot express a partial index. At most one active update or rollback per
-- stack, enforced by the database, so two requests that race cannot both be queued. The state list
-- mirrors ACTIVE_STACK_UPDATE_STATES in src/stack-updates/service.ts; keep the two in sync by hand.
CREATE UNIQUE INDEX "stack_update_one_active_per_stack" ON "stack_update" ("stack_id")
  WHERE "state" IN ('queued','dispatched','running');
