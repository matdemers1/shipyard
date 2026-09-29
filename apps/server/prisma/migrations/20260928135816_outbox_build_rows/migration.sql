-- A build's outbox rows (GitHub commit status, Foreman build record, SHP-T-7.15) have no deploy
-- target. History is never deleted, so the foreign key still restricts.

-- AlterTable
ALTER TABLE "outbox" ALTER COLUMN "target_id" DROP NOT NULL;
