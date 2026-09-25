import { describe, expect, it } from 'vitest';
import { refusal, type TargetResult } from '@shipyard/schema';
import { Journal, type Clock, type DeployResult, type FsPort, type Log, type MachineContext } from '@shipyard/sequence';
import { AgentRequestError, type AgentClient } from '../src/client.js';
import { AgentConfigError, loadAgentConfig } from '../src/config.js';
import {
  POLL_PATH,
  PROGRESS_PATH,
  RESULT_PATH,
  STEPS_PATH,
  createTargetRunner,
  fileTargetStore,
  memoryTargetStore,
  reportLeftovers,
  runLoop,
  toTargetResult,
  type Engine,
  type PollTarget,
  type Sleep,
} from '../src/loop.js';

const SHA = 'd'.repeat(40);
const DIGEST = `sha256:${'e'.repeat(64)}`;

interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (call: Call, index: number) => unknown;

function fakeClient(handler: Handler): AgentClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    request(method, path, body) {
      const call = { method, path, body };
      calls.push(call);
      try {
        return Promise.resolve(handler(call, calls.length - 1));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const quietLog: Log = { ...quiet, child: () => quietLog };

function memFs(): FsPort & { files: Map<string, string> } {
  const files = new Map<string, string>();
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

const clock: Clock = { now: () => new Date('2026-09-24T12:00:00Z'), sleep: () => Promise.resolve() };

function target(extra: Partial<PollTarget> = {}): PollTarget {
  return {
    targetId: '11111111-1111-4111-8111-111111111111',
    deployId: '22222222-2222-4222-8222-222222222222',
    kind: 'deploy',
    app: 'web',
    sha: SHA,
    dryRun: false,
    requesterLabel: 'matthew (console)',
    ...extra,
  };
}

function deployResult(extra: Partial<DeployResult> = {}): DeployResult {
  return {
    deployId: target().deployId,
    app: 'web',
    state: 'succeeded',
    sha: SHA,
    images: [{ service: 'web', repo: 'ghcr.io/matdemers1/web', sha: SHA, digest: DIGEST, reference: '', labels: {}, migration: null }],
    schemaRevision: '20260924_init',
    gates: [{ gate: 'G5', pass: true, reason: 'ci green' }],
    refusal: null,
    steps: [],
    backupArtifact: null,
    ...extra,
  };
}

/** An engine that journals and reports progress like the real machine: verify, backup, swap. */
function fakeEngine(onStep?: (step: string) => void): Engine & { ran: string[]; requests: unknown[] } {
  const ran: string[] = [];
  const requests: unknown[] = [];
  const deploy = async (ctx: MachineContext, request: { deployId: string; app: string }): Promise<DeployResult> => {
    requests.push(request);
    const { deployId, app } = request;
    await ctx.journal.begin({ deployId, app, step: 'deploy', detail: { composeFiles: ['/srv/web/compose.yml'], project: 'web' } });
    for (const [state, step, argv] of [
      ['verifying', 'verify', undefined],
      ['backing_up', 'backup', ['pg_dump', '-Fc']],
      ['swapping', 'swap', ['up', '-d', 'web']],
    ] as const) {
      ctx.onProgress?.({ deployId, state, step });
      await ctx.journal.begin({ deployId, app, step, ...(argv === undefined ? {} : { argv: [...argv] }) });
      onStep?.(step);
      ran.push(step);
      await ctx.journal.end({
        deployId,
        app,
        step,
        exitCode: 0,
        ...(step === 'backup' ? { detail: { artifact: '/data/backups/web/1.dump', size: 4096 } } : {}),
        ...(step === 'swap' ? { output: 'Container web-1 Started' } : {}),
      });
      // Let the sync chain run, as real steps take time.
      await new Promise((r) => setTimeout(r, 1));
    }
    ctx.onProgress?.({ deployId, state: 'succeeded' });
    await ctx.journal.end({ deployId, app, step: 'deploy', detail: { state: 'succeeded' } });
    return deployResult({ backupArtifact: '/data/backups/web/1.dump' });
  };
  return {
    ran,
    requests,
    deploy,
    rollback: (ctx, request) => deploy(ctx, request),
  };
}

function runnerContext(fs: FsPort) {
  const journal = new Journal(fs, '/data/agent/journal.jsonl', clock, quietLog);
  return {
    journal,
    context: () =>
      Promise.resolve({
        dataRoot: '/data',
        manifests: new Map(),
        journal,
        ledger: {} as MachineContext['ledger'],
        workDir: '/data/agent/work',
        historyDir: '/data/agent/history',
      }),
  };
}

const noSleep: Sleep = () => Promise.resolve();

describe('runLoop', () => {
  it('polls again at once after an empty poll', async () => {
    const stop = new AbortController();
    const ran: PollTarget[] = [];
    const client = fakeClient((_call, i) => {
      if (i === 2) stop.abort();
      return { target: null };
    });
    await runLoop({ client, runTarget: (t) => (ran.push(t), Promise.resolve()), log: quiet, signal: stop.signal, sleep: noSleep });
    expect(client.calls).toHaveLength(3);
    expect(client.calls.every((c) => c.method === 'POST' && c.path === POLL_PATH)).toBe(true);
    expect(client.calls[0]?.body).toEqual({ waitSeconds: 25 });
    expect(ran).toEqual([]);
  });

  it('runs a target it is given, then polls again', async () => {
    const stop = new AbortController();
    const ran: string[] = [];
    const client = fakeClient((_call, i) => {
      if (i === 0) return { target: target() };
      stop.abort();
      return { target: null };
    });
    await runLoop({ client, runTarget: (t) => (ran.push(t.targetId), Promise.resolve()), log: quiet, signal: stop.signal, sleep: noSleep });
    expect(ran).toEqual([target().targetId]);
    expect(client.calls).toHaveLength(2);
  });

  it('backs off 1 s doubling to a 30 s cap on errors, and resets after a good poll', async () => {
    const stop = new AbortController();
    const delays: number[] = [];
    const client = fakeClient((_call, i) => {
      if (i === 8) return { target: null };
      if (i === 11) stop.abort();
      throw new TypeError('fetch failed');
    });
    const sleep: Sleep = (ms) => {
      delays.push(ms);
      return Promise.resolve();
    };
    await runLoop({ client, runTarget: () => Promise.resolve(), log: quiet, signal: stop.signal, sleep });
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 1_000, 2_000]);
  });

  it('treats a malformed poll response as an error', async () => {
    const stop = new AbortController();
    const delays: number[] = [];
    const client = fakeClient((_call, i) => {
      if (i === 1) stop.abort();
      return { target: { nope: true } };
    });
    await runLoop({ client, runTarget: () => Promise.resolve(), log: quiet, signal: stop.signal, sleep: (ms) => (delays.push(ms), Promise.resolve()) });
    expect(delays).toEqual([1_000]);
  });

  it('SIGTERM finishes the current target, then exits without polling again', async () => {
    const stop = new AbortController();
    let finished = false;
    const client = fakeClient(() => ({ target: target() }));
    await runLoop({
      client,
      runTarget: async () => {
        stop.abort(); // SIGTERM arrives mid-target
        await new Promise((r) => setTimeout(r, 20));
        finished = true;
      },
      log: quiet,
      signal: stop.signal,
      sleep: noSleep,
    });
    expect(finished).toBe(true);
    expect(client.calls).toHaveLength(1);
  });
});

describe('createTargetRunner', () => {
  it("runs the target under the server's deploy ID and posts progress, steps and the result in order", async () => {
    const fs = memFs();
    const { context } = runnerContext(fs);
    const engine = fakeEngine();
    const store = memoryTargetStore();
    const client = fakeClient(() => ({}));
    const run = createTargetRunner({ client, engine, context, store, log: quiet, sleep: noSleep });

    await run(target());

    expect(engine.requests[0]).toMatchObject({ deployId: target().deployId, kind: 'deploy', app: 'web', sha: SHA, dryRun: false });
    const paths = client.calls.map((c) => c.path);
    expect(paths.at(-1)).toBe(RESULT_PATH);
    expect(paths.filter((p) => p === RESULT_PATH)).toHaveLength(1);
    expect(paths[0]).toBe(PROGRESS_PATH);

    const progress = client.calls.filter((c) => c.path === PROGRESS_PATH).map((c) => c.body);
    expect(progress).toEqual([
      { targetId: target().targetId, state: 'verifying', step: 'verify' },
      { targetId: target().targetId, state: 'backing_up', step: 'backup' },
      { targetId: target().targetId, state: 'swapping', step: 'swap' },
      { targetId: target().targetId, state: 'succeeded' },
    ]);

    const steps = client.calls.filter((c) => c.path === STEPS_PATH).map((c) => c.body as { name: string; phase: string; argv: string[] });
    expect(steps.map((s) => `${s.name}:${s.phase}`)).toEqual([
      'verify:start',
      'verify:end',
      'backup:start',
      'backup:end',
      'swap:start',
      'swap:end',
    ]);
    expect(steps[0]?.argv).toEqual(['verify']);
    expect(steps[2]?.argv).toEqual(['pg_dump', '-Fc']);
    // The progress for a step is posted before that step's journal lines.
    const firstBackupProgress = paths.indexOf(PROGRESS_PATH, 1);
    const firstBackupStep = client.calls.findIndex((c) => c.path === STEPS_PATH && (c.body as { name: string }).name === 'backup');
    expect(firstBackupProgress).toBeLessThan(firstBackupStep);

    const result = client.calls.at(-1)?.body as TargetResult;
    expect(result).toEqual({
      targetId: target().targetId,
      state: 'succeeded',
      images: [{ service: 'web', sha: SHA, digest: DIGEST }],
      gates: [{ gate: 'G5', pass: true, reason: 'ci green' }],
      schemaRevision: '20260924_init',
      backupArtifact: { path: '/data/backups/web/1.dump', size: 4096, createdAt: '2026-09-24T12:00:00.000Z' },
    });
    expect(store.records.size).toBe(0);
  });

  it('keeps deploying while the server is unreachable, then syncs every step and retries the result', async () => {
    const fs = memFs();
    const { context } = runnerContext(fs);
    // The server is down for the whole deploy; it comes back at the first retry.
    let serverUp = false;
    const engine = fakeEngine();
    const store = memoryTargetStore();
    let resultAttempts = 0;
    const deliveredSteps: string[] = [];
    const client = fakeClient((call) => {
      if (!serverUp) throw new TypeError('fetch failed');
      if (call.path === RESULT_PATH) {
        resultAttempts += 1;
        if (resultAttempts < 3) throw new AgentRequestError(503, null, 'POST', RESULT_PATH);
      }
      if (call.path === STEPS_PATH) {
        const b = call.body as { name: string; phase: string };
        deliveredSteps.push(`${b.name}:${b.phase}`);
      }
      return {};
    });
    const delays: number[] = [];
    const run = createTargetRunner({
      client,
      engine,
      context,
      store,
      log: quiet,
      sleep: (ms) => {
        delays.push(ms);
        serverUp = true;
        return Promise.resolve();
      },
    });

    await run(target());

    // The deploy ran to the end with nobody listening.
    expect(engine.ran).toEqual(['verify', 'backup', 'swap']);
    // Every journal line reached the server once, in order, before the result.
    expect(deliveredSteps).toEqual(['verify:start', 'verify:end', 'backup:start', 'backup:end', 'swap:start', 'swap:end']);
    expect(resultAttempts).toBe(3);
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    expect(client.calls.at(-1)?.path).toBe(RESULT_PATH);
    expect(store.records.size).toBe(0);
  });

  it('keeps an undelivered result in the store when stopped, for the next start', async () => {
    const fs = memFs();
    const { context } = runnerContext(fs);
    const stop = new AbortController();
    const store = memoryTargetStore();
    const client = fakeClient(() => {
      throw new TypeError('fetch failed');
    });
    const run = createTargetRunner({
      client,
      engine: fakeEngine(),
      context,
      store,
      log: quiet,
      signal: stop.signal,
      sleep: () => {
        stop.abort();
        return Promise.resolve();
      },
    });
    await run(target());
    const kept = store.records.get(target().targetId);
    expect(kept?.result?.state).toBe('succeeded');
  });

  it('a 409 on the result means the server already has it: done', async () => {
    const fs = memFs();
    const { context } = runnerContext(fs);
    const store = memoryTargetStore();
    const client = fakeClient((call) => {
      if (call.path === RESULT_PATH) throw new AgentRequestError(409, refusal('conflict', 'dup'), 'POST', RESULT_PATH);
      return {};
    });
    const run = createTargetRunner({ client, engine: fakeEngine(), context, store, log: quiet, sleep: noSleep });
    await run(target());
    expect(client.calls.filter((c) => c.path === RESULT_PATH)).toHaveLength(1);
    expect(store.records.size).toBe(0);
  });

  it('runs a rollback with its target deploy', async () => {
    const fs = memFs();
    const { context } = runnerContext(fs);
    const engine = fakeEngine();
    const client = fakeClient(() => ({}));
    const run = createTargetRunner({ client, engine, context, store: memoryTargetStore(), log: quiet, sleep: noSleep });
    await run(target({ kind: 'rollback', toDeployId: '33333333-3333-4333-8333-333333333333' }));
    expect(engine.requests[0]).toMatchObject({ deployId: target().deployId, toDeployId: '33333333-3333-4333-8333-333333333333' });
  });

  it('reports a failed result when the context cannot be built (a bad manifest)', async () => {
    const client = fakeClient(() => ({}));
    const run = createTargetRunner({
      client,
      engine: fakeEngine(),
      context: () => Promise.reject(new Error('apps/web.yaml: soakSeconds must be a number')),
      store: memoryTargetStore(),
      log: quiet,
      sleep: noSleep,
    });
    await run(target());
    const result = client.calls.at(-1)?.body as TargetResult;
    expect(result.state).toBe('failed');
    expect(result.refusal?.code).toBe('step_failed');
    expect(result.refusal?.message).toContain('soakSeconds');
  });
});

describe('toTargetResult', () => {
  it('a passing dry run (stopped at verify) is succeeded', () => {
    const r = toTargetResult(target({ dryRun: true }), deployResult({ state: 'verifying', schemaRevision: null }));
    expect(r.state).toBe('succeeded');
    expect(r.schemaRevision).toBeUndefined();
  });

  it('a refusal is carried through', () => {
    const why = refusal('ci_not_green', 'CI is red.');
    const r = toTargetResult(target(), deployResult({ state: 'refused', refusal: why, images: [] }));
    expect(r).toMatchObject({ state: 'refused', refusal: why, images: [] });
  });
});

describe('reportLeftovers', () => {
  it('reports a target with no result as failed/interrupted, and a kept result as it was', async () => {
    const store = memoryTargetStore();
    const kept: TargetResult = { targetId: 'kept', state: 'succeeded', images: [] };
    await store.put({ targetId: 'lost', deployId: 'd1', app: 'web' });
    await store.put({ targetId: 'kept', deployId: 'd2', app: 'api', result: kept });
    await store.put({ targetId: 'live', deployId: 'd3', app: 'busy' });
    const client = fakeClient(() => ({}));
    await reportLeftovers({
      client,
      store,
      log: quiet,
      recovered: new Map([['d1', 'swap']]),
      isLive: (app) => Promise.resolve(app === 'busy'),
    });
    const bodies = client.calls.map((c) => c.body as TargetResult);
    expect(client.calls.every((c) => c.path === RESULT_PATH)).toBe(true);
    expect(bodies).toHaveLength(2);
    const lost = bodies.find((b) => b.targetId === 'lost');
    expect(lost).toMatchObject({ state: 'failed', images: [], refusal: { code: 'interrupted' } });
    expect(lost?.refusal?.message).toContain('swap');
    expect(bodies.find((b) => b.targetId === 'kept')).toEqual(kept);
    expect([...store.records.keys()]).toEqual(['live']);
  });

  it('keeps a leftover the server cannot be told about now', async () => {
    const store = memoryTargetStore();
    await store.put({ targetId: 'lost', deployId: 'd1', app: 'web' });
    const client = fakeClient(() => {
      throw new TypeError('fetch failed');
    });
    await reportLeftovers({ client, store, log: quiet });
    expect(store.records.has('lost')).toBe(true);
  });
});

describe('fileTargetStore', () => {
  it('round-trips records through one JSON file', async () => {
    const fs = memFs();
    const store = fileTargetStore(fs, '/data/agent/targets.json');
    await Promise.all([
      store.put({ targetId: 'a', deployId: 'd1', app: 'web' }),
      store.put({ targetId: 'b', deployId: 'd2', app: 'api' }),
    ]);
    await store.remove('a');
    const again = fileTargetStore(fs, '/data/agent/targets.json');
    expect(await again.all()).toEqual([{ targetId: 'b', deployId: 'd2', app: 'api' }]);
  });
});

describe('loadAgentConfig', () => {
  const base = { SHIPYARD_SERVER_URL: 'https://shipyard.example.com', SHIPYARD_DATA_ROOT: '/data/shipyard/' };

  it('reads the server, data root, token and version', () => {
    const config = loadAgentConfig({ ...base, GITHUB_TOKEN_AGENT: 'ghp_x', SHIPYARD_VERSION: 'abc123' }, () => false);
    expect(config).toEqual({
      serverUrl: 'https://shipyard.example.com/',
      dataRoot: '/data/shipyard',
      githubToken: 'ghp_x',
      agentVersion: 'abc123',
      selfContainerId: undefined,
      dockerHost: undefined,
    });
    expect(loadAgentConfig({ ...base, SHIPYARD_AGENT_VERSION: '0.2.0', SHIPYARD_VERSION: 'abc' }, () => false).agentVersion).toBe('0.2.0');
  });

  it('finds its own container: explicit, else HOSTNAME inside a container', () => {
    expect(loadAgentConfig({ ...base, HOSTNAME: 'f00dcafe' }, () => true).selfContainerId).toBe('f00dcafe');
    expect(loadAgentConfig({ ...base, HOSTNAME: 'zima' }, () => false).selfContainerId).toBeUndefined();
    expect(loadAgentConfig({ ...base, HOSTNAME: 'x', SHIPYARD_SELF_CONTAINER_ID: 'abc' }, () => true).selfContainerId).toBe('abc');
  });

  it('refuses a missing server or data root', () => {
    expect(() => loadAgentConfig({ SHIPYARD_DATA_ROOT: '/d' }, () => false)).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ SHIPYARD_SERVER_URL: 'https://x' }, () => false)).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ ...base, SHIPYARD_SERVER_URL: 'ftp://x' }, () => false)).toThrow(AgentConfigError);
  });
});
