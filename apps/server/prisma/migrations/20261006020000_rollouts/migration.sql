-- SHP-T-12.1: "Roll all" — several single-app deploys shipped one at a time, Shipyard's own last.
CREATE TABLE "rollout" (
    "id" UUID NOT NULL,
    "requester_label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rollout_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "deploy" ADD COLUMN "rollout_id" UUID,
ADD COLUMN "rollout_position" INTEGER;

CREATE INDEX "deploy_rollout_id_idx" ON "deploy"("rollout_id");

ALTER TABLE "deploy" ADD CONSTRAINT "deploy_rollout_id_fkey" FOREIGN KEY ("rollout_id") REFERENCES "rollout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
