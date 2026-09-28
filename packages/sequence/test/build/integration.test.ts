import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manifest } from '@shipyard/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  composeModelProblems,
  createIntegrationStage,
  integrationProjectName,
  renderIntegrationOverride,
} from '../../src/build/integration.js';
import type { DockerTarExport, IntegrationDocker, TestImageBuilder } from '../../src/build/integration.js';
import {
  BUILD_BLOCKED_CIDRS,
  BUILD_NETWORK_BRIDGE,
  BUILD_NETWORK_NAME,
  BUILD_NETWORK_SUBNET,
  verifyBuildNetwork,
} from '../../src/build/network.js';
import type { BuildNetworkInfo } from '../../src/build/network.js';
import { runBuildStages } from '../../src/build/stages.js';
import type { StageProgress } from '../../src/build/stages.js';
import { RefusalError } from '../../src/ports.js';
import type { ComposeTarget, ExecResult, SolveRequest } from '../../src/ports.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const BUILD_ID = 'b01abc';
const PROJECT = 'shipyard-build-b01abc';
const IMAGE = 'shipyard-build/toy:b01abc';

function manifest(integration: Record<string, unknown> = { compose: 'ci/integration.yml', service: 'itest', argv: ['npm', 'run', 'test:int'] }): Manifest {
  return Manifest.parse({
    name: 'toy',
    repo: 'matdemers1/toy',
    workflow: 'ci.yml',
    compose: { files: ['/data/toy/compose.yml'], project: 'toy' },
    services: { api: { image: 'ghcr.io/matdemers1/toy/api' } },
    health: { service: 'api', port: 3000, path: '/health' },
    build: { source: 'shipyard', testTarget: 'test', releaseTargets: { api: 'api-release' }, secrets: ['npm_token'], integration },
  });
}

/** A normalised `compose config --format json` model with an integration service and a Postgres sidecar. */
function goodModel(): Record<string, unknown> {
  return {
    name: PROJECT,
    services: {
      itest: {
        build: { context: '.', dockerfile: 'Dockerfile', target: 'test' },
        depends_on: { db: { condition: 'service_healthy', required: true } },
        environment: { DATABASE_URL: 'postgres://postgres:pw@db:5432/postgres' },
        networks: { default: null },
      },
      db: {
        image: 'postgres:16-alpine',
        environment: { POSTGRES_PASSWORD: 'pw' },
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U $$POSTGRES_USER'] },
        networks: { default: null },
        volumes: [
          { type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' },
          { type: 'tmpfs', target: '/tmp' },
          { type: 'volume', target: '/anon' },
        ],
      },
    },
    networks: { default: { name: `${PROJECT}_default`, ipam: {} } },
    volumes: { pgdata: { name: `${PROJECT}_pgdata` } },
  };
}

interface ComposeCall {
  target: ComposeTarget;
  args: string[];
  timeoutMs?: number;
  /** The override file's content when the call was made, if it existed. */
  override?: string;
}

interface FakeDocker extends IntegrationDocker {
  calls: ComposeCall[];
  loads: string[];
  removed: string[];
  /** Order of every call, for teardown ordering. */
  events: string[];
}

function fakeDocker(opts: { model?: unknown; configExit?: number; runExit?: number; run?: () => Promise<ExecResult>; loadExit?: number } = {}): FakeDocker {
  const calls: ComposeCall[] = [];
  const loads: string[] = [];
  const removed: string[] = [];
  const events: string[] = [];
  return {
    calls,
    loads,
    removed,
    events,
    async compose(target, args, options) {
      const call: ComposeCall = { target: structuredClone(target), args: [...args] };
      if (options?.timeoutMs !== undefined) call.timeoutMs = options.timeoutMs;
      const overridePath = target.files[1];
      if (overridePath !== undefined) {
        const text = await readFile(overridePath, 'utf-8').catch(() => undefined);
        if (text !== undefined) call.override = text;
      }
      calls.push(call);
      const sub = args[2] ?? '';
      events.push(`compose ${sub}`);
      if (sub === 'config') {
        return { exitCode: opts.configExit ?? 0, stdout: JSON.stringify(opts.model ?? goodModel()), stderr: '' };
      }
      if (sub === 'run') {
        if (opts.run !== undefined) return opts.run();
        return { exitCode: opts.runExit ?? 0, stdout: 'tests ran\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async removeImage(id) {
      events.push(`rmi ${id}`);
      removed.push(id);
      return Promise.resolve();
    },
    async loadImage(tar) {
      events.push('load');
      loads.push(tar);
      const bytes = await readFile(tar, 'utf-8');
      return { exitCode: opts.loadExit ?? 0, stdout: `Loaded image: ${bytes}\n`, stderr: '' };
    },
  };
}

interface Export {
  req: SolveRequest;
  out: DockerTarExport;
  secretContents: string[];
}

function fakeBuilder(opts: { exit?: number } = {}): { exports: Export[]; builder: TestImageBuilder } {
  const exports: Export[] = [];
  return {
    exports,
    builder: {
      async solveToDockerTar(req, out) {
        const secretContents = await Promise.all(req.secrets.map((s) => readFile(s.src, 'utf-8')));
        exports.push({ req: structuredClone(req), out: { ...out }, secretContents });
        await writeFile(out.dest, out.name);
        return { exitCode: opts.exit ?? 0 };
      },
    },
  };
}

let tmp: string;
let dir: string;
let work: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'integration-test-')));
  dir = join(tmp, 'src');
  work = join(tmp, 'work');
  await mkdir(join(dir, 'ci'), { recursive: true });
  await mkdir(work);
  await writeFile(join(dir, 'ci', 'integration.yml'), 'services: {}\n');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function stage(docker: IntegrationDocker, builder: TestImageBuilder, extra: Partial<Parameters<typeof createIntegrationStage>[0]> = {}) {
  return createIntegrationStage({
    docker,
    buildkit: builder,
    dir,
    manifest: manifest(),
    buildId: BUILD_ID,
    sha: SHA,
    tmpDir: work,
    secrets: new Map([['npm_token', 'npm_s3cr3t']]),
    ...extra,
  });
}

describe('createIntegrationStage', () => {
  it('inspects, exports and loads the test image, runs the service as shipyard-build-<id> with the argv array, then tears down', async () => {
    const docker = fakeDocker();
    const { exports, builder } = fakeBuilder();
    const logs: string[] = [];
    const passed = await stage(docker, builder)({ onLog: (c) => logs.push(c) });

    expect(passed).toBe(true);
    const composeFile = join(dir, 'ci', 'integration.yml');
    const [config, run, down] = docker.calls;
    expect(docker.calls).toHaveLength(3);

    // config: the source file only, the project, an empty env file, no interpolation.
    expect(config?.target).toEqual({ files: [composeFile], project: PROJECT });
    expect(config?.args.slice(0, 2)).toEqual(['--env-file', expect.stringMatching(/empty\.env$/) as string]);
    expect(config?.args.slice(2)).toEqual(['config', '--no-interpolate', '--format', 'json']);

    // run: source file + generated override, -p shipyard-build-<id>, argv passed as separate elements.
    expect(run?.target.project).toBe(PROJECT);
    expect(run?.target.files[0]).toBe(composeFile);
    expect(run?.target.files[1]).toMatch(/shipyard-integration\.override\.yml$/);
    expect(run?.args.slice(2)).toEqual(['run', '--rm', '-T', 'itest', 'npm', 'run', 'test:int']);
    expect(run?.timeoutMs).toBe(15 * 60_000);

    // down: same target, volumes and orphans too.
    expect(down?.target).toEqual(run?.target);
    expect(down?.args.slice(2)).toEqual(['down', '-v', '--remove-orphans', '--timeout', '5']);

    // The test target was exported (not pushed) as the build-scoped image, with secrets mounted.
    expect(exports).toHaveLength(1);
    expect(exports[0]?.req.target).toBe('test');
    expect(exports[0]?.req.push).toBeUndefined();
    expect(exports[0]?.req.contextDir).toBe(dir);
    expect(exports[0]?.out.name).toBe(IMAGE);
    expect(exports[0]?.secretContents).toEqual(['npm_s3cr3t']);
    expect(docker.loads).toHaveLength(1);
    expect(docker.removed).toEqual([IMAGE]);
    expect(docker.events).toEqual(['compose config', 'load', 'compose run', 'compose down', `rmi ${IMAGE}`]);
    expect(logs.join('')).toContain('tests ran');
    expect(logs.join('')).toContain('itest exited 0');

    // The work dir (override, env file, tar, secrets) is gone.
    expect(await readdir(work)).toEqual([]);
  });

  it('generates an override that pins the image, resets build, and puts the project on one internal network', async () => {
    const docker = fakeDocker();
    await stage(docker, fakeBuilder().builder)({ onLog: () => undefined });
    const override = docker.calls[1]?.override ?? '';
    expect(override).toContain('build: !reset null');
    const doc = parse(override.replace('!reset null', 'null')) as Record<string, Record<string, Record<string, unknown>>>;
    expect(doc.services).toEqual({ itest: { image: IMAGE, pull_policy: 'never', build: null } });
    expect(doc.networks).toEqual({ default: { name: `${PROJECT}_default`, driver: 'bridge', internal: true, enable_ipv6: false } });
    expect(override).not.toMatch(/ports|privileged|network_mode|cap_add|devices|bind/);
  });

  it('runs the image default command when the manifest has no argv, and honours a custom network name', async () => {
    const docker = fakeDocker();
    const hook = stage(docker, fakeBuilder().builder, {
      manifest: manifest({ compose: 'ci/integration.yml', service: 'itest' }),
      networkName: 'shipyard-build-b01abc-net',
    });
    await hook({ onLog: () => undefined });
    expect(docker.calls[1]?.args.slice(2)).toEqual(['run', '--rm', '-T', 'itest']);
    expect(docker.calls[1]?.override).toContain('name: shipyard-build-b01abc-net');
  });

  it('fails on a non-zero exit and still tears everything down', async () => {
    const docker = fakeDocker({ runExit: 3 });
    const logs: string[] = [];
    expect(await stage(docker, fakeBuilder().builder)({ onLog: (c) => logs.push(c) })).toBe(false);
    expect(docker.events).toEqual(['compose config', 'load', 'compose run', 'compose down', `rmi ${IMAGE}`]);
    expect(logs.join('')).toContain('itest exited 3');
    expect(await readdir(work)).toEqual([]);
  });

  it('reports a timeout (exit 124) as a failure', async () => {
    const docker = fakeDocker({ runExit: 124 });
    const logs: string[] = [];
    expect(await stage(docker, fakeBuilder().builder, { timeoutMs: 1000 })({ onLog: (c) => logs.push(c) })).toBe(false);
    expect(docker.calls[1]?.timeoutMs).toBe(1000);
    expect(logs.join('')).toContain('ran past 1000ms');
  });

  it('tears down when the run throws', async () => {
    const docker = fakeDocker({ run: () => Promise.reject(new Error('compose vanished')) });
    await expect(stage(docker, fakeBuilder().builder)({ onLog: () => undefined })).rejects.toThrow('compose vanished');
    expect(docker.events).toEqual(['compose config', 'load', 'compose run', 'compose down', `rmi ${IMAGE}`]);
    expect(await readdir(work)).toEqual([]);
  });

  it('on cancel mid-run: resolves false, runs down, waits for the run to exit, runs down again, removes the image', async () => {
    const controller = new AbortController();
    let finishRun: (r: ExecResult) => void = () => undefined;
    const docker = fakeDocker({
      run: () =>
        new Promise<ExecResult>((res) => {
          finishRun = res;
          controller.abort();
        }),
    });
    const original = docker.compose.bind(docker);
    docker.compose = async (target, args, options) => {
      const result = await original(target, args, options);
      // `down` kills the one-off container, so the run process then exits.
      if (args[2] === 'down') finishRun({ exitCode: 137, stdout: '', stderr: '' });
      return result;
    };
    const logs: string[] = [];
    const passed = await stage(docker, fakeBuilder().builder, { signal: controller.signal })({ onLog: (c) => logs.push(c) });
    expect(passed).toBe(false);
    expect(docker.events).toEqual(['compose config', 'load', 'compose run', 'compose down', 'compose down', `rmi ${IMAGE}`]);
    expect(logs.join('')).toContain('cancelled');
    expect(await readdir(work)).toEqual([]);
  });

  it('cancelled before it starts: nothing is built, loaded or run', async () => {
    const controller = new AbortController();
    controller.abort();
    const docker = fakeDocker();
    const { exports, builder } = fakeBuilder();
    expect(await stage(docker, builder, { signal: controller.signal })({ onLog: () => undefined })).toBe(false);
    expect(exports).toHaveLength(0);
    expect(docker.events).toEqual([]);
  });

  it('a failed export fails the stage without loading or running anything', async () => {
    const docker = fakeDocker();
    expect(await stage(docker, fakeBuilder({ exit: 1 }).builder)({ onLog: () => undefined })).toBe(false);
    expect(docker.events).toEqual(['compose config']);
  });

  it('a failed load fails the stage and still removes whatever was loaded', async () => {
    const docker = fakeDocker({ loadExit: 1 });
    expect(await stage(docker, fakeBuilder().builder)({ onLog: () => undefined })).toBe(false);
    expect(docker.events).toEqual(['compose config', 'load', `rmi ${IMAGE}`]);
  });

  it('refuses a compose file that publishes ports, is privileged or bind-mounts the host — before building anything', async () => {
    const model = goodModel();
    const services = model.services as Record<string, Record<string, unknown>>;
    const db = services.db ?? {};
    db.ports = [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp' }];
    db.privileged = true;
    db.volumes = [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }];
    const docker = fakeDocker({ model });
    const { exports, builder } = fakeBuilder();
    const err = await stage(docker, builder)({ onLog: () => undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    const { refusal } = err as RefusalError;
    expect(refusal.code).toBe('manifest_invalid');
    expect(refusal.message).toContain('service db publishes ports');
    expect(refusal.message).toContain('service db is privileged');
    expect(refusal.message).toContain('mounts a bind at /var/run/docker.sock');
    expect(exports).toHaveLength(0);
    expect(docker.events).toEqual(['compose config']);
    expect(await readdir(work)).toEqual([]);
  });

  it('refuses when compose cannot read the file', async () => {
    const docker = fakeDocker({ configExit: 15 });
    await expect(stage(docker, fakeBuilder().builder)({ onLog: () => undefined })).rejects.toBeInstanceOf(RefusalError);
  });

  it('refuses a compose path that resolves outside the source through a symlink', async () => {
    const { symlink } = await import('node:fs/promises');
    await rm(join(dir, 'ci', 'integration.yml'));
    await writeFile(join(tmp, 'outside.yml'), 'services: {}\n');
    await symlink(join(tmp, 'outside.yml'), join(dir, 'ci', 'integration.yml'));
    const docker = fakeDocker();
    await expect(stage(docker, fakeBuilder().builder)({ onLog: () => undefined })).rejects.toThrow(/outside the source/);
    expect(docker.calls).toHaveLength(0);
  });

  it('refuses a bad build ID, a foreign network name, and a manifest without integration', () => {
    expect(() => stage(fakeDocker(), fakeBuilder().builder, { buildId: '../x' })).toThrow(RefusalError);
    expect(() => stage(fakeDocker(), fakeBuilder().builder, { networkName: 'bridge' })).toThrow(RefusalError);
    const noIntegration = Manifest.parse({ ...manifest(), build: { source: 'shipyard', releaseTargets: { api: 'api-release' } } });
    expect(() => stage(fakeDocker(), fakeBuilder().builder, { manifest: noIntegration })).toThrow(RefusalError);
  });

  it('plugs into runBuildStages: a failing integration service fails the build at stage integration with no push', async () => {
    const docker = fakeDocker({ runExit: 1 });
    const pushes: SolveRequest[] = [];
    const progress: StageProgress[] = [];
    const result = await runBuildStages({
      dir,
      manifest: manifest(),
      sha: SHA,
      buildkit: {
        solve: (req) => {
          if (req.push !== undefined) pushes.push(req);
          return Promise.resolve({ exitCode: 0, digest: `sha256:${'a'.repeat(64)}` });
        },
        prune: () => Promise.resolve(),
        du: () => Promise.resolve({ bytes: 0 }),
      },
      secrets: new Map([['npm_token', 'npm_s3cr3t']]),
      tmpDir: work,
      onProgress: (p) => {
        progress.push(p);
      },
      integration: stage(docker, fakeBuilder().builder),
    });
    expect(result).toEqual({ state: 'failed', digests: {}, failedStage: 'integration' });
    expect(pushes).toHaveLength(0);
    expect(progress.map((p) => `${p.stage}:${p.state}`)).toEqual(['test:running', 'test:succeeded', 'integration:running', 'integration:failed']);
    expect(docker.removed).toEqual([IMAGE]);
  });
});

describe('composeModelProblems', () => {
  const ctx = (): { dir: string; project: string; service: string } => ({ dir, project: PROJECT, service: 'itest' });
  const withDb = (patch: Record<string, unknown>): Record<string, unknown> => {
    const model = goodModel();
    const services = model.services as Record<string, Record<string, unknown>>;
    services.db = { ...services.db, ...patch };
    return model;
  };

  it('accepts a sidecar with named, anonymous and tmpfs volumes and a $$-escaped healthcheck', () => {
    expect(composeModelProblems(goodModel(), ctx())).toEqual([]);
  });

  it.each([
    [{ network_mode: 'host' }, 'network_mode'],
    [{ pid: 'host' }, 'sets pid'],
    [{ ipc: 'host' }, 'ipc: host'],
    [{ cap_add: ['NET_ADMIN'] }, 'adds capabilities'],
    [{ devices: [{ source: '/dev/kvm', target: '/dev/kvm' }] }, 'maps devices'],
    [{ security_opt: ['seccomp=unconfined'] }, 'security_opt'],
    [{ userns_mode: 'host' }, 'userns_mode'],
    [{ volumes_from: ['container:other'] }, 'volumes_from'],
    [{ external_links: ['other_db_1:db'] }, 'external_links'],
    [{ networks: { default: null, other_net: null } }, 'joins network other_net'],
    [{ build: { context: '.' } }, 'service db has build'],
    [{ env_file: [{ path: '/DATA/shipyard/agent.env', required: true }] }, 'env_file outside'],
    [{ environment: { TOKEN: '${SHIPYARD_TOKEN}' } }, 'interpolation'],
  ])('refuses %j', (patch, expected) => {
    expect(composeModelProblems(withDb(patch), ctx()).join('; ')).toContain(expected);
  });

  it('refuses external or foreign volumes and networks, and host-backed volume driver_opts', () => {
    const model = goodModel();
    model.volumes = {
      pgdata: { name: 'otherapp_pgdata' },
      ext: { external: true, name: 'ext' },
      hostpath: { name: `${PROJECT}_hostpath`, driver: 'local', driver_opts: { type: 'none', o: 'bind', device: '/etc' } },
    };
    model.networks = { default: { name: 'otherapp_default', external: true }, extra: {} };
    const text = composeModelProblems(model, ctx()).join('; ');
    expect(text).toContain('volume pgdata names another volume');
    expect(text).toContain('volume ext is external');
    expect(text).toContain('volume hostpath sets driver_opts');
    expect(text).toContain('network default is external');
    expect(text).toContain('network default names another network');
    expect(text).toContain('network extra is declared');
  });

  it('refuses secrets read from the agent environment or outside the source, and a missing service', () => {
    const model = goodModel();
    model.secrets = { a: { environment: 'SHIPYARD_TOKEN' }, b: { file: '/etc/shadow' }, c: { file: join(dir, 'ci', 'ok.txt') } };
    const problems = composeModelProblems(model, { ...ctx(), service: 'nope' });
    expect(problems).toContain("secrets a reads the agent's environment");
    expect(problems).toContain('secrets b reads a file outside the source tree');
    expect(problems.join('; ')).not.toContain('secrets c');
    expect(problems).toContain('the integration service nope is not defined in the compose file');
  });
});

describe('integration names and override', () => {
  it('lowercases the build ID into the project name and refuses what compose would not accept', () => {
    expect(integrationProjectName('01J9ZX')).toBe('shipyard-build-01j9zx');
    expect(() => integrationProjectName('a b')).toThrow(RefusalError);
    expect(() => integrationProjectName('')).toThrow(RefusalError);
  });

  it('only resets build when asked', () => {
    expect(renderIntegrationOverride({ service: 's', image: 'i', resetBuild: false, networkName: 'n' })).not.toContain('!reset');
  });
});

describe('verifyBuildNetwork', () => {
  const good = (): BuildNetworkInfo => ({
    name: BUILD_NETWORK_NAME,
    subnets: [BUILD_NETWORK_SUBNET],
    internal: false,
    enableIPv6: false,
    options: { 'com.docker.network.bridge.name': BUILD_NETWORK_BRIDGE },
  });
  const inspector = (info: BuildNetworkInfo | null) => ({ inspectNetwork: (name: string) => Promise.resolve(name === BUILD_NETWORK_NAME ? info : null) });

  it('passes for the network the script creates', async () => {
    await expect(verifyBuildNetwork(inspector(good()))).resolves.toEqual(good());
  });

  it('refuses a missing network, naming the install script as the fix', async () => {
    const err = await verifyBuildNetwork(inspector(null)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).refusal.fix).toContain('docs/install/build-network.sh');
    expect((err as RefusalError).refusal.message).toContain('does not exist');
  });

  it.each([
    [{ subnets: ['172.18.0.0/16'] }, 'subnet'],
    [{ enableIPv6: true }, 'IPv6'],
    [{ subnets: [BUILD_NETWORK_SUBNET, 'fd00::/64'] }, 'IPv6'],
    [{ internal: true }, 'internal'],
    [{ options: {} }, 'bridge'],
  ])('refuses %j', async (patch, expected) => {
    await expect(verifyBuildNetwork(inspector({ ...good(), ...patch }))).rejects.toThrow(expected);
  });

  it('blocks every private, link-local and CGNAT range', () => {
    expect(BUILD_BLOCKED_CIDRS).toEqual(expect.arrayContaining(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10']));
  });

  it('the install script and compose file carry the same constants', async () => {
    const root = join(import.meta.dirname, '../../../../docs/install');
    const script = await readFile(join(root, 'build-network.sh'), 'utf-8');
    for (const value of [BUILD_NETWORK_NAME, BUILD_NETWORK_SUBNET, BUILD_NETWORK_BRIDGE, ...BUILD_BLOCKED_CIDRS]) expect(script).toContain(value);
    const compose = await readFile(join(root, 'buildkit.compose.yml'), 'utf-8');
    expect(compose).toContain(BUILD_NETWORK_NAME);
    expect(compose).not.toMatch(/docker\.sock/);
    expect(compose).not.toMatch(/^\s*ports:/m);
  });
});
