-- SHP-T-3.14: an app whose manifest left the host is retired, not deleted; its history stays.
ALTER TABLE "app" ADD COLUMN "retired_at" TIMESTAMPTZ(3);
