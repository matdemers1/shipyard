import { Router } from 'express';
import { HostResponse, HostSnapshot, refusal, type HostInventory, type HostSample } from '@shipyard/schema';
import type { Logger } from 'pino';
import type { Db, Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';

/**
 * The host inventory, server side (SHP-ADR-009, SHP-T-14.5): the latest `HostInventory` each agent
 * reported, kept in `host_snapshot`, and a rolling window of per-container CPU and memory samples
 * in `host_sample`, for the Host destination's sparklines.
 *
 * Written only by the agent's report (`apps/report.ts` calls `storeHostInventory`). Read by
 * GET /api/host here and by the `shipyard_host` MCP tool through `readHostSnapshots`; neither
 * changes any state on the server or the host (SHP-REQ-181). Drift is never computed from this:
 * an Observed container changing state is shown, not recorded as drift (SHP-REQ-182).
 */

/** How long a container's samples are kept: older ones are deleted on the agent's next report. */
export const HOST_SAMPLE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The most samples one container returns (`HostSnapshot.samples` allows no more). */
export const HOST_SAMPLES_PER_CONTAINER = 500;

/**
 * Replaces `agentId`'s stored inventory with `inventory`, appends one sample per container that
 * reported stats, and prunes that agent's samples older than the window — in one transaction, so
 * a reader never sees a snapshot without its samples.
 *
 * A sample is stamped with the server's receipt time, not the agent's `sampledAt`: the window is
 * pruned on the server's clock, and a skewed agent clock must not order points out of sequence or
 * keep them past the window.
 */
export async function storeHostInventory(db: Db, agentId: string, inventory: HostInventory, now: Date = new Date()): Promise<void> {
  const samples = inventory.containers.flatMap((c) =>
    c.stats === null
      ? []
      : [{ agentId, containerName: c.name, at: now, cpuPercent: c.stats.cpuPercent, memoryBytes: BigInt(c.stats.memoryBytes) }],
  );
  const fields = {
    inventory: inventory as unknown as Prisma.InputJsonValue,
    sampledAt: new Date(inventory.sampledAt),
    reportedAt: now,
  };
  await db.$transaction(async (tx) => {
    await tx.hostSnapshot.upsert({ where: { agentId }, create: { agentId, ...fields }, update: fields });
    if (samples.length > 0) await tx.hostSample.createMany({ data: samples });
    await tx.hostSample.deleteMany({ where: { agentId, at: { lt: new Date(now.getTime() - HOST_SAMPLE_WINDOW_MS) } } });
  });
}

interface SampleRow {
  agent_id: string;
  container_name: string;
  at: Date;
  cpu_percent: number;
  memory_bytes: bigint;
}

/**
 * Every agent's latest host snapshot with its recent samples (`GET /api/host`, `shipyard_host`):
 * per container, the newest `HOST_SAMPLES_PER_CONTAINER` within the window, oldest first. Reads
 * only. A stored inventory that no longer matches the schema (written by an older server) is left
 * out with a warning rather than failing every host.
 */
export async function readHostSnapshots(db: Db, logger?: Logger, now: Date = new Date()): Promise<HostResponse> {
  const rows = await db.hostSnapshot.findMany({
    orderBy: { reportedAt: 'asc' },
    select: { agentId: true, inventory: true, reportedAt: true, agent: { select: { fingerprint: true } } },
  });
  if (rows.length === 0) return { hosts: [] };

  const since = new Date(now.getTime() - HOST_SAMPLE_WINDOW_MS);
  const sampleRows = await db.$queryRaw<SampleRow[]>`
    select agent_id::text as agent_id, container_name, at, cpu_percent, memory_bytes
    from (
      select agent_id, container_name, at, cpu_percent, memory_bytes,
             row_number() over (partition by agent_id, container_name order by at desc, id desc) as rn
      from host_sample
      where at >= ${since}
    ) recent
    where rn <= ${HOST_SAMPLES_PER_CONTAINER}
    order by agent_id, container_name, at asc, rn desc`;

  const byAgent = new Map<string, Record<string, HostSample[]>>();
  for (const s of sampleRows) {
    let samples = byAgent.get(s.agent_id);
    if (samples === undefined) {
      samples = {};
      byAgent.set(s.agent_id, samples);
    }
    (samples[s.container_name] ??= []).push({
      at: s.at.toISOString(),
      cpuPercent: s.cpu_percent,
      memoryBytes: Number(s.memory_bytes),
    });
  }

  const hosts: HostSnapshot[] = [];
  for (const row of rows) {
    const parsed = HostSnapshot.safeParse({
      agent: { id: row.agentId, fingerprint: row.agent.fingerprint },
      reportedAt: row.reportedAt.toISOString(),
      inventory: row.inventory,
      samples: byAgent.get(row.agentId) ?? {},
    });
    if (parsed.success) hosts.push(parsed.data);
    else logger?.warn({ agentId: row.agentId, issues: parsed.error.issues.length }, 'stored host snapshot no longer validates; left out');
  }
  return HostResponse.parse({ hosts });
}

/**
 * Mounted at /api/host (SHP-REQ-179, SHP-REQ-181). GET only: any signed-in user, whatever the role,
 * and any API token, whatever its app scope — the host is not an app, and what it shows is what
 * Docker shows anyone on the box. An agent's signed request is not a reader. Any other method falls
 * through to the app's 404: there is no write path here.
 */
export function hostRouter(deps: ServiceDeps): Router {
  const { db, logger } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const type = req.actor?.type;
    if (type !== 'user' && type !== 'token') {
      sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    res.json(await readHostSnapshots(db, logger));
  });

  return router;
}
