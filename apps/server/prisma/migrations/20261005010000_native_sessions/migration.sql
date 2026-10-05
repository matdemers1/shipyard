-- Native sessions for D3 Constellation (SHP-P-10, the D3 App contract). A native session is an
-- ordinary session row, marked and named by its device, reached with a Bearer access token; its
-- refresh tokens rotate through native_refresh. step_up_at is when it last re-proved who it is.
ALTER TABLE "session" ADD COLUMN "native" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "device_name" TEXT,
ADD COLUMN "device_platform" TEXT,
ADD COLUMN "step_up_at" TIMESTAMPTZ(3),
ADD COLUMN "d3auth_issuer" TEXT;

CREATE TABLE "native_refresh" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "replaced_at" TIMESTAMPTZ(3),
    CONSTRAINT "native_refresh_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "native_refresh_token_hash_key" ON "native_refresh"("token_hash");
CREATE INDEX "native_refresh_session_id_idx" ON "native_refresh"("session_id");

ALTER TABLE "native_refresh" ADD CONSTRAINT "native_refresh_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
