import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manifest } from '@shipyard/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBuildKitAdapter } from '../../src/adapters/buildkit.js';
import type { ExecFileFn } from '../../src/adapters/docker.js';
import { runBuildStages } from '../../src/build/stages.js';
import type { StageProgress } from '../../src/build/stages.js';
import { RefusalError } from '../../src/ports.js';
import type { BuildKitPort, Log, SolveRequest, SolveResult } from '../../src/ports.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const SECRET = 'npm_s3cr3t_value_do_not_leak';
const digestFor = (c: string): string => `sha256:${c.repeat(64)}`;

function manifest(build: Record<string, unknown> = {}): Manifest {
  return Manifest.parse({
    name: 'toy',
    repo: 'matdemers1/toy',
    workflow: 'ci.yml',
    compose: { files: ['/data/toy/compose.yml'], project: 'toy' },
    services: { web: { image: 'ghcr.io/matdemers1/toy/web' }, api: { image: 'ghcr.io/matdemers1/toy/api' } },
    health: { service: 'api', port: 3000, path: '/health' },
    build: {
      source: 'shipyard',
      testTarget: 'test',
      releaseTargets: { api: 'api-release', web: 'web-release' },
      secrets: ['npm_token'],
      ...build,
    },
  });
}

interface SolveCall {
  req: SolveRequest;
  /** The secret file's content at solve time, read by the fake as BuildKit would. */
  secretContents: string[];
}

/** A fake BuildKitPort that records calls and echoes the secret into its build log. */
function fakeBuildKit(opts: { testExit?: number; buildExit?: number; noDigestFor?: string } = {}): { calls: SolveCall[]; port: BuildKitPort } {
  const calls: SolveCall[] = [];
  const port: BuildKitPort = {
    async solve(req, onLog): Promise<SolveResult> {
      const secretContents = await Promise.all(req.secrets.map((s) => readFile(s.src, 'utf-8')));
      calls.push({ req: structuredClone(req), secretContents });
      onLog?.(`#3 RUN echo ${secretContents.join(',')}\n`);
      if (req.push === undefined) return { exitCode: opts.testExit ?? 0 };
      if ((opts.buildExit ?? 0) !== 0) return { exitCode: opts.buildExit ?? 1 };
      if (opts.noDigestFor !== undefined && req.target.startsWith(opts.noDigestFor)) return { exitCode: 0 };
      return { exitCode: 0, digest: digestFor(req.target.startsWith('api') ? 'a' : 'b') };
    },
    prune: () => Promise.resolve(),
    du: () => Promise.resolve({ bytes: 0 }),
  };
  return { calls, port };
}

function recordingLog(lines: string[]): Log {
  const log: Log = {
    info: (obj, msg) => lines.push(JSON.stringify(obj) + (msg ?? '')),
    warn: (obj, msg) => lines.push(JSON.stringify(obj) + (msg ?? '')),
    error: (obj, msg) => lines.push(JSON.stringify(obj) + (msg ?? '')),
    child: () => log,
  };
  return log;
}

let tmp: string;
let dir: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'stages-test-'));
  dir = join(tmp, 'src');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function base(port: BuildKitPort, progress: StageProgress[], extra: Partial<Parameters<typeof runBuildStages>[0]> = {}): Parameters<typeof runBuildStages>[0] {
  return {
    dir,
    manifest: manifest(),
    sha: SHA,
    buildkit: port,
    secrets: new Map([['npm_token', SECRET]]),
    tmpDir: tmp,
    onProgress: (p) => {
      progress.push(p);
    },
    ...extra,
  };
}

describe('runBuildStages', () => {
  it('builds the test target first without push, then every release target pushed as sha-<40hex> with both labels', async () => {
    const { calls, port } = fakeBuildKit();
    const progress: StageProgress[] = [];
    const result = await runBuildStages(base(port, progress));

    expect(result).toEqual({ state: 'succeeded', digests: { api: digestFor('a'), web: digestFor('b') } });
    expect(calls.map((c) => c.req.target)).toEqual(['test', 'api-release', 'web-release']);
    expect(calls[0]?.req.push).toBeUndefined();
    expect(calls[0]?.req.dockerfile).toBe(join(dir, 'Dockerfile'));
    expect(calls[1]?.req.push).toEqual({ ref: `ghcr.io/matdemers1/toy/api:sha-${SHA}` });
    expect(calls[2]?.req.push).toEqual({ ref: `ghcr.io/matdemers1/toy/web:sha-${SHA}` });
    for (const c of calls.slice(1)) {
      expect(c.req.labels).toEqual({
        'org.opencontainers.image.revision': SHA,
        'org.opencontainers.image.source': 'https://github.com/matdemers1/toy',
      });
    }
    expect(progress.map((p) => `${p.stage}:${p.state}`)).toEqual([
      'test:running',
      'test:succeeded',
      'integration:skipped',
      'build:running',
      'build:succeeded',
      'push:succeeded',
    ]);
  });

  it('SHP-REQ-120: a failing test target fails the build with zero push solves', async () => {
    const { calls, port } = fakeBuildKit({ testExit: 1 });
    const progress: StageProgress[] = [];
    const result = await runBuildStages(base(port, progress));
    expect(result).toEqual({ state: 'failed', digests: {}, failedStage: 'test' });
    expect(calls.filter((c) => c.req.push !== undefined)).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(progress.at(-1)).toMatchObject({ stage: 'test', state: 'failed' });
  });

  it('SHP-REQ-126: the secret value is only in the file — never in a request, progress log or Log line — and the file is removed', async () => {
    const { calls, port } = fakeBuildKit();
    const progress: StageProgress[] = [];
    const logLines: string[] = [];
    await runBuildStages(base(port, progress, { log: recordingLog(logLines) }));

    for (const c of calls) {
      expect(JSON.stringify(c.req)).not.toContain(SECRET);
      expect(c.req.secrets).toHaveLength(1);
      expect(c.req.secrets[0]?.id).toBe('npm_token');
      expect(c.secretContents).toEqual([SECRET]);
    }
    expect(JSON.stringify(progress)).not.toContain(SECRET);
    expect(JSON.stringify(progress)).toContain('«redacted:npm_token»');
    expect(logLines.join('\n')).not.toContain(SECRET);
    expect(logLines.length).toBeGreaterThan(0);

    const src = calls[0]?.req.secrets[0]?.src ?? '';
    await expect(stat(src)).rejects.toThrow();
    expect((await readdir(tmp)).filter((n) => n.startsWith('shipyard-build-secrets-'))).toEqual([]);
  });

  it('writes the secret file 0600 inside a 0700 directory', async () => {
    const modes: number[] = [];
    const { port } = fakeBuildKit();
    const wrapped: BuildKitPort = {
      ...port,
      async solve(req, onLog) {
        const s = req.secrets[0];
        if (s !== undefined) {
          modes.push((await stat(s.src)).mode & 0o777, (await stat(join(s.src, '..'))).mode & 0o777);
        }
        return port.solve(req, onLog);
      },
    };
    await runBuildStages(base(wrapped, []));
    expect(modes.slice(0, 2)).toEqual([0o600, 0o700]);
  });

  it('removes the secret files even when a solve throws', async () => {
    const seen: string[] = [];
    const port: BuildKitPort = {
      solve(req) {
        seen.push(req.secrets[0]?.src ?? '');
        return Promise.reject(new Error('daemon gone'));
      },
      prune: () => Promise.resolve(),
      du: () => Promise.resolve({ bytes: 0 }),
    };
    await expect(runBuildStages(base(port, []))).rejects.toThrow('daemon gone');
    await expect(stat(seen[0] ?? '/nope')).rejects.toThrow();
  });

  it('refuses a secret missing from the store before any solve, naming it and no value', async () => {
    const { calls, port } = fakeBuildKit();
    const err = await runBuildStages(base(port, [], { secrets: new Map([['other', SECRET]]) })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).refusal.code).toBe('invalid_request');
    expect((err as RefusalError).refusal.message).toContain('npm_token');
    expect((err as RefusalError).refusal.message).not.toContain(SECRET);
    expect(calls).toHaveLength(0);
  });

  it('refuses a manifest not built by Shipyard, and a service with no release target', async () => {
    const { calls, port } = fakeBuildKit();
    const github = Manifest.parse({ ...manifest(), build: { source: 'github' } });
    await expect(runBuildStages(base(port, [], { manifest: github }))).rejects.toBeInstanceOf(RefusalError);
    // The schema already rejects this; the runner re-checks rather than trusting its caller.
    const partial = manifest();
    const unchecked: Manifest = { ...partial, build: { source: 'shipyard', releaseTargets: { api: 'api-release' } } };
    await expect(runBuildStages(base(port, [], { manifest: unchecked }))).rejects.toBeInstanceOf(RefusalError);
    await expect(runBuildStages(base(port, [], { sha: 'abc' }))).rejects.toBeInstanceOf(RefusalError);
    expect(calls).toHaveLength(0);
  });

  it('stops at a stage boundary when cancelled', async () => {
    const { calls, port } = fakeBuildKit();
    let checks = 0;
    // First check (before test) passes; second (before integration) cancels.
    const result = await runBuildStages(base(port, [], { shouldCancel: () => ++checks >= 2 }));
    expect(result).toEqual({ state: 'cancelled', digests: {} });
    expect(calls.map((c) => c.req.target)).toEqual(['test']);

    const before = fakeBuildKit();
    expect(await runBuildStages(base(before.port, [], { shouldCancel: () => Promise.resolve(true) }))).toEqual({ state: 'cancelled', digests: {} });
    expect(before.calls).toHaveLength(0);
  });

  it('SHP-REQ-143: a cancel during the integration hook itself yields cancelled, not failed at integration, with no push', async () => {
    const { calls, port } = fakeBuildKit();
    const progress: StageProgress[] = [];
    let cancelledFlag = false;
    const result = await runBuildStages(
      base(port, progress, {
        shouldCancel: () => cancelledFlag,
        integration: () => {
          // The hook itself observed the cancel and tore down mid-run, resolving false.
          cancelledFlag = true;
          return Promise.resolve(false);
        },
      }),
    );
    expect(result).toEqual({ state: 'cancelled', digests: {} });
    expect(calls.map((c) => c.req.target)).toEqual(['test']);
    expect(calls.filter((c) => c.req.push !== undefined)).toHaveLength(0);
    expect(progress.map((p) => `${p.stage}:${p.state}`)).toEqual(['test:running', 'test:succeeded', 'integration:running']);
  });

  it('an integration hook returning false without a cancel still fails at integration', async () => {
    const { calls, port } = fakeBuildKit();
    const progress: StageProgress[] = [];
    const result = await runBuildStages(base(port, progress, { integration: () => Promise.resolve(false) }));
    expect(result).toEqual({ state: 'failed', digests: {}, failedStage: 'integration' });
    expect(calls.filter((c) => c.req.push !== undefined)).toHaveLength(0);
    expect(progress.at(-1)).toMatchObject({ stage: 'integration', state: 'failed' });
  });

  it('fails at push when a release target returns no digest, and at build on a non-zero exit', async () => {
    const noDigest = fakeBuildKit({ noDigestFor: 'web' });
    const progress: StageProgress[] = [];
    expect(await runBuildStages(base(noDigest.port, progress))).toEqual({ state: 'failed', digests: {}, failedStage: 'push' });
    expect(progress.at(-1)).toMatchObject({ stage: 'push', state: 'failed' });

    const broken = fakeBuildKit({ buildExit: 2 });
    expect(await runBuildStages(base(broken.port, []))).toEqual({ state: 'failed', digests: {}, failedStage: 'build' });
  });

  it('runs the integration hook between test and build, and fails the build without push when it fails', async () => {
    const { calls, port } = fakeBuildKit();
    const order: string[] = [];
    const result = await runBuildStages(
      base(port, [], {
        integration: ({ onLog }) => {
          order.push(`integration after ${calls.length} solves`);
          onLog(`leaked ${SECRET}\n`);
          return Promise.resolve(false);
        },
      }),
    );
    expect(result).toEqual({ state: 'failed', digests: {}, failedStage: 'integration' });
    expect(order).toEqual(['integration after 1 solves']);
    expect(calls.filter((c) => c.req.push !== undefined)).toHaveLength(0);
  });
});

describe('runBuildStages over the real adapter, on recorded buildctl argv', () => {
  interface Call {
    args: string[];
    env: NodeJS.ProcessEnv;
  }
  function recorder(testExit: number): { calls: Call[]; execFile: ExecFileFn } {
    const calls: Call[] = [];
    const execFile: ExecFileFn = async (_file, args, opts) => {
      calls.push({ args: [...args], env: { ...opts.env } });
      const push = args.some((a) => a.endsWith('push=true'));
      if (push) {
        const meta = args[args.indexOf('--metadata-file') + 1] ?? '';
        await writeFile(meta, JSON.stringify({ 'containerimage.digest': digestFor(args.some((a) => a.includes('/api:')) ? 'a' : 'b') }));
        return { exitCode: 0, stdout: `pushing with ${SECRET}\n`, stderr: '' };
      }
      return { exitCode: testExit, stdout: `test echo ${SECRET}\n`, stderr: '' };
    };
    return { calls, execFile };
  }

  it('test target first, release pushes after, SHA in tag and labels, secret only as --secret', async () => {
    const { calls, execFile } = recorder(0);
    const buildkit = createBuildKitAdapter({ addr: 'tcp://buildkitd:1234', execFile, tmpDir: tmp });
    const progress: StageProgress[] = [];
    const result = await runBuildStages(base(buildkit, progress));
    expect(result.state).toBe('succeeded');
    expect(result.digests).toEqual({ api: digestFor('a'), web: digestFor('b') });

    const targets = calls.map((c) => c.args.find((a) => a.startsWith('target=')));
    expect(targets).toEqual(['target=test', 'target=api-release', 'target=web-release']);
    expect(calls[0]?.args).not.toContain('--output');
    for (const c of calls.slice(1)) {
      expect(c.args).toContain(`label:org.opencontainers.image.revision=${SHA}`);
      expect(c.args).toContain('label:org.opencontainers.image.source=https://github.com/matdemers1/toy');
      expect(c.args.find((a) => a.startsWith('type=image'))).toMatch(new RegExp(`:sha-${SHA},push=true$`));
    }
    for (const c of calls) {
      expect(c.args.join('\0')).not.toContain(SECRET);
      expect(JSON.stringify(c.env)).not.toContain(SECRET);
      expect(c.args.filter((a) => a.startsWith('id=npm_token,src='))).toHaveLength(1);
      expect(c.args.join(' ')).not.toContain('docker.sock');
    }
    expect(JSON.stringify(progress)).not.toContain(SECRET);
  });

  it('a failing test target produces zero push invocations', async () => {
    const { calls, execFile } = recorder(1);
    const buildkit = createBuildKitAdapter({ addr: 'tcp://buildkitd:1234', execFile, tmpDir: tmp });
    const result = await runBuildStages(base(buildkit, []));
    expect(result).toEqual({ state: 'failed', digests: {}, failedStage: 'test' });
    expect(calls).toHaveLength(1);
    expect(calls.filter((c) => c.args.some((a) => a.includes('push=true')))).toHaveLength(0);
  });
});
