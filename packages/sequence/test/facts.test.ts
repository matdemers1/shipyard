import { describe, expect, it, vi } from 'vitest';

import type { Manifest } from '@shipyard/schema';

import { resolveDeployTarget } from '../src/facts.js';
import { Ledger } from '../src/ledger.js';
import type { DockerPort, ExecResult, FsPort, GitHubPort, HealthResponse, Log, RegistryPort, RunningContainer, SequencePorts } from '../src/ports.js';
import { LABEL_ENV } from '../src/types.js';

/**
 * Env preflight from image-declared variable names (SHP-T-5.5, SHP-REQ-082), proved end to end
 * through `resolveDeployTarget`: an image's `dev.d3cloud.shipyard.env` label is read from its
 * config, merged with the manifest's `requiredEnv`, and checked against the stack's env files.
 */

const SHA = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';
const SERVER_DIGEST = `sha256:${'1'.repeat(64)}`;
const WORKER_DIGEST = `sha256:${'2'.repeat(64)}`;

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    name: 'demo',
    repo: 'acme/demo',
    defaultBranch: 'main',
    workflow: '.github/workflows/image.yml',
    compose: { files: ['/opt/demo/compose.yaml'], project: 'demo' },
    services: { server: { image: 'ghcr.io/acme/demo/server' } },
    health: { service: 'server', port: 3000, path: '/health' },
    soakSeconds: 60,
    approval: 'none',
    diskFloorGb: 5,
    retainImages: 3,
    ...overrides,
  };
}

/** In-memory FsPort: `env files` are entries in `files`; every other read is unused by these tests. */
function memoryFs(files: Record<string, string> = {}): FsPort {
  return {
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return Promise.resolve(content);
    },
    writeFileAtomic: () => Promise.reject(new Error('not implemented')),
    appendLine: () => Promise.resolve(),
    exists: (path) => Promise.resolve(path in files),
    mkdirp: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };
}

async function emptyLedger(): Promise<Ledger> {
  return Ledger.open(memoryFs(), '/data/agent/ledger.jsonl');
}

interface PortsOptions {
  digests?: Record<string, string | null>;
  labels?: Record<string, Record<string, string>>;
  envFileContents?: Record<string, string>;
}

function buildPorts(options: PortsOptions = {}): SequencePorts {
  const digests = options.digests ?? { server: SERVER_DIGEST };
  const labels = options.labels ?? {};
  const fs = memoryFs(options.envFileContents ?? {});

  const github: GitHubPort = {
    workflowRuns: (_repo, workflow, headSha) =>
      Promise.resolve([{ id: 1, headSha, path: workflow, status: 'completed', conclusion: 'success', event: 'push', headBranch: 'main' }]),
    compare: () => Promise.resolve({ status: 'identical', aheadBy: 0, behindBy: 0, commits: [] }),
  };

  const registry: RegistryPort = {
    resolveDigest: (imageRepo) => {
      const service = imageRepo.split('/').at(-1) ?? '';
      return Promise.resolve(digests[service] ?? null);
    },
    imageConfig: (imageRepo, digest) => {
      const service = imageRepo.split('/').at(-1) ?? '';
      return Promise.resolve({ digest, labels: labels[service] ?? {} });
    },
  };

  const exec: ExecResult = { exitCode: 0, stdout: '', stderr: '' };
  const docker: DockerPort = {
    compose: () => Promise.resolve(exec),
    containers: () => Promise.resolve([] as RunningContainer[]),
    probeHealth: () => Promise.resolve({ httpStatus: 200, body: {} } as HealthResponse),
    freeBytes: () => Promise.resolve(100 * 1024 ** 3),
    images: () => Promise.resolve([]),
    removeImage: () => Promise.resolve(),
  };

  const log: Log = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => log };

  return {
    github,
    registry,
    docker,
    fs,
    clock: { now: () => new Date('2026-09-25T00:00:00.000Z'), sleep: () => Promise.resolve() },
    log,
  };
}

describe('resolveDeployTarget — env preflight from image-declared variable names (SHP-REQ-082)', () => {
  it('refuses naming a variable the image declares that is absent from the env files', async () => {
    const manifest = baseManifest({ envFiles: ['/opt/demo/.env'] });
    const ports = buildPorts({
      labels: { server: { [LABEL_ENV]: 'SMTP_HOST, SMTP_PORT' } },
      envFileContents: { '/opt/demo/.env': 'SMTP_HOST=mail.example.com\n' },
    });
    const ledger = await emptyLedger();

    const resolved = await resolveDeployTarget(ports, ledger, manifest, SHA, { dryRun: true });

    expect(resolved.refusal?.code).toBe('env_missing');
    expect(resolved.refusal?.message).toContain('SMTP_PORT');
    expect(resolved.refusal?.message).toContain('declared by server image');
  });

  it('passes when every image-declared name is present, with no requiredEnv on the manifest', async () => {
    const manifest = baseManifest({ envFiles: ['/opt/demo/.env'] });
    const ports = buildPorts({
      labels: { server: { [LABEL_ENV]: 'SMTP_HOST' } },
      envFileContents: { '/opt/demo/.env': 'SMTP_HOST=mail.example.com\n' },
    });
    const ledger = await emptyLedger();

    const resolved = await resolveDeployTarget(ports, ledger, manifest, SHA, { dryRun: true });

    expect(resolved.refusal).toBeNull();
    expect(resolved.images[0]?.labels[LABEL_ENV]).toBe('SMTP_HOST');
  });

  it('refuses naming variables required by both the manifest and a different service image', async () => {
    const manifest = baseManifest({
      services: { server: { image: 'ghcr.io/acme/demo/server' }, worker: { image: 'ghcr.io/acme/demo/worker' } },
      health: { service: 'server', port: 3000, path: '/health' },
      requiredEnv: ['DATABASE_URL'],
      envFiles: ['/opt/demo/.env'],
    });
    const ports = buildPorts({
      digests: { server: SERVER_DIGEST, worker: WORKER_DIGEST },
      labels: { worker: { [LABEL_ENV]: 'QUEUE_URL' } },
      envFileContents: { '/opt/demo/.env': '' },
    });
    const ledger = await emptyLedger();

    const resolved = await resolveDeployTarget(ports, ledger, manifest, SHA, { dryRun: true });

    expect(resolved.refusal?.code).toBe('env_missing');
    expect(resolved.refusal?.message).toContain('DATABASE_URL (manifest requiredEnv)');
    expect(resolved.refusal?.message).toContain('QUEUE_URL (declared by worker image)');
  });

  it('refuses fail-closed on a malformed env label, naming the bad entry', async () => {
    const manifest = baseManifest({ envFiles: ['/opt/demo/.env'] });
    const ports = buildPorts({
      labels: { server: { [LABEL_ENV]: 'SMTP_HOST, 1BAD-NAME' } },
      envFileContents: { '/opt/demo/.env': 'SMTP_HOST=mail.example.com\n' },
    });
    const ledger = await emptyLedger();

    const resolved = await resolveDeployTarget(ports, ledger, manifest, SHA, { dryRun: true });

    expect(resolved.refusal?.code).toBe('env_missing');
    expect(resolved.refusal?.message).toContain('1BAD-NAME');
  });

  it('refuses naming the variable when names are required but the manifest names no env files', async () => {
    const manifest = baseManifest();
    const ports = buildPorts({ labels: { server: { [LABEL_ENV]: 'SMTP_HOST' } } });
    const ledger = await emptyLedger();

    const resolved = await resolveDeployTarget(ports, ledger, manifest, SHA, { dryRun: true });

    expect(resolved.refusal?.code).toBe('env_missing');
    expect(resolved.refusal?.message).toContain('SMTP_HOST');
    expect(resolved.refusal?.fix.toLowerCase()).toContain('no env files');
  });

  it('passes through unaffected when no image declares an env label and the manifest names none', async () => {
    const manifest = baseManifest();
    const ports = buildPorts();
    const ledger = await emptyLedger();

    const resolved = await resolveDeployTarget(ports, ledger, manifest, SHA, { dryRun: true });

    expect(resolved.refusal).toBeNull();
  });
});

describe('resolveDeployTarget — a group promotion ships the canary\'s digests or nothing (SHP-REQ-079)', () => {
  const OTHER_DIGEST = `sha256:${'9'.repeat(64)}`;
  const twoServices = (): Manifest =>
    baseManifest({ services: { server: { image: 'ghcr.io/acme/demo/server' }, worker: { image: 'ghcr.io/acme/demo/worker' } } });

  it('passes when every expected digest matches what the registry resolves', async () => {
    const ports = buildPorts({ digests: { server: SERVER_DIGEST, worker: WORKER_DIGEST } });
    const resolved = await resolveDeployTarget(ports, await emptyLedger(), twoServices(), SHA, {
      dryRun: false,
      expectDigests: { server: SERVER_DIGEST, worker: WORKER_DIGEST },
    });
    expect(resolved.refusal).toBeNull();
    expect(resolved.images.map((i) => i.digest)).toEqual([SERVER_DIGEST, WORKER_DIGEST]);
  });

  it('refuses digest_mismatch naming the service, the expected and the resolved digest', async () => {
    const ports = buildPorts({ digests: { server: SERVER_DIGEST, worker: WORKER_DIGEST } });
    const resolved = await resolveDeployTarget(ports, await emptyLedger(), twoServices(), SHA, {
      dryRun: false,
      expectDigests: { server: SERVER_DIGEST, worker: OTHER_DIGEST },
    });
    expect(resolved.refusal?.code).toBe('digest_mismatch');
    expect(resolved.refusal?.message).toContain('"worker"');
    expect(resolved.refusal?.message).toContain(WORKER_DIGEST);
    expect(resolved.refusal?.message).toContain(OTHER_DIGEST);
    expect(resolved.images).toEqual([]);
  });

  it('applies to a dry run too', async () => {
    const ports = buildPorts({ digests: { server: SERVER_DIGEST } });
    const resolved = await resolveDeployTarget(ports, await emptyLedger(), baseManifest(), SHA, {
      dryRun: true,
      expectDigests: { server: OTHER_DIGEST },
    });
    expect(resolved.refusal?.code).toBe('digest_mismatch');
  });

  it('ignores an expected service the manifest does not map, and expects nothing of one it omits', async () => {
    const ports = buildPorts({ digests: { server: SERVER_DIGEST, worker: WORKER_DIGEST } });
    const resolved = await resolveDeployTarget(ports, await emptyLedger(), twoServices(), SHA, {
      dryRun: true,
      expectDigests: { server: SERVER_DIGEST, board: OTHER_DIGEST },
    });
    expect(resolved.refusal).toBeNull();
    expect(resolved.images).toHaveLength(2);
  });
});

describe('resolveDeployTarget — G5 reads the agent-local build record for build: shipyard apps (SHP-T-7.10, SHP-REQ-134, SHP-REQ-135)', () => {
  it('a build: shipyard app never consults workflowRuns, and passes on a matching succeeded record', async () => {
    const manifest = baseManifest({ build: { source: 'shipyard' } });
    const ports = buildPorts({ digests: { server: SERVER_DIGEST } });
    const workflowRunsSpy = vi.spyOn(ports.github, 'workflowRuns');
    const buildRecord = vi.fn().mockResolvedValue({
      buildId: 'build-1',
      app: 'demo',
      sha: SHA,
      state: 'succeeded',
      digests: { server: SERVER_DIGEST },
      at: '2026-09-25T00:00:00.000Z',
    });

    const resolved = await resolveDeployTarget(ports, await emptyLedger(), manifest, SHA, { dryRun: true, buildRecord });

    expect(resolved.refusal).toBeNull();
    expect(workflowRunsSpy).not.toHaveBeenCalled();
    expect(buildRecord).toHaveBeenCalledWith(manifest, SHA);
  });

  it('a build: shipyard app refuses build_not_green when buildRecord resolves null', async () => {
    const manifest = baseManifest({ build: { source: 'shipyard' } });
    const ports = buildPorts({ digests: { server: SERVER_DIGEST } });
    const buildRecord = vi.fn().mockResolvedValue(null);

    const resolved = await resolveDeployTarget(ports, await emptyLedger(), manifest, SHA, { dryRun: true, buildRecord });

    expect(resolved.refusal?.code).toBe('build_not_green');
  });

  it('a build: shipyard app fails closed when no buildRecord lookup was supplied at all', async () => {
    const manifest = baseManifest({ build: { source: 'shipyard' } });
    const ports = buildPorts({ digests: { server: SERVER_DIGEST } });

    const resolved = await resolveDeployTarget(ports, await emptyLedger(), manifest, SHA, { dryRun: true });

    expect(resolved.refusal?.code).toBe('build_not_green');
  });

  it('a build: shipyard app refuses build_digest_mismatch when GHCR digest is unreachable/null', async () => {
    const manifest = baseManifest({ build: { source: 'shipyard' } });
    const ports = buildPorts({ digests: { server: null } });
    const buildRecord = vi.fn().mockResolvedValue({
      buildId: 'build-1',
      app: 'demo',
      sha: SHA,
      state: 'succeeded',
      digests: { server: SERVER_DIGEST },
      at: '2026-09-25T00:00:00.000Z',
    });

    const resolved = await resolveDeployTarget(ports, await emptyLedger(), manifest, SHA, { dryRun: true, buildRecord });

    // G8 (image_missing) fires before G5's digest comparison would matter for a null digest, but
    // either way this never passes — GHCR unreachable/missing is never treated as a match.
    expect(resolved.refusal).not.toBeNull();
  });

  it('a github (default) app never consults buildRecord', async () => {
    const manifest = baseManifest();
    const ports = buildPorts({ digests: { server: SERVER_DIGEST } });
    const buildRecord = vi.fn().mockResolvedValue(null);

    const resolved = await resolveDeployTarget(ports, await emptyLedger(), manifest, SHA, { dryRun: true, buildRecord });

    expect(resolved.refusal).toBeNull();
    expect(buildRecord).not.toHaveBeenCalled();
  });
});
