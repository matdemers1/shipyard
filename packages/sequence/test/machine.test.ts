import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeployTargetState, Manifest } from '@shipyard/schema';
import type { Refusal } from '@shipyard/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeFs } from '../src/adapters/node.js';
import { Journal } from '../src/journal.js';
import { Ledger } from '../src/ledger.js';
import { canTransition, IllegalTransitionError, lockPath, runDeploy, transition, TRANSITIONS } from '../src/machine.js';
import type { MachineContext } from '../src/machine.js';
import type { LoadedManifests } from '../src/manifest.js';
import { RefusalError } from '../src/ports.js';
import type {
  Clock,
  ComposeTarget,
  DockerPort,
  ExecResult,
  FsPort,
  GitHubPort,
  HealthResponse,
  Log,
  RegistryPort,
  RunningContainer,
  SequencePorts,
  WorkflowRun,
} from '../src/ports.js';
import { LABEL_MIGRATION, LABEL_REVISION, LABEL_SCHEMA } from '../src/types.js';
import type { DeployRequest, JournalEntry } from '../src/types.js';

// ─── Transition table ────────────────────────────────────────────────────────

const STATES = DeployTargetState.options;

const LEGAL: Record<string, string[]> = {
  queued: ['verifying'],
  verifying: ['refused', 'backing_up', 'migrating', 'pulling'],
  backing_up: ['migrating', 'pulling', 'failed'],
  migrating: ['pulling', 'failed'],
  pulling: ['swapping', 'failed'],
  swapping: ['checking', 'rolling_back', 'failed'],
  checking: ['soaking', 'rolling_back', 'failed'],
  soaking: ['succeeded', 'rolling_back', 'failed'],
  rolling_back: ['rolled_back', 'failed'],
};

describe('transition table', () => {
  const pairs = STATES.flatMap((from) => STATES.map((to) => [from, to] as const));

  it.each(pairs)('%s → %s is legal only when the table says so', (from, to) => {
    const legal = (LEGAL[from] ?? []).includes(to);
    expect(canTransition(from, to)).toBe(legal);
    if (legal) {
      expect(transition(from, to)).toBe(to);
    } else {
      expect(() => transition(from, to)).toThrow(IllegalTransitionError);
      expect(() => transition(from, to)).toThrow(`${from} → ${to}`);
    }
  });

  it('covers every state and gives terminal states no way out', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATES].sort());
    for (const terminal of ['succeeded', 'failed', 'rolled_back', 'refused', 'cancelled'] as const) {
      expect(TRANSITIONS[terminal]).toEqual([]);
    }
  });
});

// ─── A fake world ────────────────────────────────────────────────────────────

const REPO = 'ghcr.io/example/toy/app';
const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const digestOf = (c: string): string => `sha256:${c.repeat(64)}`;
const OLD_DIGEST = digestOf('1');
const NEW_DIGEST = digestOf('2');
const OTHER_DIGEST = digestOf('9');

const roots: string[] = [];

type HealthMode = 'ok' | 'fail' | 'wrong-schema' | 'fail-after';

interface FakeImage {
  labels: Record<string, string>;
  health: HealthMode;
  /** For fail-after: probes answered ok before it starts failing. */
  okProbes?: number;
}

interface World {
  root: string;
  dataRoot: string;
  composePath: string;
  artifactsDir: string;
  ports: SequencePorts;
  ctx: MachineContext;
  events: string[];
  images: Map<string, FakeImage>;
  running: Map<string, string>;
  composeCalls: string[][];
  progress: string[];
  /** Knobs. */
  opts: {
    ciConclusion: string | null;
    onDefault: 'ahead' | 'identical' | 'behind' | null;
    aheadOfLive: 'ahead' | 'behind' | 'identical' | 'diverged' | null;
    githubDown: boolean;
    backupExit: number;
    migrateExit: number;
    pullExit: number;
    /** Exit codes for successive `up` calls (default 0). */
    upExits: number[];
    /** When set, `up` runs this digest instead of the one in the compose file. */
    tamperDigest: string | null;
  };
}

function composeText(sha: string, digest: string): string {
  return `# hand-owned\nservices:\n  app:\n    image: ${REPO}:sha-${sha}@${digest}\n    restart: unless-stopped # keep\n`;
}

function makeLog(): Log {
  const log: Log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return log;
}

function makeClock(): Clock {
  // Starts at real time: the backup step compares artifact mtimes against it.
  let now = Date.now();
  return {
    now: () => new Date(now),
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

async function makeWorld(options: { backup?: boolean; migrate?: boolean; soakSeconds?: number; expectSchema?: string; envFiles?: string[]; requiredEnv?: string[] } = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'shp-machine-'));
  roots.push(root);
  const dataRoot = join(root, 'data');
  const stackDir = join(root, 'stack');
  const artifactsDir = join(root, 'backups');
  await mkdir(stackDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(join(dataRoot, 'agent'), { recursive: true });
  const composePath = join(stackDir, 'compose.yml');
  await writeFile(composePath, composeText(OLD_SHA, OLD_DIGEST), 'utf8');

  const events: string[] = [];
  const images = new Map<string, FakeImage>([
    [OLD_DIGEST, { labels: { [LABEL_REVISION]: OLD_SHA, [LABEL_SCHEMA]: 's1' }, health: 'ok' }],
    [NEW_DIGEST, { labels: { [LABEL_REVISION]: NEW_SHA, [LABEL_SCHEMA]: 's2' }, health: 'ok' }],
  ]);
  const running = new Map<string, string>([['app', OLD_DIGEST]]);
  const composeCalls: string[][] = [];
  const probeCounts = new Map<string, number>();

  const opts: World['opts'] = {
    ciConclusion: 'success',
    onDefault: 'ahead',
    aheadOfLive: 'ahead',
    githubDown: false,
    backupExit: 0,
    migrateExit: 0,
    pullExit: 0,
    upExits: [],
    tamperDigest: null,
  };

  const realFs = nodeFs();
  const fs: FsPort = {
    ...realFs,
    appendLine: async (path, line) => {
      if (path.endsWith('journal.jsonl')) {
        const entry = JSON.parse(line) as JournalEntry;
        events.push(`journal:${entry.phase}:${entry.step}`);
      }
      await realFs.appendLine(path, line);
    },
  };

  const github: GitHubPort = {
    workflowRuns: (_repo, workflow, headSha) => {
      if (opts.githubDown) return Promise.reject(new RefusalError({ code: 'github_unreachable', gate: 'none', message: 'GitHub is down', fix: 'retry' }));
      const run: WorkflowRun = { id: 1, headSha, path: `.github/workflows/${workflow}`, status: 'completed', conclusion: opts.ciConclusion, event: 'push', headBranch: 'main' };
      return Promise.resolve(opts.ciConclusion === null ? [] : [run]);
    },
    compare: (_repo, base, _head) => {
      const status = base === OLD_SHA ? opts.aheadOfLive : opts.onDefault;
      return Promise.resolve(status === null ? null : { status, aheadBy: 1, behindBy: 0, commits: [] });
    },
  };

  const registry: RegistryPort = {
    resolveDigest: (_repo, tag) => Promise.resolve(tag === `sha-${NEW_SHA}` ? NEW_DIGEST : tag === `sha-${OLD_SHA}` ? OLD_DIGEST : null),
    imageConfig: (_repo, digest) => Promise.resolve({ digest, labels: images.get(digest)?.labels ?? {} }),
  };

  const exec = (exitCode: number): Promise<ExecResult> => Promise.resolve({ exitCode, stdout: `out ${String(exitCode)}`, stderr: '' });

  const docker: DockerPort = {
    async compose(target: ComposeTarget, args: string[]) {
      composeCalls.push(args);
      events.push(`compose:${args[0] ?? ''}`);
      switch (args[0]) {
        case 'exec': {
          if (opts.backupExit === 0) await writeFile(join(artifactsDir, `dump-${String(Date.now())}.sql`), 'data', 'utf8');
          return exec(opts.backupExit);
        }
        case 'run':
          return exec(opts.migrateExit);
        case 'pull':
          return exec(opts.pullExit);
        case 'up': {
          const code = opts.upExits.shift() ?? 0;
          if (code !== 0) return exec(code);
          const text = await readFile(target.files[0] ?? '', 'utf8');
          const digest = /image: \S+@(sha256:[0-9a-f]{64})/.exec(text)?.[1];
          if (digest !== undefined) running.set('app', opts.tamperDigest ?? digest);
          return exec(0);
        }
        default:
          return exec(0);
      }
    },
    containers(_target, service) {
      const list: RunningContainer[] = [...running.entries()]
        .filter(([svc]) => service === undefined || svc === service)
        .map(([svc, digest]) => ({
          id: `c-${svc}`,
          service: svc,
          repoDigests: [`${REPO}@${digest}`],
          labels: images.get(digest)?.labels ?? {},
          state: 'running',
          networks: ['toy_default'],
        }));
      return Promise.resolve(list);
    },
    probeHealth(): Promise<HealthResponse> {
      const digest = running.get('app') ?? '';
      const image = images.get(digest);
      const count = (probeCounts.get(digest) ?? 0) + 1;
      probeCounts.set(digest, count);
      events.push('probe');
      const schema = image?.labels[LABEL_SCHEMA] ?? 's?';
      switch (image?.health) {
        case 'fail':
          return Promise.resolve({ httpStatus: 503, body: { status: 'unavailable', schema } });
        case 'wrong-schema':
          return Promise.resolve({ httpStatus: 200, body: { status: 'ok', schemaRevision: `${schema}-wrong` } });
        case 'fail-after':
          if (count > (image.okProbes ?? 0)) return Promise.resolve({ httpStatus: 500, body: 'boom' });
          return Promise.resolve({ httpStatus: 200, body: { ok: true, schema } });
        default:
          return Promise.resolve({ httpStatus: 200, body: { status: 'ok', schemaRevision: schema } });
      }
    },
    freeBytes: () => Promise.resolve(100 * 1024 ** 3),
    images: () => Promise.resolve([]),
    removeImage: () => Promise.resolve(),
  };

  const clock = makeClock();
  const log = makeLog();
  const ports: SequencePorts = { github, registry, docker, fs, clock, log };

  const manifest = Manifest.parse({
    name: 'toy',
    repo: 'example/toy',
    workflow: 'ci.yml',
    compose: { files: [composePath], project: 'toy' },
    services: { app: { image: REPO } },
    health: { service: 'app', port: 3000, path: '/health', ...(options.expectSchema === undefined ? {} : { expectSchema: options.expectSchema }) },
    soakSeconds: options.soakSeconds ?? 30,
    steps: {
      ...(options.backup === false ? {} : { backup: { service: 'app', argv: ['pg_dump', '-f', '/backups/x.sql'], artifactsDir } }),
      ...(options.migrate === false ? {} : { migrate: { service: 'app', argv: ['node', 'migrate.mjs'] } }),
    },
    ...(options.envFiles === undefined ? {} : { envFiles: options.envFiles }),
    ...(options.requiredEnv === undefined ? {} : { requiredEnv: options.requiredEnv }),
  });
  const manifests: LoadedManifests = new Map([['toy', { manifest, file: join(dataRoot, 'apps', 'toy.yml'), sha256: '0' }]]);

  const journal = new Journal(fs, join(dataRoot, 'agent', 'journal.jsonl'), clock, log);
  const ledger = await Ledger.open(fs, join(dataRoot, 'agent', 'ledger.jsonl'));
  // The old release is live, recorded by an earlier deploy.
  await ledger.append({
    app: 'toy',
    deployId: 'dep-old',
    kind: 'deploy',
    sha: OLD_SHA,
    images: [{ service: 'app', repo: REPO, digest: OLD_DIGEST, migration: null }],
    backupArtifact: null,
    at: new Date().toISOString(),
  });

  const progress: string[] = [];
  const ctx: MachineContext = {
    dataRoot,
    manifests,
    journal,
    ledger,
    workDir: join(dataRoot, 'agent', 'work'),
    historyDir: join(dataRoot, 'agent', 'history'),
    healthTimeoutMs: 20_000,
    checkIntervalMs: 1_000,
    soakIntervalMs: 10_000,
    onProgress: (e) => progress.push(e.state),
  };

  return { root, dataRoot, composePath, artifactsDir, ports, ctx, events, images, running, composeCalls, progress, opts };
}

function request(overrides: Partial<DeployRequest> = {}): DeployRequest {
  return { deployId: 'dep-new', kind: 'deploy', app: 'toy', sha: NEW_SHA, dryRun: false, requesterLabel: 'matt (phone)', ...overrides };
}

async function journalEntries(w: World): Promise<JournalEntry[]> {
  return w.ctx.journal.readAll();
}

async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(`${full}:${String((await stat(full)).mtimeMs)}`);
    }
  };
  await walk(dir);
  return out.sort();
}

function refusalOf(r: { refusal: Refusal | null }): Refusal {
  if (r.refusal === null) throw new Error('expected a refusal');
  return r.refusal;
}

let world: World;
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// ─── The happy path and the order of steps ───────────────────────────────────

describe('runDeploy — success', () => {
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('runs verify, backup, migrate, pull, swap, check, soak — each journaled before it runs', async () => {
    const result = await runDeploy(world.ports, world.ctx, request());

    expect(result.state).toBe('succeeded');
    expect(result.refusal).toBeNull();
    expect(result.schemaRevision).toBe('s2');
    expect(result.images).toMatchObject([{ service: 'app', digest: NEW_DIGEST, reference: `${REPO}:sha-${NEW_SHA}@${NEW_DIGEST}`, migration: null }]);
    expect(result.steps.map((s) => s.name)).toEqual(['verify', 'backup', 'migrate', 'pull', 'swap', 'check', 'soak']);

    const starts = (await journalEntries(world)).filter((e) => e.phase === 'start').map((e) => e.step);
    expect(starts).toEqual(['deploy', 'verify', 'backup', 'migrate', 'pull', 'swap', 'check', 'soak']);

    // Each step's start line is written before the step touches Docker.
    const seq = world.events.filter((e) => !e.startsWith('journal:end') && e !== 'probe');
    expect(seq.indexOf('journal:start:backup')).toBeLessThan(seq.indexOf('compose:exec'));
    expect(seq.indexOf('journal:start:migrate')).toBeLessThan(seq.indexOf('compose:run'));
    expect(seq.indexOf('journal:start:pull')).toBeLessThan(seq.indexOf('compose:pull'));
    expect(seq.indexOf('journal:start:swap')).toBeLessThan(seq.indexOf('compose:up'));
    expect(world.events.indexOf('journal:start:check')).toBeLessThan(world.events.indexOf('probe'));

    const entries = await journalEntries(world);
    const deployEnd = entries.find((e) => e.step === 'deploy' && e.phase === 'end');
    expect(deployEnd?.detail).toMatchObject({ state: 'succeeded' });
    const deployStart = entries.find((e) => e.step === 'deploy' && e.phase === 'start');
    expect(deployStart?.detail).toMatchObject({ historyDeployId: 'dep-new', composeFiles: [world.composePath], project: 'toy' });

    expect(world.progress).toEqual(['verifying', 'backing_up', 'migrating', 'pulling', 'swapping', 'checking', 'soaking', 'succeeded']);

    // Compose rewritten in place, every other byte kept; the ledger records the release.
    const compose = await readFile(world.composePath, 'utf8');
    expect(compose).toBe(composeText(NEW_SHA, NEW_DIGEST));
    expect(world.ctx.ledger.last('toy')).toMatchObject({ sha: NEW_SHA, deployId: 'dep-new', backupArtifact: result.backupArtifact });
    expect(result.backupArtifact).toMatch(/dump-\d+\.sql$/);

    // The migrate and pull steps ran the new image through an override, not by editing compose.
    expect(world.composeCalls.find((a) => a[0] === 'run')).toEqual(['run', '--rm', '--no-deps', '-T', 'app', 'node', 'migrate.mjs']);
    expect(world.composeCalls.find((a) => a[0] === 'up')).toEqual(['up', '-d', '--no-deps', 'app']);
    // The lock is released.
    await expect(stat(lockPath(world.dataRoot, 'toy'))).rejects.toThrow();
  });

  it('keeps checking health for the whole soak (SHP-REQ-025)', async () => {
    const result = await runDeploy(world.ports, world.ctx, request());
    expect(result.state).toBe('succeeded');
    const checkEnd = world.events.indexOf('journal:end:check');
    const soakProbes = world.events.slice(checkEnd).filter((e) => e === 'probe').length;
    // 30 s soak at a 10 s interval.
    expect(soakProbes).toBe(3);
  });

  it('skips backup and migrate when the manifest declares none', async () => {
    await rm(world.root, { recursive: true, force: true });
    world = await makeWorld({ backup: false, migrate: false });
    const result = await runDeploy(world.ports, world.ctx, request());
    expect(result.state).toBe('succeeded');
    expect(result.steps.map((s) => s.name)).toEqual(['verify', 'pull', 'swap', 'check', 'soak']);
    expect(world.progress).toEqual(['verifying', 'pulling', 'swapping', 'checking', 'soaking', 'succeeded']);
    expect(result.backupArtifact).toBeNull();
  });
});

// ─── Dry run and refusals ────────────────────────────────────────────────────

describe('runDeploy — dry run and refusals', () => {
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('a dry run evaluates every gate and writes nothing (SHP-REQ-050)', async () => {
    const before = await listTree(world.root);
    const result = await runDeploy(world.ports, world.ctx, request({ dryRun: true }));

    expect(result.state).toBe('verifying');
    expect(result.refusal).toBeNull();
    expect(result.gates.map((g) => g.gate)).toEqual(['disk', 'G5', 'G6', 'G7', 'G8']);
    expect(result.gates.every((g) => g.pass)).toBe(true);
    expect(result.images[0]?.digest).toBe(NEW_DIGEST);
    expect(await listTree(world.root)).toEqual(before);
    expect(world.composeCalls).toEqual([]);
    expect(world.events.filter((e) => e.startsWith('journal:'))).toEqual([]);
  });

  it('a refused dry run reports the gates and writes nothing', async () => {
    world.opts.ciConclusion = 'failure';
    const before = await listTree(world.root);
    const result = await runDeploy(world.ports, world.ctx, request({ dryRun: true }));
    expect(result.state).toBe('refused');
    expect(refusalOf(result).code).toBe('ci_not_green');
    expect(await listTree(world.root)).toEqual(before);
  });

  it('a failing gate ends refused, with every gate result, and touches nothing', async () => {
    world.opts.aheadOfLive = 'behind';
    const result = await runDeploy(world.ports, world.ctx, request());
    expect(result.state).toBe('refused');
    expect(refusalOf(result).code).toBe('not_ahead_of_live');
    expect(result.gates.find((g) => g.gate === 'G7')?.pass).toBe(false);
    expect(result.gates.find((g) => g.gate === 'G5')?.pass).toBe(true);
    expect(world.composeCalls).toEqual([]);
    expect(await readFile(world.composePath, 'utf8')).toBe(composeText(OLD_SHA, OLD_DIGEST));
    const end = (await journalEntries(world)).find((e) => e.step === 'deploy' && e.phase === 'end');
    expect(end?.detail).toMatchObject({ state: 'refused', code: 'not_ahead_of_live' });
    expect(world.progress).toEqual(['verifying', 'refused']);
  });

  it('an unreachable GitHub is a refusal, not a crash', async () => {
    world.opts.githubDown = true;
    const result = await runDeploy(world.ports, world.ctx, request());
    expect(result.state).toBe('refused');
    expect(refusalOf(result).code).toBe('github_unreachable');
  });

  it('an unknown app is refused', async () => {
    const result = await runDeploy(world.ports, world.ctx, request({ app: 'nope' }));
    expect(result.state).toBe('refused');
    expect(refusalOf(result).code).toBe('unknown_app');
    expect(await journalEntries(world)).toEqual([]);
  });

  it('a missing required env name refuses at G9, reading names only', async () => {
    await rm(world.root, { recursive: true, force: true });
    const dir = await mkdtemp(join(tmpdir(), 'shp-env-'));
    const envFile = join(dir, '.env');
    await writeFile(envFile, 'DATABASE_URL=postgres://secret\n', 'utf8');
    world = await makeWorld({ envFiles: [envFile], requiredEnv: ['DATABASE_URL', 'SESSION_SECRET'] });
    const result = await runDeploy(world.ports, world.ctx, request());
    await rm(dir, { recursive: true, force: true });
    expect(result.state).toBe('refused');
    expect(refusalOf(result).code).toBe('env_missing');
    expect(refusalOf(result).message).toContain('SESSION_SECRET');
    expect(JSON.stringify(result)).not.toContain('postgres://secret');
  });
});

// ─── The lock ────────────────────────────────────────────────────────────────

describe('runDeploy — host-CLI lock', () => {
  beforeEach(async () => {
    world = await makeWorld();
  });

  it("refuses while another live process holds the lock, naming its requester, SHA and step", async () => {
    const path = lockPath(world.dataRoot, 'toy');
    await mkdir(join(world.dataRoot, 'agent', 'locks'), { recursive: true });
    const holder = JSON.stringify({ pid: process.pid, deployId: 'dep-other', requesterLabel: 'claude session 7', sha: 'c'.repeat(40), step: 'soak', at: '' });
    await writeFile(path, holder, 'utf8');

    const result = await runDeploy(world.ports, world.ctx, request());

    expect(result.state).toBe('refused');
    expect(refusalOf(result).code).toBe('locked');
    expect(refusalOf(result).message).toBe('toy is locked by claude session 7 deploying ccccccc (step soak, deploy dep-other).');
    expect(await readFile(path, 'utf8')).toBe(holder);
    expect(world.composeCalls).toEqual([]);
  });

  it('takes over a stale lock whose holder is dead, and releases it afterwards', async () => {
    const path = lockPath(world.dataRoot, 'toy');
    await mkdir(join(world.dataRoot, 'agent', 'locks'), { recursive: true });
    await writeFile(path, JSON.stringify({ pid: 2 ** 22 + 12345, deployId: 'dep-dead', requesterLabel: 'crashed cli', sha: 'c'.repeat(40), step: 'swap', at: '' }), 'utf8');

    const result = await runDeploy(world.ports, world.ctx, request());
    expect(result.state).toBe('succeeded');
    await expect(stat(path)).rejects.toThrow();
  });

  it('records the current step in the lock while it holds it', async () => {
    const seen: string[] = [];
    world.ctx.onProgress = () => undefined;
    const original = world.ports.docker.compose.bind(world.ports.docker);
    world.ports.docker.compose = async (target, args) => {
      if (args[0] === 'pull') seen.push(await readFile(lockPath(world.dataRoot, 'toy'), 'utf8'));
      return original(target, args);
    };
    await runDeploy(world.ports, world.ctx, request({ requesterLabel: 'matt' }));
    expect(JSON.parse(seen[0] ?? '{}')).toMatchObject({ requesterLabel: 'matt', sha: NEW_SHA, step: 'pull', pid: process.pid });
  });
});

// ─── Failures before the swap ────────────────────────────────────────────────

describe('runDeploy — failure before swap leaves compose untouched', () => {
  beforeEach(async () => {
    world = await makeWorld();
  });

  it.each([
    ['backup', 'backup_failed', (w: World): void => { w.opts.backupExit = 1; }, ['verifying', 'backing_up', 'failed']],
    ['migrate', 'migrate_failed', (w: World): void => { w.opts.migrateExit = 2; }, ['verifying', 'backing_up', 'migrating', 'failed']],
    ['pull', 'step_failed', (w: World): void => { w.opts.pullExit = 1; }, ['verifying', 'backing_up', 'migrating', 'pulling', 'failed']],
  ] as const)('%s fails → failed (%s)', async (_step, code, arrange, states) => {
    arrange(world);
    const result = await runDeploy(world.ports, world.ctx, request());
    expect(result.state).toBe('failed');
    expect(refusalOf(result).code).toBe(code);
    expect(world.progress).toEqual(states);
    expect(await readFile(world.composePath, 'utf8')).toBe(composeText(OLD_SHA, OLD_DIGEST));
    expect(world.composeCalls.some((a) => a[0] === 'up')).toBe(false);
    expect(world.ctx.ledger.last('toy')?.sha).toBe(OLD_SHA);
    const end = (await journalEntries(world)).find((e) => e.step === 'deploy' && e.phase === 'end');
    expect(end?.detail).toMatchObject({ state: 'failed', code });
  });
});

// ─── Failures after the swap ─────────────────────────────────────────────────

describe('runDeploy — check and soak failures roll back image-only', () => {
  beforeEach(async () => {
    world = await makeWorld();
  });

  async function expectRolledBack(code: string): Promise<void> {
    const result = await runDeploy(world.ports, world.ctx, request());
    expect(result.state).toBe('rolled_back');
    expect(refusalOf(result).code).toBe(code);
    // The previous compose file, byte for byte, and the previous image running again.
    expect(await readFile(world.composePath, 'utf8')).toBe(composeText(OLD_SHA, OLD_DIGEST));
    expect(world.running.get('app')).toBe(OLD_DIGEST);
    expect(world.ctx.ledger.last('toy')?.sha).toBe(OLD_SHA);
    const starts = (await journalEntries(world)).filter((e) => e.phase === 'start').map((e) => e.step);
    expect(starts.at(-1)).toBe('rollback');
    const end = (await journalEntries(world)).find((e) => e.step === 'deploy' && e.phase === 'end');
    expect(end?.detail).toMatchObject({ state: 'rolled_back', code });
    // Image-only: no migration or restore was run on the way back.
    const lastUp = world.composeCalls.filter((a) => a[0] === 'up');
    expect(lastUp).toHaveLength(2);
    expect(world.composeCalls.filter((a) => a[0] === 'run')).toHaveLength(1);
  }

  it('unhealthy → rolled_back (health_failed) after polling for the health timeout', async () => {
    world.images.set(NEW_DIGEST, { labels: { [LABEL_REVISION]: NEW_SHA }, health: 'fail' });
    await expectRolledBack('health_failed');
    // 20 s timeout at 1 s: polled rather than failing on the first probe.
    expect(world.events.filter((e) => e === 'probe').length).toBeGreaterThanOrEqual(20);
    expect(world.progress).toEqual(['verifying', 'backing_up', 'migrating', 'pulling', 'swapping', 'checking', 'rolling_back', 'rolled_back']);
  });

  it('wrong schema against the image label → rolled_back (schema_mismatch)', async () => {
    world.images.set(NEW_DIGEST, { labels: { [LABEL_REVISION]: NEW_SHA, [LABEL_SCHEMA]: 's2' }, health: 'wrong-schema' });
    await expectRolledBack('schema_mismatch');
  });

  it("manifest expectSchema wins over the image's label", async () => {
    await rm(world.root, { recursive: true, force: true });
    world = await makeWorld({ expectSchema: 's-manifest' });
    await expectRolledBack('schema_mismatch');
  });

  it('a /health that reports no schema is not checked', async () => {
    world.ports.docker.probeHealth = () => Promise.resolve({ httpStatus: 200, body: { status: 'ok' } });
    world.ctx.healthTimeoutMs = 3_000;
    await expectRolledBack('health_failed');
  });

  it('a container on a digest other than the verified one → rolled_back (digest_mismatch)', async () => {
    world.images.set(OTHER_DIGEST, { labels: { [LABEL_REVISION]: NEW_SHA }, health: 'ok' });
    world.opts.tamperDigest = OTHER_DIGEST;
    const result = await runDeploy(world.ports, world.ctx, request());
    expect(result.state).toBe('failed');
    // The tamper also hits the rollback's `up`, so the previous digest never comes back.
    expect(refusalOf(result).code).toBe('digest_mismatch');
    expect(refusalOf(result).message).toContain('Rollback failed');
  });

  it('digest_mismatch then a clean rollback → rolled_back', async () => {
    world.images.set(OTHER_DIGEST, { labels: { [LABEL_REVISION]: NEW_SHA }, health: 'ok' });
    world.opts.tamperDigest = OTHER_DIGEST;
    const original = world.ports.docker.compose.bind(world.ports.docker);
    world.ports.docker.compose = async (target, args) => {
      const res = await original(target, args);
      if (args[0] === 'up') world.opts.tamperDigest = null;
      return res;
    };
    await expectRolledBack('digest_mismatch');
  });

  it('a revision label other than the SHA → rolled_back (revision_mismatch)', async () => {
    world.images.set(NEW_DIGEST, { labels: { [LABEL_REVISION]: 'd'.repeat(40) }, health: 'ok' });
    await expectRolledBack('revision_mismatch');
  });

  it('health failing mid-soak → rolled_back', async () => {
    world.images.set(NEW_DIGEST, { labels: { [LABEL_REVISION]: NEW_SHA, [LABEL_SCHEMA]: 's2' }, health: 'fail-after', okProbes: 2 });
    await expectRolledBack('health_failed');
    expect(world.progress).toEqual(['verifying', 'backing_up', 'migrating', 'pulling', 'swapping', 'checking', 'soaking', 'rolling_back', 'rolled_back']);
  });

  it('compose up failing at the swap → rolled_back', async () => {
    world.opts.upExits = [1];
    const result = await runDeploy(world.ports, world.ctx, request());
    expect(result.state).toBe('rolled_back');
    expect(refusalOf(result).code).toBe('step_failed');
    expect(await readFile(world.composePath, 'utf8')).toBe(composeText(OLD_SHA, OLD_DIGEST));
  });

  it('a rollback whose up fails ends failed, naming the original failure', async () => {
    world.images.set(NEW_DIGEST, { labels: { [LABEL_REVISION]: NEW_SHA }, health: 'fail' });
    world.opts.upExits = [0, 1];
    const result = await runDeploy(world.ports, world.ctx, request());
    expect(result.state).toBe('failed');
    expect(refusalOf(result).code).toBe('health_failed');
    expect(refusalOf(result).message).toContain('Rollback failed: compose up exited 1');
    expect(world.progress.slice(-2)).toEqual(['rolling_back', 'failed']);
  });
});

describe('runDeploy — contract releases are never rolled back (SHP-REQ-017)', () => {
  beforeEach(async () => {
    world = await makeWorld();
  });

  it('a failing contract-labelled release stops failed, stays on the new image, and keeps its backup', async () => {
    world.images.set(NEW_DIGEST, { labels: { [LABEL_REVISION]: NEW_SHA, [LABEL_MIGRATION]: ' Contract ' }, health: 'fail' });
    const result = await runDeploy(world.ports, world.ctx, request());

    expect(result.state).toBe('failed');
    expect(refusalOf(result).code).toBe('health_failed');
    expect(refusalOf(result).message).toContain('not rolled back');
    expect(result.images[0]?.migration).toBe('contract');
    expect(world.progress).not.toContain('rolling_back');
    expect(await readFile(world.composePath, 'utf8')).toBe(composeText(NEW_SHA, NEW_DIGEST));
    expect(world.running.get('app')).toBe(NEW_DIGEST);
    expect(world.composeCalls.filter((a) => a[0] === 'up')).toHaveLength(1);
    const artifact = result.backupArtifact ?? '';
    expect(artifact).toMatch(/dump-\d+\.sql$/);
    expect(await readFile(artifact, 'utf8')).toBe('data');
    expect((await journalEntries(world)).some((e) => e.step === 'rollback')).toBe(false);
  });
});
