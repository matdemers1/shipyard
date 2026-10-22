-- SHP-T-14.5: the latest host inventory per agent and a rolling window of container samples
-- (SHP-ADR-009). Written only by agent reports; read by GET /api/host and shipyard_host.
-- CreateTable
CREATE TABLE "host_snapshot" (
    "agent_id" UUID NOT NULL,
    "inventory" JSONB NOT NULL,
    "sampled_at" TIMESTAMPTZ(3) NOT NULL,
    "reported_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "host_snapshot_pkey" PRIMARY KEY ("agent_id")
);

-- CreateTable
CREATE TABLE "host_sample" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "container_name" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "cpu_percent" DOUBLE PRECISION NOT NULL,
    "memory_bytes" BIGINT NOT NULL,

    CONSTRAINT "host_sample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "host_sample_agent_id_container_name_at_idx" ON "host_sample"("agent_id", "container_name", "at");

-- AddForeignKey
ALTER TABLE "host_snapshot" ADD CONSTRAINT "host_snapshot_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_sample" ADD CONSTRAINT "host_sample_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

