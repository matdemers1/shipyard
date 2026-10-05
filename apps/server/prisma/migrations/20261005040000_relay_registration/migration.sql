-- Push registrations for D3 Constellation (SHP-T-11.4). A device's relay and public key, owned by the
-- native session or D3 Auth identity that registered it, and gone with either.
CREATE TABLE "relay_registration" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID,
    "identity_id" UUID,
    "device_public_key" BYTEA NOT NULL,
    "relay_url" TEXT NOT NULL,
    "registration" TEXT NOT NULL,
    "send_key_sealed" TEXT NOT NULL,
    "categories" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "relay_registration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "relay_registration_session_id_key" ON "relay_registration"("session_id");
CREATE INDEX "relay_registration_user_id_idx" ON "relay_registration"("user_id");
CREATE UNIQUE INDEX "relay_registration_relay_url_registration_key" ON "relay_registration"("relay_url", "registration");

ALTER TABLE "relay_registration" ADD CONSTRAINT "relay_registration_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "relay_registration" ADD CONSTRAINT "relay_registration_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "relay_registration" ADD CONSTRAINT "relay_registration_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
