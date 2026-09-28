import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseManifestYaml, refusal, type BuildJob, type BuildProgress, type BuildResult, type Manifest } from '@shipyard/schema';
import {
  RefusalError,
  setBuildSecret,
  type BuildKitPort,
  type FsPort,
  type Log,
  type SolveRequest,
  type withBuildSource,
} from '@shipyard/sequence';
import { AgentRequestError, type AgentClient } from '../src/client.js';
import { BUILD_PROGRESS_PATH, BUILD_RESULT_PATH, buildJournalPath, createBuildWorker, type BuildWorkerOptions } from '../src/build.js';

/**
 * SHP-T-7.9: the agent's build worker, with a fake server client, a fake BuildKit and the real
 * stage runner (`runBuildStages`) from the engine — so the secret mounts and the stage-level
 * redaction are the real ones, and this file checks the worker's own layer on top.
 */

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const BUILD_SECRET = 'ghp_BuildSecretValue_0123456789';
const ENV_SECRET = 'prod-database-password-4242';
const JOB: BuildJob = { buildId: '44444444-4444-4444-8444-444444444444', app: 'web', sha: SHA, requesterLabel: 'test' };

function manifest(extra: Record<string, unknown> = {}): Manifest {
  return parseManifestYaml(
    JSON.stringify({
      name: 'web',
      repo: 'matdemers1/web',
      workflow: 'ci.yml',
      compose: { files: ['/data/web/compose.yml'], project: 'web' },
      services: { web: { image: 'ghcr.io/matdemers1/web' } },
      health: { service: 'web', port: 8080, path: '/health' },
      envFiles: ['/data/web/.env'],
      build: { source: 'shipyard', releaseTargets: { web: 'release' }, secrets: ['npm_token'] },
      ...extra,
    }),
  );
}

interface Call {
  path: string;
  body: unknown;
}

function fakeClient(handler: (call: Call) => unknown = () => ({ cancel: false, accepted: true })): AgentClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    request(_method, path, body) {
      const call = { path, body: structuredClone(body) };
      calls.push(call);
      try {
        return Promise.resolve(handler(call));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

const progressOf = (client: { calls: Call[] }): BuildProgress[] =>
  client.calls.filter((c) => c.path === BUILD_PROGRESS_PATH).map((c) => c.body as BuildProgress);
const resultsOf = (client: { calls: Call[] }): BuildResult[] =>
  client.calls.filter((c) => c.path === BUILD_RESULT_PATH).map((c) => c.body as BuildResult);

function memFs(): FsPort & { files: Map<string, string> } {
  const files = new Map<string, string>([['/data/web/.env', `DATABASE_PASSWORD=${ENV_SECRET}\nDEBUG=true\n`]]);
  return {
    files,
    readFile: (path) => {
      const text = files.get(path);
      return text === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(text);
    },
    writeFileAtomic: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    appendLine: (path, line) => {
      files.set(path, `${files.get(path) ?? ''}${line}\n`);
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(files.has(path)),
    mkdirp: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };
}

/** A BuildKit that prints both secrets in every solve, like a careless `RUN env`. */
function fakeBuildKit(opts: { gate?: Promise<void>; failTarget?: string } = {}): BuildKitPort & { solves: SolveRequest[] } {
  const solves: SolveRequest[] = [];
  return {
    solves,
    async solve(req, onLog) {
      solves.push(req);
      await opts.gate;
      onLog?.(`#1 ${req.target}: NPM_TOKEN=${BUILD_SECRET}\n#2 DATABASE_PASSWORD=${ENV_SECRET}\n`);
      if (req.target === opts.failTarget) return { exitCode: 1 };
      return req.push === undefined ? { exitCode: 0 } : { exitCode: 0, digest: DIGEST };
    },
    prune: () => Promise.resolve(),
    du: () => Promise.resolve({ bytes: 0 }),
  };
}

const quiet: Log = { info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet };

/** A log that keeps every line, children included. */
function recordingLog(): Log & { lines: string[] } {
  const lines: string[] = [];
  const make = (): Log => ({
    info: (obj, msg) => lines.push(JSON.stringify({ obj, msg })),
    warn: (obj, msg) => lines.push(JSON.stringify({ obj, msg })),
    error: (obj, msg) => lines.push(JSON.stringify({ obj, msg })),
    child: () => make(),
  });
  return Object.assign(make(), { lines });
}

const fakeSource =
  (m: Manifest = manifest()): typeof withBuildSource =>
  async (_opts, use) =>
    use('/tmp/source', m);

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'build-worker-test-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

type WorkerOverrides = Partial<Omit<BuildWorkerOptions, 'buildkit' | 'fs'>> & {
  client: AgentClient;
  buildkit?: ReturnType<typeof fakeBuildKit>;
  /** Read secrets from the real encrypted store instead of the fake. */
  realStore?: boolean;
};

function worker(over: WorkerOverrides) {
  const fs = memFs();
  const buildkit = over.buildkit ?? fakeBuildKit();
  const { realStore, ...rest } = over;
  const opts: BuildWorkerOptions = {
    manifests: () => Promise.resolve(new Map([['web', manifest()]])),
    github: { compare: () => Promise.resolve(null) } as unknown as BuildWorkerOptions['github'],
    docker: {} as BuildWorkerOptions['docker'],
    fs,
    dataRoot: '/data',
    tmpDir: tmp,
    readSecrets: () => Promise.resolve(new Map([['npm_token', BUILD_SECRET]])),
    deployInFlight: () => false,
    log: quiet,
    clock: { now: () => new Date('2026-09-28T12:00:00Z') },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    backoff: { initialMs: 1, maxMs: 4 },
    deployWaitMs: 5,
    heartbeatMs: 60_000,
    ...rest,
    buildkit,
    engine: { withBuildSource: fakeSource(), verifyBuildNetwork: () => Promise.resolve({} as never), ...over.engine },
  };
  if (realStore === true) delete opts.readSecrets;
  return { w: createBuildWorker(opts), fs, buildkit };
}

describe('build worker: redacted progress (SHP-REQ-140)', () => {
  it('doneWhen: a build secret and an envFile value never appear in any progress chunk, the result, or the log', async () => {
    const client = fakeClient();
    const log = recordingLog();
    const { w, fs, buildkit } = worker({ client, log });
    expect(w.offer(JOB)).toBe(true);
    await w.idle();

    const progress = progressOf(client);
    expect(progress.map((p) => `${p.stage}:${p.state}`)).toEqual([
      'fetch:running',
      'fetch:succeeded',
      'test:running',
      'test:succeeded',
      'integration:skipped',
      'build:running',
      'build:succeeded',
      'push:succeeded',
    ]);
    const logs = progress.map((p) => p.log ?? '').join('\n');
    expect(logs).toContain('«redacted:npm_token»');
    expect(logs).toContain('«redacted:DATABASE_PASSWORD»');
    const everything = JSON.stringify(client.calls) + log.lines.join('\n');
    expect(everything).not.toContain(BUILD_SECRET);
    expect(everything).not.toContain(ENV_SECRET);

    // The secret reached BuildKit only as a mount (a file path), never a value in the request.
    expect(buildkit.solves[0]?.secrets).toEqual([{ id: 'npm_token', src: expect.stringContaining(tmp) as string }]);
    expect(JSON.stringify(buildkit.solves)).not.toContain(BUILD_SECRET);

    expect(resultsOf(client)).toEqual([{ buildId: JOB.buildId, state: 'succeeded', digests: { web: DIGEST } }]);
    // The agent-local record gate G5 reads, and the journal written before each stage.
    expect(fs.files.get('/data/builds/web.jsonl')).toContain(JOB.buildId);
    const journal = (fs.files.get(buildJournalPath('/data')) ?? '').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(journal.filter((l) => l['phase'] === 'start').map((l) => l['stage'])).toEqual(['fetch', 'test', 'build']);
    expect(journal.at(-1)).toMatchObject({ phase: 'result', state: 'succeeded', buildId: JOB.buildId });
  });

  it('reads build secrets from the encrypted store with the agent key (SHP-REQ-125)', async () => {
    const key = generateKeyPairSync('ed25519').privateKey;
    await setBuildSecret(tmp, key, 'web', 'npm_token', BUILD_SECRET);
    const client = fakeClient();
    const { w, buildkit } = worker({ client, dataRoot: tmp, privateKey: key, realStore: true });
    w.offer(JOB);
    await w.idle();
    expect(resultsOf(client)[0]?.state).toBe('succeeded');
    expect(buildkit.solves).toHaveLength(2);
    expect(JSON.stringify(client.calls)).not.toContain(BUILD_SECRET);
  });

  it('a missing build secret is refused before any solve', async () => {
    const client = fakeClient();
    const { w, buildkit } = worker({ client, readSecrets: () => Promise.resolve(new Map()) });
    w.offer(JOB);
    await w.idle();
    expect(buildkit.solves).toHaveLength(0);
    expect(resultsOf(client)).toEqual([
      expect.objectContaining({ state: 'refused', refusal: expect.objectContaining({ code: 'invalid_request' }) as unknown }),
    ]);
  });
});

describe('build worker: one slot (SHP-REQ-129)', () => {
  it('doneWhen: a second job is not started while one runs', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    const client = fakeClient();
    const { w, buildkit } = worker({ client, buildkit: fakeBuildKit({ gate }) });
    expect(w.offer(JOB)).toBe(true);
    expect(w.busy()).toBe(true);
    expect(w.offer({ ...JOB, buildId: '55555555-5555-4555-8555-555555555555' })).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    open();
    await w.idle();
    expect(w.busy()).toBe(false);
    expect(new Set(progressOf(client).map((p) => p.buildId))).toEqual(new Set([JOB.buildId]));
    expect(resultsOf(client)).toHaveLength(1);
    expect(buildkit.solves).toHaveLength(2);
    // Idle again: the next one is taken.
    expect(w.offer({ ...JOB, buildId: '55555555-5555-4555-8555-555555555555' })).toBe(true);
    await w.idle();
    expect(resultsOf(client)).toHaveLength(2);
  });
});

describe('build worker: deploys first (SHP-REQ-130)', () => {
  it('doneWhen: with a deploy in flight no new stage starts, and it starts once the deploy ends — heartbeating meanwhile', async () => {
    let deploying = true;
    const client = fakeClient();
    const { w, buildkit, fs } = worker({ client, deployInFlight: () => deploying, heartbeatMs: 10 });
    w.offer(JOB);
    await new Promise((r) => setTimeout(r, 80));

    // Fetched, then held: the test stage has not started and BuildKit was never called.
    expect(buildkit.solves).toHaveLength(0);
    expect(progressOf(client).some((p) => p.stage === 'test')).toBe(false);
    expect(w.busy()).toBe(true);
    // Heartbeats kept coming for the last stage, with no log.
    const beats = progressOf(client).filter((p) => p.stage === 'fetch' && p.state === 'running');
    expect(beats.length).toBeGreaterThan(2);
    expect(beats.every((p) => p.log === undefined)).toBe(true);
    expect(fs.files.get(buildJournalPath('/data'))).toContain('"phase":"held"');

    deploying = false;
    await w.idle();
    expect(buildkit.solves).toHaveLength(2);
    expect(resultsOf(client)[0]?.state).toBe('succeeded');
  });

  it('holds between stages too, not only before the first', async () => {
    let checks = 0;
    let deploying = false;
    const client = fakeClient((call) => {
      const body = call.body as BuildProgress;
      // A deploy starts on the host while the test stage runs.
      if (call.path === BUILD_PROGRESS_PATH && body.stage === 'test' && body.state === 'succeeded') deploying = true;
      return { cancel: false, accepted: true };
    });
    const { w, buildkit } = worker({
      client,
      deployInFlight: () => {
        if (deploying) checks += 1;
        if (checks > 3) deploying = false;
        return deploying;
      },
    });
    w.offer(JOB);
    await w.idle();
    expect(checks).toBeGreaterThan(3);
    expect(buildkit.solves.map((s) => s.target)).toEqual(['test', 'release']);
  });
});

describe('build worker: cancel, refusals and delivery', () => {
  it('a cancel in a progress response stops at the next stage boundary and reports cancelled', async () => {
    const client = fakeClient((call) => {
      const body = call.body as BuildProgress;
      return { cancel: call.path === BUILD_PROGRESS_PATH && body.stage === 'test' && body.state === 'succeeded', accepted: true };
    });
    const { w, buildkit } = worker({ client });
    w.offer(JOB);
    await w.idle();
    expect(buildkit.solves.map((s) => s.target)).toEqual(['test']);
    expect(resultsOf(client)).toEqual([{ buildId: JOB.buildId, state: 'cancelled', digests: {} }]);
  });

  it('a refusal from the source (off the default branch) is reported refused, fetch failed', async () => {
    const client = fakeClient();
    const { w, buildkit } = worker({
      client,
      engine: {
        withBuildSource: () => Promise.reject(new RefusalError(refusal('not_on_default_branch', `${SHA.slice(0, 7)} is not on main`))),
      },
    });
    w.offer(JOB);
    await w.idle();
    expect(buildkit.solves).toHaveLength(0);
    expect(progressOf(client).map((p) => `${p.stage}:${p.state}`)).toEqual(['fetch:running', 'fetch:failed']);
    expect(resultsOf(client)).toEqual([
      expect.objectContaining({ state: 'refused', refusal: expect.objectContaining({ code: 'not_on_default_branch' }) as unknown }),
    ]);
  });

  it('a missing build network is refused before any solve', async () => {
    const client = fakeClient();
    const { w, buildkit } = worker({
      client,
      engine: { verifyBuildNetwork: () => Promise.reject(new RefusalError(refusal('step_failed', 'The build network shipyard-build does not exist'))) },
    });
    w.offer(JOB);
    await w.idle();
    expect(buildkit.solves).toHaveLength(0);
    expect(resultsOf(client)[0]).toMatchObject({ state: 'refused', refusal: { code: 'step_failed' } });
  });

  it('a failing test target fails the build at test and pushes nothing', async () => {
    const client = fakeClient();
    const { w, buildkit, fs } = worker({ client, buildkit: fakeBuildKit({ failTarget: 'test' }) });
    w.offer(JOB);
    await w.idle();
    expect(buildkit.solves.map((s) => s.target)).toEqual(['test']);
    expect(resultsOf(client)).toEqual([{ buildId: JOB.buildId, state: 'failed', digests: {}, failedStage: 'test' }]);
    expect(fs.files.has('/data/builds/web.jsonl')).toBe(false);
  });

  it('an unexpected throw is reported failed step_failed, with the message redacted', async () => {
    const client = fakeClient();
    const { w } = worker({
      client,
      engine: {
        runBuildStages: () => Promise.reject(new Error(`boom near ${ENV_SECRET}`)),
      },
    });
    w.offer(JOB);
    await w.idle();
    const [result] = resultsOf(client);
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'step_failed' } });
    expect(JSON.stringify(result)).not.toContain(ENV_SECRET);
  });

  it('retries the result until the server takes it; a 4xx ends the retry', async () => {
    let failures = 2;
    const client = fakeClient((call) => {
      if (call.path === BUILD_RESULT_PATH && failures > 0) {
        failures -= 1;
        throw new TypeError('fetch failed');
      }
      return { cancel: false, accepted: true };
    });
    const { w } = worker({ client });
    w.offer(JOB);
    await w.idle();
    expect(resultsOf(client)).toHaveLength(3);

    const refusing = fakeClient((call) => {
      if (call.path === BUILD_RESULT_PATH) throw new AgentRequestError(404, null, 'POST', call.path);
      return { cancel: false };
    });
    const second = worker({ client: refusing });
    second.w.offer(JOB);
    await second.w.idle();
    expect(resultsOf(refusing)).toHaveLength(1);
  });

  it('progress the server refuses (404: not ours any more) stops the build', async () => {
    const client = fakeClient((call) => {
      if (call.path === BUILD_PROGRESS_PATH && (call.body as BuildProgress).stage === 'test') {
        throw new AgentRequestError(404, null, 'POST', call.path);
      }
      return { cancel: false, accepted: true };
    });
    const { w, buildkit } = worker({ client });
    w.offer(JOB);
    await w.idle();
    expect(buildkit.solves.map((s) => s.target)).toEqual(['test']);
    expect(resultsOf(client)[0]?.state).toBe('cancelled');
  });
});
