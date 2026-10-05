-- SHP-T-11.3: an account asked to be deleted waits out a grace period, then is purged.
ALTER TABLE "user" ADD COLUMN "delete_after" TIMESTAMPTZ(3);
ALTER TABLE "user" ADD COLUMN "deleted_at" TIMESTAMPTZ(3);
