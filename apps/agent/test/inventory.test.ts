import { describe, expect, it, vi } from 'vitest';
import { AgentReport, HostInventory, type Manifest } from '@shipyard/schema';
import type {
  DockerPort,
  FsPort,
  HostContainerRecord,
  HostImageRecord,
  HostNetworkRecord,
  HostStatsSample,
  HostSystemDf,
  HostVolumeRecord,
} from '@shipyard/sequence';
import {
  DF_TTL_MS,
  DOCKER_ROOT_TTL_MS,
  FAILURE_RETRY_MS,
  containerDigest,
  cpuPercent,
  createInventoryCollector,
  deriveTier,
} from '../src/inventory.js';
import { buildReport } from '../src/report.js';

const ID = (c: string): string => c.repeat(64);
const IMG = (c: string): string => `sha256:${c.repeat(64)}`;
const DIGEST = `sha256:${'9'.repeat(64)}`;
const NET = ID('d');
const ROOT = '/data/shipyard';

function manifest(name: string, project: string): Manifest {
  return { name, compose: { files: [`/srv/${name}/compose.yml`], project } } as unknown as Manifest;
}

function record(over: Partial<HostContainerRecord> = {}): HostContainerRecord {
  return {
    id: ID('a'),
    name: 'toy-web-1',
    image: 'ghcr.io/o/web:sha-abc',
    imageId: IMG('1'),
    state: 'running',
    health: 'healthy',
    restartCount: 0,
    createdAt: '2026-10-20T09:00:00.000Z',
    startedAt: '2026-10-20T09:00:01.000Z',
    compose: { project: 'toy', service: 'web' },
    ports: [],
    mounts: [],
    networkIds: [NET],
    ...over,
  };
}

function sample(cpuTotal: number, systemCpu: number, over: Partial<HostStatsSample> = {}): HostStatsSample {
  return { cpuTotal, systemCpu, onlineCpus: 4, memoryBytes: 1_000_000, memoryLimitBytes: null, ...over };
}

const FS = { bsize: 4096, blocks: 1_000_000, bavail: 250_000 };

interface World {
  containers?: HostContainerRecord[];
  volumes?: HostVolumeRecord[];
  images?: HostImageRecord[];
  networks?: HostNetworkRecord[];
  df?: HostSystemDf;
  stats?: Record<string, HostStatsSample[]>;
}

/** A DockerPort with the inventory calls; the call counts show what the caches saved. */
function fakeDocker(world: World = {}) {
  const counts = { df: 0, root: 0, stats: 0, containers: 0 };
  const statsQueue = new Map(Object.entries(world.stats ?? {}).map(([id, list]) => [id, [...list]]));
  const docker: DockerPort = {
    compose: () => Promise.resolve({ exitCode: 0, stdout: '5.0.1', stderr: '' }),
    containers: () => Promise.resolve([]),
    probeHealth: () => Promise.reject(new Error('unused')),
    freeBytes: () => Promise.resolve(0),
    images: () => Promise.resolve([]),
    removeImage: () => Promise.resolve(),
    hostContainers: () => {
      counts.containers++;
      return Promise.resolve(world.containers ?? []);
    },
    hostVolumes: () => Promise.resolve(world.volumes ?? []),
    hostImages: () => Promise.resolve(world.images ?? []),
    hostNetworks: () => Promise.resolve(world.networks ?? []),
    systemDf: () => {
      counts.df++;
      return Promise.resolve(world.df ?? { volumeSizes: {}, builderCache: { bytes: 0, reclaimableBytes: 0 } });
    },
    containerStats: (id) => {
      counts.stats++;
      return Promise.resolve(statsQueue.get(id)?.shift() ?? null);
    },
    dockerRootSpace: () => {
      counts.root++;
      return Promise.resolve({ path: '/var/lib/docker', totalBytes: 1000, freeBytes: 400 });
    },
  };
  return { docker, counts, world };
}

function collector(world: World = {}, extra: { now?: () => number; log?: { info: () => void; warn: () => void } } = {}) {
  const fake = fakeDocker(world);
  const collect = createInventoryCollector({
    docker: fake.docker,
    dataRoot: ROOT,
    statfs: () => Promise.resolve(FS),
    totalMemoryBytes: () => 16_000_000_000,
    ...extra,
  });
  return { ...fake, collect };
}

describe('deriveTier (SHP-REQ-175)', () => {
  const manifests = [manifest('toy', 'toy-x1'), manifest('web', 'web')];

  it('is shipped, with the app, for a manifest compose project - mapped service or not', () => {
    expect(deriveTier('toy-x1', manifests)).toEqual({ tier: 'shipped', app: 'toy' });
    expect(deriveTier('web', manifests)).toEqual({ tier: 'shipped', app: 'web' });
  });

  it('is observed for a container compose did not create, and for a project no manifest names', () => {
    expect(deriveTier(null, manifests)).toEqual({ tier: 'observed', app: null });
    expect(deriveTier('somebody-elses', manifests)).toEqual({ tier: 'observed', app: null });
    expect(deriveTier('toy-x1', [])).toEqual({ tier: 'observed', app: null });
  });
});

describe('containerDigest', () => {
  const nginx = { repoDigests: [`nginx@${DIGEST}`, `ghcr.io/o/other@sha256:${'1'.repeat(64)}`] };

  it.each(['nginx:1', 'docker.io/library/nginx:1', 'index.docker.io/library/nginx', 'library/nginx:1.27@sha256:abc'])(
    'matches Docker Hub spelling %s to the Engine’s RepoDigest',
    (reference) => {
      expect(containerDigest(reference, nginx)).toBe(DIGEST);
    },
  );

  it('keeps a registry port apart from a tag, and never takes another repository’s digest', () => {
    expect(containerDigest('localhost:5000/toy:1', { repoDigests: [`localhost:5000/toy@${DIGEST}`] })).toBe(DIGEST);
    expect(containerDigest('ghcr.io/o/web:1', nginx)).toBeNull();
    expect(containerDigest(IMG('2'), nginx)).toBeNull();
  });
});

describe('cpuPercent', () => {
  it('is the cpu delta over the system delta, times the cpus, as docker stats does', () => {
    // 20 of every 100 system ns on a 4-cpu host: 80%, where 100% is one cpu's worth.
    expect(cpuPercent({ cpuTotal: 1_000, systemCpu: 10_000 }, sample(1_020, 10_100))).toBe(80);
  });

  it('is null when the counters stood still or went backwards', () => {
    expect(cpuPercent({ cpuTotal: 1_000, systemCpu: 10_000 }, sample(1_200, 10_000))).toBeNull();
    expect(cpuPercent({ cpuTotal: 1_000, systemCpu: 10_000 }, sample(500, 10_100))).toBeNull();
  });
});

describe('the inventory collector', () => {
  const now = (): number => Date.parse('2026-10-21T12:00:00Z');

  it('builds a HostInventory that the server schema accepts, with tiers, volumes, images and networks', async () => {
    const { collect } = collector(
      {
        containers: [
          record({
            mounts: [
              { type: 'volume', volume: 'toy_data', source: null, destination: '/data', readOnly: false },
              { type: 'bind', volume: null, source: '/srv/toy', destination: '/srv', readOnly: true },
            ],
          }),
          // Same compose project, no manifest mapping for the service: still the app's.
          record({ id: ID('b'), name: 'toy-db-1', compose: { project: 'toy', service: 'db' }, mounts: [{ type: 'volume', volume: 'toy_data', source: null, destination: '/var/db', readOnly: false }] }),
          // Not compose at all, stopped, on a local image.
          record({ id: ID('c'), name: 'unmanaged', image: 'busybox', imageId: IMG('2'), state: 'exited', health: 'none', startedAt: null, compose: null, networkIds: [] }),
        ],
        volumes: [
          { name: 'toy_data', driver: 'local', composeProject: 'toy', createdAt: '2026-10-01T00:00:00.000Z' },
          { name: 'toy_unused', driver: 'local', composeProject: null, createdAt: null },
        ],
        images: [
          { id: IMG('1'), repoTags: ['ghcr.io/o/web:sha-abc'], repoDigests: [`ghcr.io/o/web@${DIGEST}`, `ghcr.io/o/other@sha256:${'8'.repeat(64)}`], sizeBytes: 100, createdAt: '2026-10-01T00:00:00.000Z' },
          { id: IMG('2'), repoTags: ['busybox:latest'], repoDigests: [], sizeBytes: 5, createdAt: '2026-10-01T00:00:00.000Z' },
          { id: IMG('3'), repoTags: [], repoDigests: [], sizeBytes: 7, createdAt: '2026-10-01T00:00:00.000Z' },
        ],
        networks: [{ id: NET, name: 'toy_default', driver: 'bridge', scope: 'local', internal: false, composeProject: 'toy' }],
        df: { volumeSizes: { toy_data: 4096, toy_unused: null }, builderCache: { bytes: 1500, reclaimableBytes: 500 } },
      },
      { now },
    );

    const inventory = await collect([manifest('toy', 'toy'), manifest('other', 'other')]);
    expect(inventory).toBeDefined();
    expect(HostInventory.parse(inventory)).toEqual(inventory);

    expect(inventory?.sampledAt).toBe('2026-10-21T12:00:00.000Z');
    expect(inventory?.containers.map((c) => [c.name, c.tier, c.app, c.compose?.service ?? null])).toEqual([
      ['toy-db-1', 'shipped', 'toy', 'db'],
      ['toy-web-1', 'shipped', 'toy', 'web'],
      ['unmanaged', 'observed', null, null],
    ]);
    // The digest is the RepoDigest for the container's own repository, not another repo's.
    expect(inventory?.containers.find((c) => c.name === 'toy-web-1')?.digest).toBe(DIGEST);
    expect(inventory?.containers.find((c) => c.name === 'unmanaged')?.digest).toBeNull();

    expect(inventory?.volumes).toEqual([
      { name: 'toy_data', driver: 'local', sizeBytes: 4096, mountedBy: ['toy-db-1', 'toy-web-1'], composeProject: 'toy', orphan: false, createdAt: '2026-10-01T00:00:00.000Z' },
      { name: 'toy_unused', driver: 'local', sizeBytes: null, mountedBy: [], composeProject: null, orphan: true, createdAt: null },
    ]);
    expect(inventory?.images.map((i) => [i.id.slice(7, 8), i.containers, i.dangling])).toEqual([
      ['1', 2, false],
      ['2', 1, false],
      ['3', 0, true],
    ]);
    // Two containers are on the network; the stopped one has none.
    expect(inventory?.networks).toEqual([{ id: NET, name: 'toy_default', driver: 'bridge', scope: 'local', internal: false, containers: 2, composeProject: 'toy' }]);
    expect(inventory?.builderCache).toEqual({ bytes: 1500, reclaimableBytes: 500 });
    expect(inventory?.disk).toEqual({
      dataRoot: { path: ROOT, freeBytes: 250_000 * 4096, totalBytes: 1_000_000 * 4096 },
      dockerRoot: { path: '/var/lib/docker', freeBytes: 400, totalBytes: 1000 },
    });
  });

  it('keeps a container carrying secrets in its environment out of the inventory (SHP-REQ-177)', async () => {
    // The port type has no field for Env, Cmd or labels; a record that smuggles them in through a
    // cast still cannot reach the report, because the inventory is rebuilt field by field.
    const smuggled = { ...record(), Env: ['DB_PASSWORD=hunter2'], Cmd: ['run', '--token=abc'], Labels: { 'com.example.secret': 'x' } } as HostContainerRecord;
    const { collect } = collector({ containers: [smuggled] });
    const inventory = await collect([]);
    const text = JSON.stringify(inventory);
    for (const secret of ['hunter2', 'DB_PASSWORD', '--token', 'com.example.secret']) expect(text, secret).not.toContain(secret);
    expect(HostInventory.parse(inventory)).toEqual(inventory);
  });

  it('is undefined when the Docker port cannot list a host', async () => {
    const bare = { compose: () => Promise.reject(new Error('unused')) } as unknown as DockerPort;
    const collect = createInventoryCollector({ docker: bare, dataRoot: ROOT, statfs: () => Promise.resolve(FS) });
    expect(await collect([])).toBeUndefined();
  });

  it('reports no stats on a container first sample, then CPU and memory from the second; none when it is not running', async () => {
    let ms = 0;
    const world: World = {
      containers: [record(), record({ id: ID('b'), name: 'stopped', state: 'exited', health: 'none', startedAt: null })],
      stats: {
        [ID('a')]: [
          sample(1_000, 10_000, { memoryBytes: 52_428_800, memoryLimitBytes: 16_000_000_000 }),
          sample(1_400, 10_400, { memoryBytes: 52_428_800, memoryLimitBytes: 16_000_000_000 }),
          sample(1_500, 10_800, { memoryBytes: 60_000_000, memoryLimitBytes: 536_870_912 }),
        ],
        // A stopped container is never sampled, even if the engine had a sample for it.
        [ID('b')]: [sample(1, 1)],
      },
    };
    const { collect, counts } = collector(world, { now: () => ms });
    const stats = async () => (await collect([]))?.containers.map((c) => [c.name, c.stats]);

    // First sample of the running container: nothing to measure CPU against.
    expect(await stats()).toEqual([['stopped', null], ['toy-web-1', null]]);
    ms += 60_000;
    // 400 of 400 system ns on 4 cpus: 400%. Host-sized memory limit means no limit.
    expect(await stats()).toEqual([['stopped', null], ['toy-web-1', { cpuPercent: 400, memoryBytes: 52_428_800, memoryLimitBytes: null }]]);
    ms += 60_000;
    expect(await stats()).toEqual([['stopped', null], ['toy-web-1', { cpuPercent: 100, memoryBytes: 60_000_000, memoryLimitBytes: 536_870_912 }]]);
    expect(counts.stats).toBe(3);
  });

  it('degrades one failing stats read to null stats without failing the inventory', async () => {
    const warn = vi.fn();
    const fake = fakeDocker({ containers: [record()] });
    fake.docker.containerStats = () => Promise.reject(new Error('stats timed out'));
    const collect = createInventoryCollector({ docker: fake.docker, dataRoot: ROOT, statfs: () => Promise.resolve(FS), log: { info: vi.fn(), warn } });
    const inventory = await collect([]);
    expect(inventory?.containers[0]?.stats).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reports a stopped container on the very next collection', async () => {
    const world: World = { containers: [record()] };
    const { collect } = collector(world);
    expect((await collect([]))?.containers[0]).toMatchObject({ state: 'running' });
    world.containers = [record({ state: 'exited', health: 'none' })];
    const after = await collect([]);
    expect(after?.containers[0]).toMatchObject({ state: 'exited', stats: null });
  });

  it('does not re-read df within ten minutes, nor the Docker root within fifteen (fake clock)', async () => {
    let ms = Date.parse('2026-10-21T12:00:00Z');
    const { collect, counts } = collector({ containers: [record()] }, { now: () => ms });

    await collect([]);
    expect(counts).toMatchObject({ df: 1, root: 1 });

    ms += DF_TTL_MS - 1;
    await collect([]);
    expect(counts).toMatchObject({ df: 1, root: 1 });

    // df is due; the Docker root (15 minutes) is not yet.
    ms += 1;
    await collect([]);
    expect(counts).toMatchObject({ df: 2, root: 1 });

    ms = Date.parse('2026-10-21T12:00:00Z') + DOCKER_ROOT_TTL_MS;
    await collect([]);
    expect(counts.root).toBe(2);
    // The list and stats reads are never cached: every collection reads the containers afresh.
    expect(counts.containers).toBe(4);
  });

  it('keeps the last good Docker root when a refresh fails, and is null until the first success', async () => {
    let ms = 0;
    const warn = vi.fn();
    const fake = fakeDocker({ containers: [record()] });
    let fail = true;
    fake.docker.dockerRootSpace = () => (fail ? Promise.reject(new Error('helper timed out')) : Promise.resolve({ path: '/var/lib/docker', totalBytes: 1000, freeBytes: 400 }));
    const collect = createInventoryCollector({ docker: fake.docker, dataRoot: ROOT, statfs: () => Promise.resolve(FS), now: () => ms, log: { info: vi.fn(), warn } });

    expect((await collect([]))?.disk.dockerRoot).toBeNull();
    // A failure is retried after a minute, not on the next report.
    ms += FAILURE_RETRY_MS - 1;
    await collect([]);
    expect(warn).toHaveBeenCalledOnce();

    fail = false;
    ms += 1;
    expect((await collect([]))?.disk.dockerRoot).toEqual({ path: '/var/lib/docker', freeBytes: 400, totalBytes: 1000 });

    fail = true;
    ms += DOCKER_ROOT_TTL_MS;
    expect((await collect([]))?.disk.dockerRoot).toEqual({ path: '/var/lib/docker', freeBytes: 400, totalBytes: 1000 });
  });

  it('keeps the last volume sizes when df fails later, and reports none on a failed first read', async () => {
    let ms = 0;
    const warn = vi.fn();
    const fake = fakeDocker({ containers: [record()], volumes: [{ name: 'v', driver: 'local', composeProject: null, createdAt: null }] });
    let fail = false;
    fake.docker.systemDf = () => (fail ? Promise.reject(new Error('df took too long')) : Promise.resolve({ volumeSizes: { v: 77 }, builderCache: { bytes: 9, reclaimableBytes: 3 } }));
    const collect = createInventoryCollector({ docker: fake.docker, dataRoot: ROOT, statfs: () => Promise.resolve(FS), now: () => ms, log: { info: vi.fn(), warn } });

    expect((await collect([]))?.volumes[0]?.sizeBytes).toBe(77);
    fail = true;
    ms += DF_TTL_MS;
    const after = await collect([]);
    expect(after?.volumes[0]?.sizeBytes).toBe(77);
    expect(after?.builderCache).toEqual({ bytes: 9, reclaimableBytes: 3 });
    expect(warn).toHaveBeenCalledOnce();

    const cold = createInventoryCollector({ docker: fake.docker, dataRoot: ROOT, statfs: () => Promise.resolve(FS), now: () => ms, log: { info: vi.fn(), warn } });
    const first = await cold([]);
    expect(first?.volumes[0]?.sizeBytes).toBeNull();
    expect(first?.builderCache).toEqual({ bytes: 0, reclaimableBytes: 0 });
  });

  it('drops an inventory the server schema would refuse, with a warning, rather than failing the report', async () => {
    const warn = vi.fn();
    const { collect } = collector({ containers: [record({ id: 'short' })] }, { log: { info: vi.fn(), warn } });
    expect(await collect([])).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('buildReport with an inventory (SHP-REQ-175)', () => {
  const emptyFs: FsPort = {
    readFile: () => Promise.reject(new Error('ENOENT')),
    writeFileAtomic: () => Promise.reject(new Error('read-only')),
    appendLine: () => Promise.reject(new Error('read-only')),
    exists: (path) => Promise.resolve(path === `${ROOT}/apps`),
    mkdirp: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };
  const base = () => ({ fs: emptyFs, docker: fakeDocker().docker, engineApiVersion: () => Promise.resolve('1.51') });
  const versions = { agentVersion: '0', patExpiresAt: null };

  it('carries the host inventory, which the report schema accepts', async () => {
    const { collect } = collector({ containers: [record()] });
    const report = await buildReport({ ...base(), inventory: collect }, ROOT, versions);
    expect(report.host).toBeDefined();
    expect(AgentReport.parse(report)).toEqual(report);
    expect(HostInventory.parse(report.host).containers).toHaveLength(1);
  });

  it('goes without host, and warns, when the Engine fails while collecting', async () => {
    const warn = vi.fn();
    const report = await buildReport(
      { ...base(), inventory: () => Promise.reject(new Error('Cannot connect to the Docker daemon')), log: { info: vi.fn(), warn } },
      ROOT,
      versions,
    );
    expect('host' in report).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('goes without host when the inventory hangs, and does not start a second collection beside it', async () => {
    const warn = vi.fn();
    let started = 0;
    const hung = () => {
      started++;
      return new Promise<undefined>(() => undefined);
    };
    const ports = { ...base(), inventory: hung, inventoryDeadlineMs: 20, log: { info: vi.fn(), warn } };
    const first = await buildReport(ports, ROOT, versions);
    const second = await buildReport(ports, ROOT, versions);
    expect('host' in first).toBe(false);
    expect('host' in second).toBe(false);
    expect(started).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('has no host key without an inventory port, or when it resolves undefined', async () => {
    expect('host' in (await buildReport(base(), ROOT, versions))).toBe(false);
    expect('host' in (await buildReport({ ...base(), inventory: () => Promise.resolve(undefined) }, ROOT, versions))).toBe(false);
  });

  it('hands the inventory the manifests it just loaded, so tier follows them', async () => {
    const seen: string[][] = [];
    const files = new Map([
      [`${ROOT}/apps/toy.yml`, ['name: toy', 'repo: o/toy', 'workflow: ci.yml', 'compose:', '  files: [/srv/toy/compose.yml]', '  project: toy', 'services:', '  web: { image: ghcr.io/o/toy }', 'health: { service: web, port: 80, path: /health }', 'soakSeconds: 5', ''].join('\n')],
    ]);
    const fs: FsPort = {
      ...emptyFs,
      readFile: (path) => (files.has(path) ? Promise.resolve(files.get(path) ?? '') : Promise.reject(new Error('ENOENT'))),
      exists: (path) => Promise.resolve(path === `${ROOT}/apps`),
      list: (dir) => Promise.resolve([...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((path) => ({ path, size: 1, mtimeMs: 0 }))),
    };
    const { collect } = collector({ containers: [record()] });
    const report = await buildReport(
      { ...base(), fs, inventory: (manifests) => (seen.push(manifests.map((m) => m.name)), collect(manifests)) },
      ROOT,
      versions,
    );
    expect(seen).toEqual([['toy']]);
    expect(report.host?.containers[0]).toMatchObject({ tier: 'shipped', app: 'toy' });
  });
});
