import { describe, expect, it } from 'vitest';
import { ActionResult, refusal, type ActionJob, type Manifest, type StackManifest } from '@shipyard/schema';
import {
  ACTION_STEP,
  Journal,
  ManifestLoadError,
  type Clock,
  type ComposeTarget,
  type DockerPort,
  type FsPort,
  type LoadedManifests,
  type LoadedStacks,
  type Log,
  type RunningContainer,
} from '@shipyard/sequence';
import {
  ACTION_WAIT_MS,
  actionArgv,
  actionProgressPath,
  actionResultPath,
  createActionRunner,
  reportInterruptedActions,
  type ActionRunnerOptions,
} from '../src/actions.js';
import { AgentRequestError, type AgentClient } from '../src/client.js';

/**
 * SHP-T-15.3 (SHP-REQ-184, SHP-REQ-187, SHP-REQ-190): lifecycle actions on the agent — journaled
 * before compose runs, validated against the host's manifests and the compose project, refused
 * while a deploy of the app is in flight, run as a fixed argv, waited on, and reported redacted.
 */

const ACTION_ID = '44444444-4444-4444-8444-444444444444';
const SECRET_FILE_VALUE = 'db-password-from-env-file';
const SECRET_ENV_VALUE = 'api-token-from-container-env';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeClient(handler: (call: Call) => unknown = () => ({ ok: true })): AgentClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    request(method, path, body) {
      const call = { method, path, body };
      calls.push(call);
      try {
        return Promise.resolve(handler(call));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const quietLog: Log = { ...quiet, child: () => quietLog };

function memFs(files: Record<string, string> = {}): FsPort & { files: Record<string, string> } {
  return {
    files,
    readFile: (path) => (files[path] === undefined ? Promise.reject(new Error(`ENOENT ${path}`)) : Promise.resolve(files[path])),
    writeFileAtomic: (path, content) => {
      files[path] = content;
      return Promise.resolve();
    },
    appendLine: (path, line) => {
      files[path] = `${files[path] ?? ''}${line}\n`;
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(path in files),
    mkdirp: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };
}

/** A clock whose sleep advances it, so a 60 s wait runs at once. */
function fakeClock(): Clock & { slept: number[] } {
  let now = Date.parse('2026-10-22T12:00:00Z');
  const slept: number[] = [];
  return {
    slept,
    now: () => new Date(now),
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

const WEB_COMPOSE: ComposeTarget = { files: ['/srv/web/compose.yml'], project: 'web' };
const IMMICH_COMPOSE: ComposeTarget = { files: ['/DATA/AppData/immich/docker-compose.yml'], project: 'immich' };

function apps(compose: ComposeTarget = WEB_COMPOSE): LoadedManifests {
  const manifest = {
    name: 'web',
    repo: 'matdemers1/web',
    compose,
    envFiles: ['/srv/web/.env'],
    services: { web: { image: 'ghcr.io/matdemers1/web' } },
  } as unknown as Manifest;
  return new Map([['web', { manifest, file: '/data/apps/web.yml', sha256: 'a'.repeat(64) }]]);
}

function stacks(): LoadedStacks {
  const manifest: StackManifest = { kind: 'stack', name: 'immich', compose: IMMICH_COMPOSE, updates: 'none' };
  return new Map([['immich', { manifest, file: '/data/stacks/immich.yml', sha256: 'b'.repeat(64) }]]);
}

interface DockerWorld {
  services?: string[];
  /** What `containers()` answers on each call, in turn; the last repeats. */
  states?: Partial<RunningContainer>[][];
  composeExit?: number;
  composeOutput?: string;
  events?: string[];
}

function fakeDocker(world: DockerWorld = {}): DockerPort & { composeCalls: { target: ComposeTarget; args: string[] }[] } {
  const composeCalls: { target: ComposeTarget; args: string[] }[] = [];
  const states = world.states ?? [[{ state: 'running', health: 'none' }]];
  let look = 0;
  return {
    composeCalls,
    compose: (target, args) => {
      composeCalls.push({ target, args });
      if (args[0] === 'config') return Promise.resolve({ exitCode: 0, stdout: `${(world.services ?? ['web', 'db']).join('\n')}\n`, stderr: '' });
      world.events?.push(`compose ${args.join(' ')}`);
      return Promise.resolve({ exitCode: world.composeExit ?? 0, stdout: world.composeOutput ?? '', stderr: ' Container web-1  Started\n' });
    },
    containers: (_target, service) => {
      const now = states[Math.min(look++, states.length - 1)] ?? [];
      return Promise.resolve(
        now.map((c, i) => ({ id: `c${String(i)}`, service: service ?? 'web', repoDigests: [], labels: {}, networks: [], state: 'running', ...c })),
      );
    },
    inspectEnv: () => Promise.resolve({ envValues: [SECRET_ENV_VALUE, 'short'], composeProject: 'web' }),
    probeHealth: () => Promise.reject(new Error('unused')),
    freeBytes: () => Promise.resolve(0),
    images: () => Promise.resolve([]),
    removeImage: () => Promise.resolve(),
  };
}

function job(extra: Partial<ActionJob> = {}): ActionJob {
  return { actionId: ACTION_ID, target: { kind: 'app', name: 'web' }, verb: 'restart', service: 'web', requesterLabel: 'matthew (console)', ...extra };
}

function setup(over: Partial<ActionRunnerOptions> & { world?: DockerWorld } = {}) {
  const fs = memFs({ '/srv/web/.env': `DB_PASSWORD=${SECRET_FILE_VALUE}\nDEBUG=true\n` });
  const clock = fakeClock();
  const journal = new Journal(fs, '/data/agent/journal.jsonl', clock, quietLog);
  const docker = fakeDocker(over.world);
  const client = fakeClient();
  const runner = createActionRunner({
    client,
    docker,
    fs,
    journal,
    clock,
    apps: () => Promise.resolve(apps()),
    stacks: () => Promise.resolve(stacks()),
    deployInFlight: () => false,
    log: quiet,
    sleep: () => Promise.resolve(),
    ...over,
  });
  const results = (): ActionResult[] => client.calls.filter((c) => c.path === actionResultPath(ACTION_ID)).map((c) => ActionResult.parse(c.body));
  return { fs, clock, journal, docker, client, runner, results };
}

describe('actionArgv', () => {
  it('maps each verb to its compose arguments; recreate never pulls, builds or touches dependencies', () => {
    expect(actionArgv('start', 'web')).toEqual(['start', 'web']);
    expect(actionArgv('stop')).toEqual(['stop']);
    expect(actionArgv('restart', 'db')).toEqual(['restart', 'db']);
    expect(actionArgv('recreate', 'web')).toEqual(['up', '-d', '--force-recreate', '--no-deps', '--no-build', '--pull', 'never', 'web']);
  });
});

describe('the action runner (SHP-REQ-184)', () => {
  it('journals the action before compose runs, then runs it, waits, and reports progress and result', async () => {
    const events: string[] = [];
    const { runner, client, journal, fs, results } = setup({ world: { events } });
    const realBegin = journal.begin.bind(journal);
    journal.begin = async (entry) => {
      events.push(`journal ${entry.step} start`);
      await realBegin(entry);
    };
    const result = await runner.run(job());

    expect(result).toEqual({ actionId: ACTION_ID, state: 'succeeded', output: ' Container web-1  Started\n' });
    // The order is the point (SHP-REQ-187): journaled, then compose.
    expect(events).toEqual([`journal ${ACTION_STEP} start`, 'compose restart web']);
    expect(client.calls.map((c) => c.path)).toEqual([actionProgressPath(ACTION_ID), actionResultPath(ACTION_ID)]);
    expect(client.calls[0]?.body).toEqual({ actionId: ACTION_ID, state: 'running' });
    expect(results()).toEqual([result]);

    const lines = (fs.files['/data/agent/journal.jsonl'] ?? '').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l['step'], l['phase']])).toEqual([
      [ACTION_STEP, 'start'],
      [ACTION_STEP, 'end'],
    ]);
    expect(lines[0]).toMatchObject({ deployId: ACTION_ID, app: 'web', argv: ['restart', 'web'], detail: { verb: 'restart', target: 'app', service: 'web' } });
    expect(lines[1]).toMatchObject({ exitCode: 0, detail: { state: 'succeeded' } });
    expect(await journal.unfinishedActions()).toEqual([]);
  });

  it('runs recreate with --no-deps --no-build --pull never and never touches the compose file', async () => {
    const { runner, docker, fs } = setup();
    const before = { ...fs.files };
    await runner.run(job({ verb: 'recreate' }));
    const run = docker.composeCalls.filter((c) => c.args[0] !== 'config');
    expect(run).toEqual([{ target: WEB_COMPOSE, args: ['up', '-d', '--force-recreate', '--no-deps', '--no-build', '--pull', 'never', 'web'] }]);
    // Only the journal was written: no compose file, no image line.
    expect(Object.keys(fs.files).filter((p) => fs.files[p] !== before[p])).toEqual(['/data/agent/journal.jsonl']);
  });

  it('acts on a whole project, and on an adopted stack', async () => {
    const { runner, docker } = setup();
    await runner.run(job({ service: undefined, verb: 'stop' }));
    await runner.run(job({ target: { kind: 'stack', name: 'immich' }, verb: 'start', service: undefined }));
    expect(docker.composeCalls.filter((c) => c.args[0] !== 'config')).toEqual([
      { target: WEB_COMPOSE, args: ['stop'] },
      { target: IMMICH_COMPOSE, args: ['start'] },
    ]);
  });

  it('refuses an unknown app or stack, and a service outside the compose project, without journaling or acting', async () => {
    const { runner, docker, fs } = setup({ world: { services: ['web', 'db'] } });
    const unknownApp = await runner.run(job({ target: { kind: 'app', name: 'nope' } }));
    expect(unknownApp).toMatchObject({ state: 'refused', refusal: { code: 'unknown_app' } });
    const unknownStack = await runner.run(job({ target: { kind: 'stack', name: 'web' } }));
    expect(unknownStack).toMatchObject({ state: 'refused', refusal: { code: 'not_adopted' } });
    const badService = await runner.run(job({ service: 'cache' }));
    expect(badService).toMatchObject({ state: 'refused', refusal: { code: 'invalid_request' } });
    // An app is never acted on as a stack, nor a stack as an app.
    expect(docker.composeCalls.every((c) => c.args[0] === 'config')).toBe(true);
    expect(fs.files['/data/agent/journal.jsonl']).toBeUndefined();
  });

  it('refuses a compose project or service beginning with "-" before building any argv', async () => {
    const { runner, docker } = setup({ apps: () => Promise.resolve(apps({ files: ['/srv/web/compose.yml'], project: '-p' })) });
    expect(await runner.run(job())).toMatchObject({ state: 'refused', refusal: { code: 'invalid_request' } });
    const second = setup();
    expect(await second.runner.run(job({ service: '--help' }))).toMatchObject({ state: 'refused', refusal: { code: 'invalid_request' } });
    expect(docker.composeCalls).toEqual([]);
    expect(second.docker.composeCalls).toEqual([]);
  });

  it('refuses locked while a deploy of that app is in flight, and still acts on a stack meanwhile', async () => {
    const { runner, docker, fs } = setup({ deployInFlight: (app) => app === 'web' });
    expect(await runner.run(job())).toMatchObject({ state: 'refused', refusal: { code: 'locked' } });
    expect(fs.files['/data/agent/journal.jsonl']).toBeUndefined();
    expect(await runner.run(job({ target: { kind: 'stack', name: 'immich' }, service: undefined }))).toMatchObject({ state: 'succeeded' });
    expect(docker.composeCalls.filter((c) => c.args[0] !== 'config')).toEqual([{ target: IMMICH_COMPOSE, args: ['restart'] }]);
  });

  it("refuses with the lock holder's refusal when the app's deploy lock cannot be taken, and releases a lock it took", async () => {
    const released: string[] = [];
    const held = setup({ lockApp: () => Promise.resolve(refusal('locked', 'web is locked by someone deploying abc1234.')) });
    expect(await held.runner.run(job())).toMatchObject({ state: 'refused', refusal: { code: 'locked', message: 'web is locked by someone deploying abc1234.' } });
    expect(held.docker.composeCalls.filter((c) => c.args[0] !== 'config')).toEqual([]);

    const free = setup({ lockApp: (app) => Promise.resolve({ release: () => (released.push(app), Promise.resolve()) }) });
    expect(await free.runner.run(job())).toMatchObject({ state: 'succeeded' });
    expect(released).toEqual(['web']);
  });

  it('refuses a manifest that fails to load, naming it', async () => {
    const { runner } = setup({ apps: () => Promise.reject(new ManifestLoadError([{ file: '/data/apps/web.yml', path: 'name', message: 'bad' }])) });
    expect(await runner.run(job())).toMatchObject({ state: 'refused', refusal: { code: 'manifest_invalid' } });
  });

  it('waits for running and healthy, looking again each second', async () => {
    const { runner, clock } = setup({
      world: {
        states: [
          // Read before the action, for the containers' Env values.
          [{ state: 'running', health: 'healthy' }],
          [{ state: 'restarting', health: 'starting' }],
          [{ state: 'running', health: 'starting' }],
          [{ state: 'running', health: 'healthy' }],
        ],
      },
    });
    expect(await runner.run(job())).toMatchObject({ state: 'succeeded' });
    expect(clock.slept).toEqual([1_000, 1_000]);
  });

  it('fails action_failed when not healthy within 60 s', async () => {
    const { runner, clock, journal } = setup({ world: { states: [[{ state: 'running', health: 'unhealthy' }]] } });
    const result = await runner.run(job({ verb: 'start' }));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'action_failed' } });
    expect(result.refusal?.message).toContain('web: running, unhealthy');
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBe(ACTION_WAIT_MS);
    expect(await journal.unfinishedActions()).toEqual([]);
  });

  it('does not wait after stop', async () => {
    const { runner, clock } = setup({ world: { states: [[{ state: 'exited' }]] } });
    expect(await runner.run(job({ verb: 'stop' }))).toMatchObject({ state: 'succeeded' });
    expect(clock.slept).toEqual([]);
  });

  it("fails action_failed on compose's non-zero exit, with its output redacted", async () => {
    const output = `Error: password ${SECRET_FILE_VALUE} rejected; token ${SECRET_ENV_VALUE}; debug true\n`;
    const { runner, client, fs } = setup({ world: { composeExit: 1, composeOutput: output } });
    const result = await runner.run(job());
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'action_failed' } });
    expect(result.output).toContain('Error: password [redacted] rejected; token [redacted]; debug true');
    const wire = JSON.stringify(client.calls);
    expect(wire).not.toContain(SECRET_FILE_VALUE);
    expect(wire).not.toContain(SECRET_ENV_VALUE);
    // Nor in the journal on disk.
    expect(fs.files['/data/agent/journal.jsonl']).not.toContain(SECRET_FILE_VALUE);
    expect(fs.files['/data/agent/journal.jsonl']).not.toContain(SECRET_ENV_VALUE);
  });

  it('caps the output at 16 KiB, keeping the end', async () => {
    const { runner } = setup({ world: { composeExit: 1, composeOutput: `${'x'.repeat(40_000)}THE END` } });
    const result = await runner.run(job());
    expect(result.output?.length).toBe(16_384);
    expect(result.output?.endsWith('Started\n')).toBe(true);
  });

  it('does not run compose when the journal cannot be written', async () => {
    const { runner, journal, docker } = setup();
    journal.begin = () => Promise.reject(new Error('ENOSPC'));
    const result = await runner.run(job());
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'action_failed' } });
    expect(result.refusal?.message).toContain('not run');
    expect(docker.composeCalls.filter((c) => c.args[0] !== 'config')).toEqual([]);
  });

  it('refuses a second action while one runs, rather than queueing it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { runner, docker, client } = setup();
    const slow = docker.compose.bind(docker);
    docker.compose = async (target, args, o) => {
      if (args[0] !== 'config') await gate;
      return slow(target, args, o);
    };
    const first = runner.run(job());
    await new Promise((r) => setTimeout(r, 5));
    expect(runner.busy()).toBe(true);
    const second = await runner.run(job({ actionId: '55555555-5555-4555-8555-555555555555' }));
    expect(second).toMatchObject({ state: 'refused', refusal: { code: 'conflict' } });
    expect(client.calls.some((c) => c.path === actionResultPath('55555555-5555-4555-8555-555555555555'))).toBe(true);
    release();
    expect(await first).toMatchObject({ state: 'succeeded' });
    expect(runner.busy()).toBe(false);
  });

  it('retries the result until the server takes it, and drops it on a permanent refusal', async () => {
    let tries = 0;
    const client = fakeClient((call) => {
      if (call.path === actionResultPath(ACTION_ID) && tries++ < 2) throw new TypeError('fetch failed');
      return { ok: true };
    });
    const { runner } = setup({ client });
    await runner.run(job());
    expect(client.calls.filter((c) => c.path === actionResultPath(ACTION_ID))).toHaveLength(3);

    const refusing = fakeClient((call) => {
      if (call.path === actionResultPath(ACTION_ID)) throw new AgentRequestError(409, null, 'POST', call.path);
      return { ok: true };
    });
    await setup({ client: refusing }).runner.run(job());
    expect(refusing.calls.filter((c) => c.path === actionResultPath(ACTION_ID))).toHaveLength(1);
  });
});

describe('reportInterruptedActions (SHP-REQ-187)', () => {
  it('reports an action left mid-run as failed/interrupted and closes its journal bracket; keeps it when the server is unreachable', async () => {
    const fs = memFs();
    const journal = new Journal(fs, '/data/agent/journal.jsonl', fakeClock(), quietLog);
    await journal.begin({ deployId: ACTION_ID, app: 'web', step: ACTION_STEP, argv: ['restart'], detail: { verb: 'restart' } });

    const offline = fakeClient(() => {
      throw new TypeError('fetch failed');
    });
    await reportInterruptedActions({ client: offline, journal, log: quiet });
    expect(await journal.unfinishedActions()).toHaveLength(1);

    const client = fakeClient();
    await reportInterruptedActions({ client, journal, log: quiet });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      method: 'POST',
      path: actionResultPath(ACTION_ID),
      body: { actionId: ACTION_ID, state: 'failed', refusal: { code: 'interrupted' } },
    });
    expect(await journal.unfinishedActions()).toEqual([]);
    expect(await journal.unfinished()).toEqual([]);
  });
});
