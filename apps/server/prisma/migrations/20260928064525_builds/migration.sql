-- CreateEnum
CREATE TYPE "BuildState" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'refused');

-- CreateEnum
CREATE TYPE "BuildTrigger" AS ENUM ('webhook', 'reconcile', 'manual', 'mcp', 'rebuild');

-- CreateEnum
CREATE TYPE "BuildStage" AS ENUM ('fetch', 'test', 'integration', 'build', 'push');

-- CreateEnum
CREATE TYPE "BuildStageState" AS ENUM ('running', 'succeeded', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "build" (
    "id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "sha" CHAR(40) NOT NULL,
    "state" "BuildState" NOT NULL DEFAULT 'queued',
    "trigger" "BuildTrigger" NOT NULL,
    "queue_seq" BIGSERIAL NOT NULL,
    "requester_user_id" UUID,
    "requester_token_id" UUID,
    "requester_label" TEXT NOT NULL,
    "rebuild_of_id" UUID,
    "digests" JSONB,
    "refusal" JSONB,
    "failed_stage" "BuildStage",
    "cancel_requested_at" TIMESTAMPTZ(3),
    "auto_deploy_id" UUID,
    "auto_deploy_refusal" JSONB,
    "dispatched_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "build_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "build_stage" (
    "id" UUID NOT NULL,
    "build_id" UUID NOT NULL,
    "stage" "BuildStage" NOT NULL,
    "state" "BuildStageState" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "build_stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "build_log" (
    "id" BIGSERIAL NOT NULL,
    "build_id" UUID NOT NULL,
    "stage" "BuildStage" NOT NULL,
    "chunk" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "build_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "build_queue_seq_key" ON "build"("queue_seq");

-- CreateIndex
CREATE UNIQUE INDEX "build_auto_deploy_id_key" ON "build"("auto_deploy_id");

-- CreateIndex
CREATE INDEX "build_app_id_created_at_idx" ON "build"("app_id", "created_at");

-- CreateIndex
CREATE INDEX "build_state_queue_seq_idx" ON "build"("state", "queue_seq");

-- CreateIndex
CREATE INDEX "build_ended_at_idx" ON "build"("ended_at");

-- CreateIndex
CREATE UNIQUE INDEX "build_stage_build_id_stage_key" ON "build_stage"("build_id", "stage");

-- CreateIndex
CREATE INDEX "build_log_build_id_id_idx" ON "build_log"("build_id", "id");

-- AddForeignKey
ALTER TABLE "build" ADD CONSTRAINT "build_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build" ADD CONSTRAINT "build_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build" ADD CONSTRAINT "build_requester_token_id_fkey" FOREIGN KEY ("requester_token_id") REFERENCES "api_token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build" ADD CONSTRAINT "build_rebuild_of_id_fkey" FOREIGN KEY ("rebuild_of_id") REFERENCES "build"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build" ADD CONSTRAINT "build_auto_deploy_id_fkey" FOREIGN KEY ("auto_deploy_id") REFERENCES "deploy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build_stage" ADD CONSTRAINT "build_stage_build_id_fkey" FOREIGN KEY ("build_id") REFERENCES "build"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build_log" ADD CONSTRAINT "build_log_build_id_fkey" FOREIGN KEY ("build_id") REFERENCES "build"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one open build per (app, sha), enforced by the database: a webhook delivery and the
-- reconcile loop racing on one push enqueue it once (SHP-REQ-112, SHP-REQ-114). The state list is
-- the "open" half of the BuildState enum in schema.prisma; keep the two in sync by hand. Prisma
-- cannot express a partial index, so it is hand-written here (as deploy_target_one_active_per_app is).
CREATE UNIQUE INDEX "build_one_open_per_app_sha" ON "build" ("app_id", "sha")
  WHERE "state" IN ('queued','running');
