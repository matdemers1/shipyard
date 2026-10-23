import { createHash } from 'node:crypto';
import { HostInventory, type ContainerTier, type HostContainer, type HostImage, type HostVolume } from '../../packages/schema/src/index.js';
import type { Db } from './db.js';

/**
 * The host snapshot the baseline world carries (SHP-T-14.7, SHP-REQ-178): what an agent on
 * f574b79 or later would have reported — containers in Deployed, Operated and Observed compose
 * projects plus one compose did not create, one exited container, orphaned volumes, unused and
 * dangling images, the disk — and a few CPU samples per running container for the sparklines.
 *
 * Written the way `storeHostInventory` (apps/server/src/host/index.ts) leaves it: one
 * `host_snapshot` row for the agent and `host_sample` rows keyed by container name. The inventory
 * is parsed with the schema first, so a fixture the server would leave out fails here, loudly.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

function hex64(label: string): string {
  return createHash('sha256').update(`console-e2e host ${label}`).digest('hex');
}

/** The names the Host spec looks for. */
export const HOST_FIXTURE = {
  deployedProject: 'bindery',
  deployedApp: 'bindery',
  operatedProject: 'immich',
  observedProject: 'forgejo',
  exitedContainer: 'forgejo-ci-dind',
  strayContainer: 'portainer',
  orphanVolume: 'kardashev_pgdata',
  containers: 9,
  notRunning: 1,
  volumes: 8,
  orphaned: 3,
} as const;

interface Spec {
  name: string;
  image: string;
  project: string | null;
  service?: string;
  tier: ContainerTier;
  app?: string;
  state?: HostContainer['state'];
  health?: HostContainer['health'];
  restarts?: number;
  cpu?: number;
  memoryMb?: number;
  limitGb?: number;
}

function container(spec: Spec, now: number): HostContainer {
  const running = (spec.state ?? 'running') === 'running';
  return {
    id: hex64(`container ${spec.name}`),
    name: spec.name,
    image: spec.image,
    imageId: `sha256:${hex64(`image ${spec.image}`)}`,
    digest: spec.image.startsWith('ghcr.io/') ? `sha256:${hex64(`digest ${spec.image}`)}` : null,
    state: spec.state ?? 'running',
    health: spec.health ?? 'none',
    restartCount: spec.restarts ?? 0,
    createdAt: new Date(now - 3 * 24 * 3_600_000).toISOString(),
    startedAt: new Date(now - 3 * 24 * 3_600_000 + 2_000).toISOString(),
    compose: spec.project === null ? null : { project: spec.project, service: spec.service ?? spec.name },
    tier: spec.tier,
    app: spec.app ?? null,
    ports: [],
    mounts: [],
    stats: running
      ? {
          cpuPercent: spec.cpu ?? 0.5,
          memoryBytes: (spec.memoryMb ?? 64) * MB,
          memoryLimitBytes: spec.limitGb === undefined ? null : spec.limitGb * GB,
        }
      : null,
  };
}

function volume(name: string, sizeMb: number | null, mountedBy: string[], composeProject: string | null): HostVolume {
  return { name, driver: 'local', sizeBytes: sizeMb === null ? null : sizeMb * MB, mountedBy, composeProject, orphan: mountedBy.length === 0, createdAt: null };
}

function image(tag: string | null, sizeMb: number, containers: number): HostImage {
  return {
    id: `sha256:${hex64(`image ${tag ?? `dangling ${String(sizeMb)}`}`)}`,
    repoTags: tag === null ? [] : [tag],
    repoDigests: [],
    sizeBytes: sizeMb * MB,
    createdAt: '2026-10-01T00:00:00.000Z',
    containers,
    dangling: tag === null,
  };
}

export function hostInventory(now: number): HostInventory {
  const sha = 'a'.repeat(40);
  const containers: Spec[] = [
    { name: 'bindery-server-1', image: `ghcr.io/matdemers1/bindery/server:sha-${sha}`, project: 'bindery', service: 'server', tier: 'shipped', app: 'bindery', health: 'healthy', cpu: 2.4, memoryMb: 312 },
    { name: 'bindery-worker-1', image: `ghcr.io/matdemers1/bindery/worker:sha-${sha}`, project: 'bindery', service: 'worker', tier: 'shipped', app: 'bindery', cpu: 11.8, memoryMb: 1126, limitGb: 2 },
    { name: 'bindery-postgres-1', image: 'postgres:16', project: 'bindery', service: 'postgres', tier: 'shipped', app: 'bindery', health: 'healthy', cpu: 0.6, memoryMb: 188 },
    { name: 'foreman-server-1', image: `ghcr.io/matdemers1/foreman/server:sha-${sha}`, project: 'foreman', service: 'server', tier: 'shipped', app: 'foreman', health: 'healthy', cpu: 1.1, memoryMb: 240, restarts: 2 },
    { name: 'immich-server-1', image: 'ghcr.io/immich-app/immich-server:v1.140.0', project: 'immich', service: 'server', tier: 'operated', app: 'immich', cpu: 3.2, memoryMb: 900 },
    { name: 'forgejo', image: 'codeberg.org/forgejo/forgejo:11', project: 'forgejo', service: 'server', tier: 'observed', health: 'healthy', cpu: 0.9, memoryMb: 164 },
    { name: 'forgejo-db', image: 'postgres:16', project: 'forgejo', service: 'db', tier: 'observed', health: 'healthy', cpu: 0.3, memoryMb: 92 },
    { name: 'forgejo-ci-dind', image: 'docker:27-dind', project: 'forgejo', service: 'dind', tier: 'observed', state: 'exited' },
    { name: 'portainer', image: 'portainer/portainer-ce:2.21.0', project: null, tier: 'observed', cpu: 0.1, memoryMb: 40 },
  ];
  return HostInventory.parse({
    sampledAt: new Date(now - 1_000).toISOString(),
    containers: containers.map((c) => container(c, now)),
    volumes: [
      volume('bindery_pgdata', 2355, ['bindery-postgres-1'], 'bindery'),
      volume('forgejo_data', 1126, ['forgejo'], 'forgejo'),
      volume('immich_library', 52_000, ['immich-server-1'], 'immich'),
      volume('kardashev_pgdata', 412, [], 'kardashev'),
      volume('crownfall_redis', 3, [], 'crownfall'),
      volume(hex64('anonymous volume'), 88, [], null),
      volume('forgejo_dind', null, ['forgejo-ci-dind'], 'forgejo'),
      volume('foreman_pgdata', 640, ['foreman-server-1'], 'foreman'),
    ],
    images: [
      image(`ghcr.io/matdemers1/bindery/server:sha-${sha}`, 420, 1),
      image(`ghcr.io/matdemers1/bindery/worker:sha-${sha}`, 2150, 1),
      image(`ghcr.io/matdemers1/bindery/worker:sha-${'b'.repeat(40)}`, 2150, 0),
      image('postgres:16', 432, 2),
      image(`ghcr.io/matdemers1/foreman/server:sha-${sha}`, 380, 1),
      image('ghcr.io/immich-app/immich-server:v1.140.0', 1700, 1),
      image('codeberg.org/forgejo/forgejo:11', 210, 1),
      image('docker:27-dind', 360, 1),
      image('portainer/portainer-ce:2.21.0', 290, 1),
      image(null, 120, 0),
    ],
    networks: [],
    builderCache: { bytes: 4 * GB, reclaimableBytes: GB },
    disk: {
      dataRoot: { path: '/DATA', freeBytes: 875 * GB, totalBytes: 904 * GB },
      dockerRoot: { path: '/var/lib/docker', freeBytes: 120 * GB, totalBytes: 230 * GB },
    },
  });
}

/** Writes the snapshot (reported `reportedAgoMs` before `now`) and six samples per running container. */
export async function seedHostSnapshot(db: Db, agentId: string, now: number = Date.now(), reportedAgoMs = 0): Promise<void> {
  const inventory = hostInventory(now);
  const reportedAt = new Date(now - reportedAgoMs);
  await db.hostSnapshot.upsert({
    where: { agentId },
    create: { agentId, inventory, sampledAt: new Date(inventory.sampledAt), reportedAt },
    update: { inventory, sampledAt: new Date(inventory.sampledAt), reportedAt },
  });
  await db.hostSample.deleteMany({ where: { agentId } });
  const wobble = [0.6, 1.3, 0.8, 1.5, 0.9, 1];
  await db.hostSample.createMany({
    data: inventory.containers.flatMap((c) =>
      c.stats === null
        ? []
        : wobble.map((w, i) => ({
            agentId,
            containerName: c.name,
            at: new Date(reportedAt.getTime() - (wobble.length - 1 - i) * 60_000),
            cpuPercent: (c.stats?.cpuPercent ?? 0) * w,
            memoryBytes: BigInt(c.stats?.memoryBytes ?? 0),
          })),
    ),
  });
}

/** Moves the stored snapshot's report time, to show it fresh or stale without a new inventory. */
export async function setHostReportedAt(db: Db, agentId: string, reportedAt: Date): Promise<void> {
  await db.hostSnapshot.update({ where: { agentId }, data: { reportedAt } });
}
