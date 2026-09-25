import type Dockerode from 'dockerode';
import { describe, expect, it, vi } from 'vitest';

import {
  composeArgv,
  createDockerAdapter,
  demuxDockerStream,
  parseDfAvailableBytes,
  parseWgetStatus,
  runArgv,
  type ExecFileFn,
} from '../src/adapters/docker.js';
import type { ComposeTarget, ExecResult } from '../src/ports.js';

const TARGET: ComposeTarget = { files: ['/srv/app/compose.yml', '/srv/app/compose.prod.yml'], project: 'app' };

function recordingExec(result: ExecResult = { exitCode: 0, stdout: '', stderr: '' }) {
  const calls: { file: string; args: string[]; options: { env: NodeJS.ProcessEnv; timeoutMs?: number } }[] = [];
  const execFile: ExecFileFn = (file, args, options) => {
    calls.push({ file, args, options });
    return Promise.resolve(result);
  };
  return { calls, execFile };
}

/** Frames a payload the way Docker multiplexes non-TTY logs. */
function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

// Recorded 2026-09-24: busybox:1.37 `wget -q -S -O - -T 3` against busybox httpd on a user network.
const WGET_200_STDERR = [
  '  HTTP/1.1 200 OK',
  '  Date: Thu, 24 Sep 2026 23:42:26 GMT',
  '  Connection: close',
  '  Accept-Ranges: bytes',
  '  Last-Modified: Thu, 24 Sep 2026 23:42:25 GMT',
  '  ETag: "6ab5b561-10"',
  '  Content-Length: 16',
  '  ',
  '',
].join('\n');
const WGET_200_STDOUT = '{"status":"ok"}\n';
const WGET_404_STDERR = '  HTTP/1.1 404 Not Found\nwget: server returned error: HTTP/1.1 404 Not Found\n';
const WGET_REFUSED_STDERR = "wget: can't connect to remote host (172.22.0.2): Connection refused\n";

// Recorded 2026-09-24: busybox:1.37 `df -Pk /shipyard-docker-root` with /var/lib/docker bind-mounted.
const DF_BUSYBOX = [
  'Filesystem           1024-blocks    Used Available Capacity Mounted on',
  '/dev/vda1            1055761844 121599040 880459380  12% /shipyard-docker-root',
  '',
].join('\n');
// GNU coreutils `df -Pk` shape.
const DF_GNU = [
  'Filesystem     1024-blocks      Used Available Capacity Mounted on',
  '/dev/sda2        959863856 402312680 508705272      45% /shipyard-docker-root',
].join('\n');

interface FakeNetworkState {
  members: Map<string, Set<string>>;
}

/**
 * A fake dockerode covering what the adapter touches. Networks are real sets, so a test can assert
 * a network's container list is exactly what it was before.
 */
function fakeDocker(opts: {
  serviceNetworks?: string[];
  selfNetworks?: string[];
  helperLogs?: Buffer;
  helperExit?: number;
  helperHangs?: boolean;
  dockerRootDir?: string;
  imageMissing?: boolean;
} = {}) {
  const state: FakeNetworkState = { members: new Map() };
  const serviceNetworks = opts.serviceNetworks ?? ['app_default'];
  for (const n of serviceNetworks) state.members.set(n, new Set(['svc-container']));
  for (const n of opts.selfNetworks ?? ['shipyard_default']) {
    const set = state.members.get(n) ?? new Set<string>();
    set.add('self');
    state.members.set(n, set);
  }
  const createdHelpers: Dockerode.ContainerCreateOptions[] = [];
  const removedHelpers: string[] = [];
  const events: string[] = [];
  let helperCount = 0;
  let pulled = false;

  const docker = {
    listContainers: vi.fn((_o: Dockerode.ContainerListOptions) =>
      Promise.resolve([
        {
          Id: 'svc-container',
          ImageID: 'sha256:img',
          Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web' },
          State: 'running',
          NetworkSettings: { Networks: Object.fromEntries(serviceNetworks.map((n) => [n, {}])) },
        },
      ]),
    ),
    getImage: vi.fn((ref: string) => ({
      inspect: () => {
        if (ref === 'busybox:1.37' && opts.imageMissing === true && !pulled) {
          return Promise.reject(Object.assign(new Error('no such image'), { statusCode: 404 }));
        }
        return Promise.resolve({
          RepoDigests: ['ghcr.io/o/app@sha256:' + 'a'.repeat(64)],
          Config: { Labels: { 'org.opencontainers.image.revision': 'abc' } },
        });
      },
      remove: vi.fn(() => Promise.resolve()),
    })),
    getContainer: vi.fn((id: string) => ({
      inspect: () =>
        Promise.resolve({
          Id: id,
          State: { Status: 'running', StartedAt: '2026-09-24T10:00:00.000000000Z' },
          RestartCount: 2,
          NetworkSettings: {
            Networks: Object.fromEntries(
              [...state.members.entries()].filter(([, s]) => s.has(id)).map(([n]) => [n, {}]),
            ),
          },
        }),
    })),
    getNetwork: vi.fn((name: string) => ({
      connect: (o: { Container: string }) => {
        events.push(`connect ${name}`);
        state.members.get(name)?.add(o.Container);
        return Promise.resolve();
      },
      disconnect: (o: { Container: string }) => {
        events.push(`disconnect ${name}`);
        state.members.get(name)?.delete(o.Container);
        return Promise.resolve();
      },
    })),
    createContainer: vi.fn((o: Dockerode.ContainerCreateOptions) => {
      createdHelpers.push(o);
      const id = `helper-${String(++helperCount)}`;
      const network = o.HostConfig?.NetworkMode;
      return Promise.resolve({
        id,
        start: () => {
          if (network !== undefined) state.members.get(network)?.add(id);
          return Promise.resolve();
        },
        wait: () =>
          opts.helperHangs === true
            ? new Promise(() => undefined)
            : Promise.resolve({ StatusCode: opts.helperExit ?? 0 }),
        logs: () => Promise.resolve(opts.helperLogs ?? Buffer.alloc(0)),
        remove: () => {
          removedHelpers.push(id);
          if (network !== undefined) state.members.get(network)?.delete(id);
          return Promise.resolve();
        },
      });
    }),
    pull: vi.fn(() => {
      pulled = true;
      return Promise.resolve({});
    }),
    modem: {
      followProgress: (_s: unknown, done: (err: Error | null) => void) => {
        done(null);
      },
    },
    info: vi.fn(() => Promise.resolve({ DockerRootDir: opts.dockerRootDir ?? '/var/lib/docker' })),
    listImages: vi.fn(() => Promise.resolve([])),
  };
  const snapshot = (): Record<string, string[]> =>
    Object.fromEntries([...state.members.entries()].map(([n, s]) => [n, [...s].sort()]));
  return { docker: docker as unknown as Dockerode, raw: docker, createdHelpers, removedHelpers, events, snapshot };
}

describe('compose', () => {
  it('puts every -f, then -p, before the arguments, with no shell', async () => {
    const { calls, execFile } = recordingExec();
    const adapter = createDockerAdapter({ docker: fakeDocker().docker, execFile, env: { PATH: '/usr/bin' } });
    await adapter.compose(TARGET, ['up', '-d', '--wait']);
    await adapter.compose({ files: ['/one.yml'], project: 'p1' }, ['pull', '--quiet']);
    await adapter.compose(TARGET, ['run', '--rm', '--no-deps', 'migrate', 'node', 'migrate.mjs']);

    expect(calls[0]?.file).toBe('docker');
    expect(calls[0]?.args).toEqual([
      'compose',
      '-f',
      '/srv/app/compose.yml',
      '-f',
      '/srv/app/compose.prod.yml',
      '-p',
      'app',
      'up',
      '-d',
      '--wait',
    ]);
    expect(calls[1]?.args).toEqual(['compose', '-f', '/one.yml', '-p', 'p1', 'pull', '--quiet']);
    for (const call of calls) {
      const pIndex = call.args.indexOf('-p');
      const fIndexes = call.args.flatMap((a, i) => (a === '-f' ? [i] : []));
      expect(fIndexes.length).toBeGreaterThan(0);
      expect(pIndex).toBeGreaterThan(Math.max(...fIndexes));
      expect(call.args[0]).toBe('compose');
    }
  });

  it('uses the configured compose binary and passes DOCKER_HOST through', async () => {
    const { calls, execFile } = recordingExec();
    const adapter = createDockerAdapter({
      docker: fakeDocker().docker,
      execFile,
      composeBin: '/usr/local/bin/docker',
      dockerHost: 'tcp://127.0.0.1:23750',
      env: { PATH: '/usr/bin', DOCKER_CONTEXT: 'desktop-linux' },
    });
    await adapter.compose(TARGET, ['ps'], { timeoutMs: 5000 });
    expect(calls[0]?.file).toBe('/usr/local/bin/docker');
    expect(calls[0]?.options.env.DOCKER_HOST).toBe('tcp://127.0.0.1:23750');
    expect(calls[0]?.options.env.DOCKER_CONTEXT).toBeUndefined();
    expect(calls[0]?.options.timeoutMs).toBe(5000);
  });

  it('throws when files or project is empty, and never runs anything', async () => {
    const { calls, execFile } = recordingExec();
    const adapter = createDockerAdapter({ docker: fakeDocker().docker, execFile });
    await expect(adapter.compose({ files: [], project: 'app' }, ['up'])).rejects.toThrow(/-f/);
    await expect(adapter.compose({ files: [''], project: 'app' }, ['up'])).rejects.toThrow(/-f/);
    await expect(adapter.compose({ files: ['/c.yml'], project: '' }, ['up'])).rejects.toThrow(/-p/);
    await expect(adapter.compose({ files: ['/c.yml'], project: '  ' }, ['up'])).rejects.toThrow(/-p/);
    expect(() => composeArgv({ files: [], project: 'x' }, [])).toThrow();
    expect(calls).toHaveLength(0);
  });

  it('returns a non-zero exit instead of throwing', async () => {
    const { execFile } = recordingExec({ exitCode: 1, stdout: '', stderr: 'no such service: nope' });
    const adapter = createDockerAdapter({ docker: fakeDocker().docker, execFile });
    await expect(adapter.compose(TARGET, ['up', 'nope'])).resolves.toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'no such service: nope',
    });
  });
});

describe('runArgv (the default process runner)', () => {
  const node = process.execPath;
  const env = { PATH: process.env.PATH ?? '' };

  it('captures stdout, stderr and the exit code without a shell', async () => {
    const r = await runArgv(node, ['-e', 'process.stdout.write("out;$HOME"); process.stderr.write("err"); process.exit(3)'], {
      env,
    });
    expect(r).toEqual({ exitCode: 3, stdout: 'out;$HOME', stderr: 'err' });
  });

  it('keeps the tail when output passes the cap', async () => {
    const r = await runArgv(node, ['-e', 'process.stdout.write("a".repeat(5000) + "TAIL")'], { env, capBytes: 1000 });
    expect(r.stdout).toHaveLength(1000);
    expect(r.stdout.endsWith('TAIL')).toBe(true);
  });

  it('kills a process that runs past its timeout and reports 124', async () => {
    const started = Date.now();
    const r = await runArgv(node, ['-e', 'console.log("started"); setTimeout(() => {}, 60000)'], { env, timeoutMs: 300 });
    expect(r.exitCode).toBe(124);
    expect(r.stdout).toContain('started');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports a missing binary as 127, not a throw', async () => {
    const r = await runArgv('/nonexistent/docker', ['compose'], { env });
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toMatch(/ENOENT/);
  });
});

describe('containers', () => {
  it('filters by project and service labels and reads digests and labels from the image', async () => {
    const f = fakeDocker({ serviceNetworks: ['app_default', 'app_internal'] });
    const adapter = createDockerAdapter({ docker: f.docker });
    const list = await adapter.containers(TARGET, 'web');
    expect(f.raw.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['com.docker.compose.project=app', 'com.docker.compose.service=web'] },
    });
    expect(f.raw.getImage).toHaveBeenCalledWith('sha256:img');
    expect(list).toEqual([
      {
        id: 'svc-container',
        service: 'web',
        repoDigests: ['ghcr.io/o/app@sha256:' + 'a'.repeat(64)],
        labels: { 'org.opencontainers.image.revision': 'abc' },
        state: 'running',
        networks: ['app_default', 'app_internal'],
        startedAt: '2026-09-24T10:00:00.000000000Z',
        restartCount: 2,
      },
    ]);
    expect(f.raw.getContainer).toHaveBeenCalledWith('svc-container');
  });

  it('omits startedAt and restartCount for a container removed between the list and the inspect', async () => {
    const f = fakeDocker();
    f.raw.getContainer.mockImplementation(() => ({
      inspect: () => Promise.reject(Object.assign(new Error('no such container'), { statusCode: 404 })),
    }));
    const adapter = createDockerAdapter({ docker: f.docker });
    const [only] = await adapter.containers(TARGET, 'web');
    expect(only).toBeDefined();
    expect(only).not.toHaveProperty('startedAt');
    expect(only).not.toHaveProperty('restartCount');
  });
});

describe('probeHealth in a container (joins the network, always leaves)', () => {
  it('connects, fetches http://<service>:<port><path>, then disconnects', async () => {
    const f = fakeDocker();
    const before = f.snapshot();
    const fetchFn = vi.fn((url: string | URL | Request) => {
      f.events.push(`fetch ${url instanceof Request ? url.url : url.toString()}`);
      return Promise.resolve(new Response('{"status":"ok","schema":"s1"}', { status: 200 }));
    });
    const adapter = createDockerAdapter({ docker: f.docker, selfContainerId: 'self', fetch: fetchFn });
    const res = await adapter.probeHealth(TARGET, 'web', 3000, '/health', 2000);
    expect(res).toEqual({ httpStatus: 200, body: { status: 'ok', schema: 's1' } });
    expect(f.events).toEqual(['connect app_default', 'fetch http://web:3000/health', 'disconnect app_default']);
    expect(f.snapshot()).toEqual(before);
  });

  it('returns a non-JSON body as text with its status', async () => {
    const f = fakeDocker();
    const fetchFn = () => Promise.resolve(new Response('Bad Gateway', { status: 502 }));
    const adapter = createDockerAdapter({ docker: f.docker, selfContainerId: 'self', fetch: fetchFn });
    await expect(adapter.probeHealth(TARGET, 'web', 3000, '/health', 2000)).resolves.toEqual({
      httpStatus: 502,
      body: 'Bad Gateway',
    });
  });

  it('disconnects even when fetch throws', async () => {
    const f = fakeDocker();
    const before = f.snapshot();
    const fetchFn = () => Promise.reject(new TypeError('fetch failed: ECONNREFUSED'));
    const adapter = createDockerAdapter({ docker: f.docker, selfContainerId: 'self', fetch: fetchFn });
    await expect(adapter.probeHealth(TARGET, 'web', 3000, '/health', 2000)).rejects.toThrow(/ECONNREFUSED/);
    expect(f.events).toEqual(['connect app_default', 'disconnect app_default']);
    expect(f.snapshot()).toEqual(before);
  });

  it('disconnects when the fetch times out', async () => {
    const f = fakeDocker();
    const before = f.snapshot();
    // Honours the abort signal the adapter passes, as real fetch does.
    const fetchFn = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => {
          rej(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        });
      });
    const adapter = createDockerAdapter({ docker: f.docker, selfContainerId: 'self', fetch: fetchFn });
    await expect(adapter.probeHealth(TARGET, 'web', 3000, '/health', 50)).rejects.toThrow(/timeout/);
    expect(f.events).toEqual(['connect app_default', 'disconnect app_default']);
    expect(f.snapshot()).toEqual(before);
  });

  it('does not connect (or disconnect) a network the agent is already on', async () => {
    const f = fakeDocker({ serviceNetworks: ['app_default'], selfNetworks: ['app_default'] });
    const before = f.snapshot();
    const fetchFn = () => Promise.resolve(new Response('ok', { status: 200 }));
    const adapter = createDockerAdapter({ docker: f.docker, selfContainerId: 'self', fetch: fetchFn });
    await adapter.probeHealth(TARGET, 'web', 3000, '/health', 2000);
    expect(f.events).toEqual([]);
    expect(f.snapshot()).toEqual(before);
  });
});

describe('probeHealth outside a container (throwaway wget container)', () => {
  it('runs busybox wget on the service network and parses status and body', async () => {
    const f = fakeDocker({ helperLogs: Buffer.concat([frame(2, WGET_200_STDERR), frame(1, WGET_200_STDOUT)]) });
    const before = f.snapshot();
    const adapter = createDockerAdapter({ docker: f.docker });
    const res = await adapter.probeHealth(TARGET, 'web', 3000, '/health', 4500);
    expect(res).toEqual({ httpStatus: 200, body: { status: 'ok' } });
    expect(f.createdHelpers[0]?.Image).toBe('busybox:1.37');
    expect(f.createdHelpers[0]?.Cmd).toEqual(['wget', '-q', '-S', '-O', '-', '-T', '5', 'http://web:3000/health']);
    expect(f.createdHelpers[0]?.HostConfig?.NetworkMode).toBe('app_default');
    expect(f.removedHelpers).toEqual(['helper-1']);
    expect(f.snapshot()).toEqual(before);
  });

  it('reports an error status from wget stderr', async () => {
    const f = fakeDocker({ helperLogs: frame(2, WGET_404_STDERR), helperExit: 1 });
    const before = f.snapshot();
    const adapter = createDockerAdapter({ docker: f.docker });
    await expect(adapter.probeHealth(TARGET, 'web', 3000, '/health', 2000)).resolves.toEqual({ httpStatus: 404, body: '' });
    expect(f.snapshot()).toEqual(before);
  });

  it('rejects on a connection error and still removes the helper', async () => {
    const f = fakeDocker({ helperLogs: frame(2, WGET_REFUSED_STDERR), helperExit: 1 });
    const before = f.snapshot();
    const adapter = createDockerAdapter({ docker: f.docker });
    await expect(adapter.probeHealth(TARGET, 'web', 3000, '/health', 2000)).rejects.toThrow(/Connection refused/);
    expect(f.removedHelpers).toEqual(['helper-1']);
    expect(f.snapshot()).toEqual(before);
  });

  it('rejects on timeout and still removes the helper', async () => {
    const f = fakeDocker({ helperHangs: true });
    const before = f.snapshot();
    const adapter = createDockerAdapter({ docker: f.docker, probeStartupGraceMs: 10 });
    await expect(adapter.probeHealth(TARGET, 'web', 3000, '/health', 50)).rejects.toThrow(/timed out/);
    expect(f.removedHelpers).toEqual(['helper-1']);
    expect(f.snapshot()).toEqual(before);
  });

  it('pulls the probe image when it is absent', async () => {
    const f = fakeDocker({ imageMissing: true, helperLogs: Buffer.concat([frame(2, WGET_200_STDERR), frame(1, 'ok')]) });
    const adapter = createDockerAdapter({ docker: f.docker });
    await adapter.probeHealth(TARGET, 'web', 3000, '/health', 1000);
    expect(f.raw.pull).toHaveBeenCalledWith('busybox:1.37');
  });
});

describe('freeBytes', () => {
  it('mounts DockerRootDir read-only into a df helper and parses available KiB', async () => {
    const f = fakeDocker({ helperLogs: frame(1, DF_BUSYBOX), dockerRootDir: '/mnt/data/docker' });
    const adapter = createDockerAdapter({ docker: f.docker });
    await expect(adapter.freeBytes()).resolves.toBe(880459380 * 1024);
    expect(f.createdHelpers[0]?.Cmd).toEqual(['df', '-Pk', '/shipyard-docker-root']);
    expect(f.createdHelpers[0]?.HostConfig?.Binds).toEqual(['/mnt/data/docker:/shipyard-docker-root:ro']);
    expect(f.removedHelpers).toEqual(['helper-1']);
  });

  it('parses GNU and busybox df -Pk output and rejects garbage', () => {
    expect(parseDfAvailableBytes(DF_GNU)).toBe(508705272 * 1024);
    expect(parseDfAvailableBytes(DF_BUSYBOX)).toBe(880459380 * 1024);
    expect(() => parseDfAvailableBytes('df: /x: No such file or directory')).toThrow();
  });
});

describe('images and removeImage', () => {
  it('merges reference matches with digest-only matches', async () => {
    const f = fakeDocker();
    const tagged = { Id: 'sha256:1', RepoTags: ['ghcr.io/o/app:sha-1'], RepoDigests: [], Created: 10, Size: 100 };
    const digestOnly = {
      Id: 'sha256:2',
      RepoTags: ['<none>:<none>'],
      RepoDigests: ['ghcr.io/o/app@sha256:' + 'b'.repeat(64)],
      Created: 20,
      Size: 200,
    };
    const other = { Id: 'sha256:3', RepoTags: ['ghcr.io/o/apple:1'], RepoDigests: ['ghcr.io/o/apple@sha256:' + 'c'.repeat(64)], Created: 1, Size: 1 };
    f.raw.listImages.mockImplementation(((o?: { filters?: unknown }) =>
      Promise.resolve(o === undefined ? [tagged, digestOnly, other] : [tagged])) as () => Promise<never[]>);
    const adapter = createDockerAdapter({ docker: f.docker });
    const images = await adapter.images('ghcr.io/o/app');
    expect(images.map((i) => i.id).sort()).toEqual(['sha256:1', 'sha256:2']);
    expect(images.find((i) => i.id === 'sha256:2')?.repoTags).toEqual([]);
  });

  it('swallows 409 and 404 with a warning, rethrows anything else', async () => {
    const warn = vi.fn();
    const make = (statusCode: number) =>
      ({
        getImage: () => ({ remove: () => Promise.reject(Object.assign(new Error('x'), { statusCode })) }),
      }) as unknown as Dockerode;
    await expect(createDockerAdapter({ docker: make(409), warn }).removeImage('sha256:1')).resolves.toBeUndefined();
    await expect(createDockerAdapter({ docker: make(404), warn }).removeImage('sha256:1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    await expect(createDockerAdapter({ docker: make(500), warn }).removeImage('sha256:1')).rejects.toThrow();
  });
});

describe('parsers', () => {
  it('parseWgetStatus takes the last status line', () => {
    expect(parseWgetStatus(WGET_200_STDERR)).toBe(200);
    expect(parseWgetStatus('  HTTP/1.1 302 Found\n  Location: /x\n  HTTP/1.1 404 Not Found\n')).toBe(404);
    expect(parseWgetStatus(WGET_REFUSED_STDERR)).toBeNull();
  });

  it('demuxDockerStream splits interleaved frames', () => {
    const buf = Buffer.concat([frame(1, 'a'), frame(2, 'x'), frame(1, 'b')]);
    expect(demuxDockerStream(buf)).toEqual({ stdout: 'ab', stderr: 'x' });
  });
});
