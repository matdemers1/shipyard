-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'operator');

-- CreateEnum
CREATE TYPE "SessionMethod" AS ENUM ('password', 'oidc');

-- CreateEnum
CREATE TYPE "DeployKind" AS ENUM ('deploy', 'rollback', 'restore');

-- CreateEnum
CREATE TYPE "DeployTargetState" AS ENUM ('queued', 'awaiting_approval', 'locked', 'verifying', 'backing_up', 'migrating', 'pulling', 'swapping', 'checking', 'soaking', 'rolling_back', 'succeeded', 'failed', 'rolled_back', 'refused', 'cancelled');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('user', 'token', 'agent', 'system');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT,
    "totp_secret" TEXT,
    "totp_enabled_at" TIMESTAMPTZ(3),
    "role" "UserRole" NOT NULL DEFAULT 'operator',
    "disabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email_at_link" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3),
    "ip" TEXT,
    "user_agent" TEXT,
    "method" "SessionMethod" NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_token" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "last_used_ip" TEXT,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "api_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_token_app" (
    "token_id" UUID NOT NULL,
    "app_id" UUID NOT NULL,

    CONSTRAINT "api_token_app_pkey" PRIMARY KEY ("token_id","app_id")
);

-- CreateTable
CREATE TABLE "agent" (
    "id" UUID NOT NULL,
    "public_key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "enrolled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmed_by_user_id" UUID,
    "last_heartbeat_at" TIMESTAMPTZ(3),
    "agent_version" TEXT,
    "compose_version" TEXT,
    "engine_api_version" TEXT,

    CONSTRAINT "agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "agent_id" UUID NOT NULL,
    "manifest_yaml" TEXT NOT NULL,
    "manifest_sha256" TEXT NOT NULL,
    "repo" TEXT,
    "default_branch" TEXT,
    "services" JSONB,
    "soak_seconds" INTEGER,
    "approval_policy" TEXT,
    "foreman_project" TEXT,
    "group_name" TEXT,
    "canary" BOOLEAN NOT NULL DEFAULT false,
    "reported_at" TIMESTAMPTZ(3),

    CONSTRAINT "app_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deploy" (
    "id" UUID NOT NULL,
    "kind" "DeployKind" NOT NULL DEFAULT 'deploy',
    "requested_sha" CHAR(40) NOT NULL,
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "requester_user_id" UUID,
    "requester_token_id" UUID,
    "requester_label" TEXT NOT NULL,
    "requester_repo" TEXT,
    "requester_branch" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expired_at" TIMESTAMPTZ(3),

    CONSTRAINT "deploy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deploy_target" (
    "id" UUID NOT NULL,
    "deploy_id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "state" "DeployTargetState" NOT NULL DEFAULT 'queued',
    "live_sha_before" CHAR(40),
    "result" JSONB,
    "refusal" JSONB,
    "schema_revision" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deploy_target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "target_image" (
    "id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "service" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "sha" CHAR(40) NOT NULL,
    "digest" TEXT NOT NULL,
    "previous_digest" TEXT,
    "migration_label" TEXT,

    CONSTRAINT "target_image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step" (
    "id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "argv" TEXT[],
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "exit_code" INTEGER,
    "output" TEXT,

    CONSTRAINT "step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" UUID,
    "actor_token_id" UUID,
    "actor_agent_id" UUID,
    "actor_label" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "request_id" TEXT,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "identity_issuer_subject_key" ON "identity"("issuer", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "api_token_token_hash_key" ON "api_token"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "agent_fingerprint_key" ON "agent"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "app_name_key" ON "app"("name");

-- CreateIndex
CREATE INDEX "step_target_id_started_at_idx" ON "step"("target_id", "started_at");

-- CreateIndex
CREATE INDEX "audit_event_entity_type_entity_id_idx" ON "audit_event"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_event_at_idx" ON "audit_event"("at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_idempotency_key_key" ON "outbox"("idempotency_key");

-- AddForeignKey
ALTER TABLE "identity" ADD CONSTRAINT "identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token_app" ADD CONSTRAINT "api_token_app_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "api_token"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token_app" ADD CONSTRAINT "api_token_app_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent" ADD CONSTRAINT "agent_confirmed_by_user_id_fkey" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app" ADD CONSTRAINT "app_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy" ADD CONSTRAINT "deploy_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy" ADD CONSTRAINT "deploy_requester_token_id_fkey" FOREIGN KEY ("requester_token_id") REFERENCES "api_token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy_target" ADD CONSTRAINT "deploy_target_deploy_id_fkey" FOREIGN KEY ("deploy_id") REFERENCES "deploy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy_target" ADD CONSTRAINT "deploy_target_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "target_image" ADD CONSTRAINT "target_image_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "deploy_target"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step" ADD CONSTRAINT "step_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "deploy_target"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_token_id_fkey" FOREIGN KEY ("actor_token_id") REFERENCES "api_token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_agent_id_fkey" FOREIGN KEY ("actor_agent_id") REFERENCES "agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "deploy_target"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written: Prisma cannot express a partial index. This is the point of SHP-T-0.3 — at most
-- one active deploy_target per app, enforced by the database. The state list mirrors the "active"
-- half of the DeployTargetState enum in schema.prisma; keep the two in sync by hand.
CREATE UNIQUE INDEX "deploy_target_one_active_per_app" ON "deploy_target" ("app_id")
  WHERE "state" IN ('locked','verifying','backing_up','migrating','pulling','swapping','checking','soaking','rolling_back');
