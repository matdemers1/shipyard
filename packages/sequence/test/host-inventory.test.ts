import type Dockerode from 'dockerode';
import { describe, expect, it, vi } from 'vitest';

import { createDockerAdapter, healthFromStatus, parseDfSpace } from '../src/adapters/docker.js';

/**
 * The host inventory reads (SHP-T-14.4, SHP-REQ-175..177). The fake dockerode below has only the
 * Engine's read calls: a state-changing call from any of these methods would be a TypeError, so a
 * green run is also the proof that the inventory reads change nothing.
 */

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const ID_C = 'c'.repeat(64);
const IMG = `sha256:${'1'.repeat(64)}`;
const NET = 'd'.repeat(64);

const SECRET_CMD = 'node server.js --admin-token=s3cr3t-token';

function listed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: ID_A,
    Names: ['/toy-web-1'],
    Image: 'ghcr.io/o/web:sha-abc',
    ImageID: IMG,
    // Never read, never carried: the command line often holds a secret.
    Command: SECRET_CMD,
    Created: 1_790_000_000,
    State: 'running',
    Status: 'Up 2 hours (healthy)',
    Ports: [
      { IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 8080, Type: 'tcp' },
      { IP: '::', PrivatePort: 3000, PublicPort: 8080, Type: 'tcp' },
      { PrivatePort: 9000, Type: 'udp' },
    ],
    Labels: {
      'com.docker.compose.project': 'toy',
      'com.docker.compose.service': 'web',
      'com.example.billing-token-label': 'label-secret-value',
    },
    NetworkSettings: { Networks: { toy_default: { NetworkID: NET } } },
    Mounts: [
      { Type: 'volume', Name: 'toy_data', Source: '/var/lib/docker/volumes/toy_data/_data', Destination: '/data', RW: true },
      { Type: 'bind', Source: '/srv/toy/conf', Destination: '/conf', RW: false },
    ],
    ...over,
  };
}

function inspected(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: ID_A,
    RestartCount: 3,
    State: { Status: 'running', StartedAt: '2026-10-20T10:00:00.123456789Z', Health: { Status: 'healthy', Log: [{ Output: 'DB_PASSWORD=hunter2' }] } },
    // What an inspect carries and the adapter must never read.
    Config: { Env: ['DB_PASSWORD=hunter2'], Cmd: ['node', 'server.js', '--admin-token=s3cr3t-token'], Entrypoint: ['tini'], Labels: { 'com.example.billing-token-label': 'x' } },
    ...over,
  };
}

interface FakeOptions {
  containers?: Record<string, unknown>[];
  inspect?: (id: string) => Promise<unknown>;
  stats?: (id: string, opts: unknown) => Promise<unknown>;
  volumes?: unknown;
  df?: unknown;
  images?: unknown;
  networks?: unknown;
  info?: unknown;
  helper?: { exitCode?: number; stdout?: string };
}

function fakeEngine(o: FakeOptions = {}) {
  const calls: string[] = [];
  const helpers: Dockerode.ContainerCreateOptions[] = [];
  const docker = {
    listContainers: vi.fn((opts: unknown) => {
      calls.push(`listContainers ${JSON.stringify(opts)}`);
      return Promise.resolve(o.containers ?? [listed()]);
    }),
    getContainer: vi.fn((id: string) => ({
      inspect: () => {
        calls.push(`inspect ${id.slice(0, 1)}`);
        return o.inspect === undefined ? Promise.resolve(inspected({ Id: id })) : o.inspect(id);
      },
      stats: (opts: unknown) => {
        calls.push(`stats ${JSON.stringify(opts)}`);
        return o.stats === undefined ? Promise.reject(new Error('no stats')) : o.stats(id, opts);
      },
    })),
    listVolumes: vi.fn(() => {
      calls.push('listVolumes');
      return Promise.resolve(o.volumes ?? { Volumes: [], Warnings: null });
    }),
    df: vi.fn(() => {
      calls.push('df');
      return Promise.resolve(o.df ?? {});
    }),
    listImages: vi.fn(() => {
      calls.push('listImages');
      return Promise.resolve(o.images ?? []);
    }),
    listNetworks: vi.fn(() => {
      calls.push('listNetworks');
      return Promise.resolve(o.networks ?? []);
    }),
    info: vi.fn(() => Promise.resolve(o.info ?? { DockerRootDir: '/var/lib/docker' })),
    // The df helper container behind dockerRootSpace.
    getImage: vi.fn(() => ({ inspect: () => Promise.resolve({}) })),
    createContainer: vi.fn((c: Dockerode.ContainerCreateOptions) => {
      helpers.push(c);
      return Promise.resolve({
        start: () => Promise.resolve(),
        wait: () => Promise.resolve({ StatusCode: o.helper?.exitCode ?? 0 }),
        logs: () => Promise.resolve(frame(o.helper?.stdout ?? '')),
        remove: () => Promise.resolve(),
      });
    }),
  };
  return { docker: docker as unknown as Dockerode, calls, helpers };
}

function frame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('hostContainers (SHP-REQ-175)', () => {
  it('lists every container with all=1 and maps the fields the schema names', async () => {
    const stopped = listed({ Id: ID_B, Names: ['/toy-db-1'], State: 'exited', Status: 'Exited (0) 3 hours ago', Ports: null, Mounts: null, Labels: null });
    const { docker, calls } = fakeEngine({
      containers: [listed(), stopped],
      inspect: (id) =>
        Promise.resolve(id === ID_A ? inspected() : inspected({ Id: id, RestartCount: 0, State: { Status: 'exited', StartedAt: '0001-01-01T00:00:00Z' } })),
    });
    const adapter = createDockerAdapter({ docker });

    const found = await adapter.hostContainers();

    expect(calls[0]).toBe('listContainers {"all":true}');
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({
      id: ID_A,
      name: 'toy-web-1',
      image: 'ghcr.io/o/web:sha-abc',
      imageId: IMG,
      state: 'running',
      health: 'healthy',
      restartCount: 3,
      createdAt: '2026-09-21T14:13:20.000Z',
      startedAt: '2026-10-20T10:00:00.123Z',
      compose: { project: 'toy', service: 'web' },
      // One entry per address a port is published on; an unpublished port has no public port or address.
      ports: [
        { privatePort: 3000, publicPort: 8080, protocol: 'tcp', ip: '0.0.0.0' },
        { privatePort: 3000, publicPort: 8080, protocol: 'tcp', ip: '::' },
        { privatePort: 9000, publicPort: null, protocol: 'udp', ip: null },
      ],
      mounts: [
        { type: 'volume', volume: 'toy_data', source: null, destination: '/data', readOnly: false },
        { type: 'bind', volume: null, source: '/srv/toy/conf', destination: '/conf', readOnly: true },
      ],
      networkIds: [NET],
    });
    // A stopped container is listed, with its state, no start time and nothing it does not have.
    expect(found[1]).toMatchObject({ name: 'toy-db-1', state: 'exited', health: 'none', startedAt: null, compose: null, ports: [], mounts: [] });
  });

  it('carries no environment, command, entrypoint or non-compose label across the port (SHP-REQ-177)', async () => {
    const { docker } = fakeEngine();
    const found = await createDockerAdapter({ docker }).hostContainers();
    const text = JSON.stringify(found);
    expect(found).toHaveLength(1);
    for (const secret of ['hunter2', 'DB_PASSWORD', 's3cr3t-token', SECRET_CMD, 'tini', 'billing-token-label', 'label-secret-value']) {
      expect(text, secret).not.toContain(secret);
    }
    // Only the two compose labels survive, as `compose`.
    expect(found[0]?.compose).toEqual({ project: 'toy', service: 'web' });
    expect(Object.keys(found[0] ?? {}).sort()).toEqual(
      ['compose', 'createdAt', 'health', 'id', 'image', 'imageId', 'mounts', 'name', 'networkIds', 'ports', 'restartCount', 'startedAt', 'state'].sort(),
    );
  });

  it('degrades a container whose inspect fails, hangs or finds it gone', async () => {
    const warn = vi.fn();
    const gone = listed({ Id: ID_C, Names: ['/gone'] });
    const hung = listed({ Id: ID_B, Names: ['/hung-1'], Status: 'Up 1 minute (unhealthy)' });
    const { docker } = fakeEngine({
      containers: [listed(), hung, gone],
      inspect: (id) => {
        if (id === ID_A) return Promise.reject(new Error('engine hiccup'));
        if (id === ID_B) return new Promise(() => undefined);
        return Promise.reject(Object.assign(new Error('no such container'), { statusCode: 404 }));
      },
    });
    const found = await createDockerAdapter({ docker, hostCallTimeoutMs: 20, warn }).hostContainers();

    // The one removed since the list is not a container any more; the others stay, degraded.
    expect(found.map((c) => c.name)).toEqual(['toy-web-1', 'hung-1']);
    expect(found[0]).toMatchObject({ restartCount: 0, startedAt: null, health: 'healthy' });
    expect(found[1]).toMatchObject({ restartCount: 0, startedAt: null, health: 'unhealthy' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('reads health from the list status when the inspect says nothing', () => {
    expect(healthFromStatus('Up 2 hours (healthy)')).toBe('healthy');
    expect(healthFromStatus('Up 1 minute (unhealthy)')).toBe('unhealthy');
    expect(healthFromStatus('Up 2 seconds (health: starting)')).toBe('starting');
    expect(healthFromStatus('Up 2 hours')).toBe('none');
    expect(healthFromStatus(undefined)).toBe('none');
  });
});

describe('volumes, df, images and networks (SHP-REQ-176)', () => {
  it('maps volumes with only the compose project label', async () => {
    const { docker } = fakeEngine({
      volumes: {
        Volumes: [
          { Name: 'toy_data', Driver: 'local', Labels: { 'com.docker.compose.project': 'toy', 'com.example.secret': 'x' }, CreatedAt: '2026-10-01T08:00:00+00:00' },
          { Name: 'loose', Driver: 'local', Labels: null },
        ],
        Warnings: null,
      },
    });
    const volumes = await createDockerAdapter({ docker }).hostVolumes();
    expect(volumes).toEqual([
      { name: 'toy_data', driver: 'local', composeProject: 'toy', createdAt: '2026-10-01T08:00:00.000Z' },
      { name: 'loose', driver: 'local', composeProject: null, createdAt: null },
    ]);
    expect(JSON.stringify(volumes)).not.toContain('secret');
  });

  it('reads volume sizes (-1 is unknown) and the builder cache (reclaimable is what is not in use) from /system/df', async () => {
    const { docker } = fakeEngine({
      df: {
        Volumes: [
          { Name: 'toy_data', UsageData: { Size: 4096, RefCount: 1 } },
          { Name: 'huge', UsageData: { Size: -1, RefCount: -1 } },
          { Name: 'bare' },
        ],
        BuildCache: [
          { ID: 'x', InUse: true, Size: 1000 },
          { ID: 'y', InUse: false, Size: 300 },
          { ID: 'z', InUse: false, Size: 200 },
        ],
      },
    });
    expect(await createDockerAdapter({ docker }).systemDf()).toEqual({
      volumeSizes: { toy_data: 4096, huge: null, bare: null },
      builderCache: { bytes: 1500, reclaimableBytes: 500 },
    });
  });

  it('tolerates a df with no volumes or build cache', async () => {
    const { docker } = fakeEngine({ df: { Volumes: null, BuildCache: null } });
    expect(await createDockerAdapter({ docker }).systemDf()).toEqual({ volumeSizes: {}, builderCache: { bytes: 0, reclaimableBytes: 0 } });
  });

  it('maps images without the none placeholders, and networks with only the compose label', async () => {
    const { docker } = fakeEngine({
      images: [
        { Id: IMG, RepoTags: ['ghcr.io/o/web:sha-abc'], RepoDigests: ['ghcr.io/o/web@sha256:' + '2'.repeat(64)], Size: 1234, Created: 1_790_000_000, Labels: { secret: 'x' } },
        { Id: 'sha256:' + '3'.repeat(64), RepoTags: ['<none>:<none>'], RepoDigests: ['<none>@<none>'], Size: 99, Created: 1_790_000_100 },
        { Id: 'sha256:' + '4'.repeat(64), RepoTags: null, Size: 5, Created: 1_790_000_200 },
      ],
      networks: [
        { Id: NET, Name: 'toy_default', Driver: 'bridge', Scope: 'local', Internal: false, Labels: { 'com.docker.compose.project': 'toy', other: 'x' } },
        { Id: 'e'.repeat(64), Name: 'bridge', Driver: 'bridge', Scope: 'local', Labels: null },
      ],
    });
    const adapter = createDockerAdapter({ docker });
    const images = await adapter.hostImages();
    expect(images[0]).toEqual({
      id: IMG,
      repoTags: ['ghcr.io/o/web:sha-abc'],
      repoDigests: ['ghcr.io/o/web@sha256:' + '2'.repeat(64)],
      sizeBytes: 1234,
      createdAt: '2026-09-21T14:13:20.000Z',
    });
    expect(images[1]).toMatchObject({ repoTags: [], repoDigests: [] });
    expect(images[2]).toMatchObject({ repoTags: [], repoDigests: [] });
    expect(JSON.stringify(images)).not.toContain('secret');

    const networks = await adapter.hostNetworks();
    expect(networks).toEqual([
      { id: NET, name: 'toy_default', driver: 'bridge', scope: 'local', internal: false, composeProject: 'toy' },
      { id: 'e'.repeat(64), name: 'bridge', driver: 'bridge', scope: 'local', internal: false, composeProject: null },
    ]);
  });
});

describe('containerStats', () => {
  const sample = (over: Record<string, unknown> = {}) => ({
    cpu_stats: { cpu_usage: { total_usage: 5_000 }, system_cpu_usage: 100_000, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
    memory_stats: { usage: 10_000, limit: 8_000_000, stats: { inactive_file: 2_500 } },
    ...over,
  });

  it('asks for one shot, not a stream, and takes the page cache out of memory', async () => {
    const { docker, calls } = fakeEngine({ stats: () => Promise.resolve(sample()) });
    const out = await createDockerAdapter({ docker }).containerStats(ID_A);
    expect(calls).toContain('stats {"stream":false,"one-shot":true}');
    expect(out).toEqual({ cpuTotal: 5_000, systemCpu: 100_000, onlineCpus: 4, memoryBytes: 7_500, memoryLimitBytes: 8_000_000 });
  });

  it('uses cgroup v1 cache when there is no inactive_file, and reports no limit when absent', async () => {
    const { docker } = fakeEngine({ stats: () => Promise.resolve(sample({ memory_stats: { usage: 9_000, stats: { cache: 1_000 } } })) });
    const out = await createDockerAdapter({ docker }).containerStats(ID_A);
    expect(out).toMatchObject({ memoryBytes: 8_000, memoryLimitBytes: null });
  });

  it('is null for a container that has gone, a sample without counters, and throws on other errors', async () => {
    const gone = fakeEngine({ stats: () => Promise.reject(Object.assign(new Error('no such container'), { statusCode: 404 })) });
    expect(await createDockerAdapter({ docker: gone.docker }).containerStats(ID_A)).toBeNull();
    const empty = fakeEngine({ stats: () => Promise.resolve({ memory_stats: {}, cpu_stats: {} }) });
    expect(await createDockerAdapter({ docker: empty.docker }).containerStats(ID_A)).toBeNull();
    const broken = fakeEngine({ stats: () => Promise.reject(new Error('engine down')) });
    await expect(createDockerAdapter({ docker: broken.docker }).containerStats(ID_A)).rejects.toThrow('engine down');
  });

  it('gives up on a stats call that hangs', async () => {
    const { docker } = fakeEngine({ stats: () => new Promise(() => undefined) });
    await expect(createDockerAdapter({ docker, hostCallTimeoutMs: 20 }).containerStats(ID_A)).rejects.toThrow('timed out');
  });
});

describe('dockerRootSpace', () => {
  const DF = 'Filesystem           1024-blocks    Used Available Capacity Mounted on\n/dev/vda1            1055761844 121599040 880459380  12% /shipyard-docker-root\n';

  it('mounts DockerRootDir read-only into the df helper and returns total and free bytes', async () => {
    const { docker, helpers } = fakeEngine({ helper: { stdout: DF }, info: { DockerRootDir: '/mnt/docker' } });
    const space = await createDockerAdapter({ docker }).dockerRootSpace();
    expect(space).toEqual({ path: '/mnt/docker', totalBytes: 1055761844 * 1024, freeBytes: 880459380 * 1024 });
    expect(helpers[0]?.HostConfig).toMatchObject({ NetworkMode: 'none', Binds: ['/mnt/docker:/shipyard-docker-root:ro'] });
  });

  it('rejects when the helper exits non-zero', async () => {
    const { docker } = fakeEngine({ helper: { exitCode: 1, stdout: '' } });
    await expect(createDockerAdapter({ docker }).dockerRootSpace()).rejects.toThrow('df on /var/lib/docker failed');
  });

  it('parseDfSpace reads columns 2 and 4 and rejects garbage', () => {
    expect(parseDfSpace(DF)).toEqual({ totalBytes: 1055761844 * 1024, availableBytes: 880459380 * 1024 });
    expect(() => parseDfSpace('nothing useful')).toThrow('unexpected df output');
    expect(() => parseDfSpace('h\nx y z')).toThrow('unexpected df row');
  });
});
