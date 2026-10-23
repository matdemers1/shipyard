import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StackManifest, type StackUpdateJob, type StackUpdateStep } from '@shipyard/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nodeFs } from '../src/adapters/node.js';
import { createOciRegistry } from '../src/adapters/oci.js';
import { Journal } from '../src/journal.js';
import { Ledger } from '../src/ledger.js';
import { AppLock } from '../src/machine.js';
import type { LoadedStacks } from '../src/manifest.js';
import { RegistryError } from '../src/ports.js';
import type { Clock, DockerPort, ExecResult, FsPort, Log, RunningContainer, StackRegistryPort } from '../src/ports.js';
import { applyRewrite, planRewrite } from '../src/rewrite.js';
import {
  STACK_COMPOSE_TIMEOUT_MS,
  recoverInterruptedStackUpdates,
  resolveTrack,
  runStackUpdate,
  stackImageTags,
  stackRunningDigests,
  tagOfReference,
  wouldGoBackwards,
  type StackUpdateContext,
  type StackUpdatePorts,
} from '../src/stack-update.js';
import type { JournalEntry } from '../src/types.js';

// SHP-ADR-010, SHP-REQ-194..198: a stack update re-resolves its track, fails closed, journals
// each step before it runs, backs up, pulls by digest, rewrites only the image line, recreates
// only the service, waits for health, soaks, records — and rolls back image-only on failure.

const d = (c: string): string => `sha256:${c.repeat(64)}`;
const OLD = d('1');
const NEW = d('2');
const NEWER = d('3');
const DB_OLD = d('4');
const DB_NEW = d('5');

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const COMPOSE = `# hand-owned, keep every byte
services:
  web:
    image: lscr.io/linuxserver/sonarr:latest # the app
    restart: unless-stopped
  db:
    image: "postgres:16"
    volumes: [db:/var/lib/postgresql/data]
  cache:
    image: redis@${d('6')}
volumes:
  db: {}
`;

interface Knobs {
  registryDown: boolean;
  /** image → tag → digest. */
  tags: Map<string, Map<string, string>>;
  /** digest → container health once it runs. */
  health: Map<string, RunningContainer['health']>;
  pullExit: number;
  upExits: number[];
  backupExit: number;
  /** Restart the web container after this many soak looks. */
  restartWebAfterLooks: number | null;
  /** HTTP probe status. */
  probeStatus: number;
  local: Set<string>;
}

interface World {
  root: string;
  dataRoot: string;
  composePath: string;
  artifactsDir: string;
  events: string[];
  steps: StackUpdateStep[];
  pulls: string[];
  composeCalls: string[][];
  /** The timeout each compose call was given. */
  composeTimeouts: (number | undefined)[];
  running: Map<string, { repo: string; digest: string; startedAt: string; restartCount: number }>;
  knobs: Knobs;
  ports: StackUpdatePorts;
  ctx: StackUpdateContext;
  ledger: Ledger;
  journal: Journal;
  registryCalls: string[];
}

function makeLog(): Log {
  const log: Log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return log;
}

function makeClock(): Clock {
  let now = Date.now();
  return {
    now: () => new Date(now),
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

function exec(exitCode: number, stdout = ''): Promise<ExecResult> {
  return Promise.resolve({ exitCode, stdout, stderr: '' });
}

interface WorldOptions {
  manifest?: Record<string, unknown>;
  compose?: string;
}

async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'shp-stack-update-'));
  roots.push(root);
  const dataRoot = join(root, 'data');
  const artifactsDir = join(root, 'backups');
  await mkdir(join(dataRoot, 'agent'), { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  const composePath = join(root, 'compose.yml');
  await writeFile(composePath, options.compose ?? COMPOSE, 'utf8');

  const knobs: Knobs = {
    registryDown: false,
    tags: new Map([
      ['lscr.io/linuxserver/sonarr', new Map([['latest', NEW]])],
      ['postgres', new Map([['16', DB_OLD], ['16.3', DB_OLD], ['16.4', DB_NEW], ['16.4-alpine', d('7')], ['17.0', d('8')]])],
    ]),
    health: new Map(),
    pullExit: 0,
    upExits: [],
    backupExit: 0,
    restartWebAfterLooks: null,
    probeStatus: 200,
    local: new Set(),
  };
  const events: string[] = [];
  const steps: StackUpdateStep[] = [];
  const pulls: string[] = [];
  const composeCalls: string[][] = [];
  const composeTimeouts: (number | undefined)[] = [];
  const registryCalls: string[] = [];
  const running = new Map([
    ['web', { repo: 'lscr.io/linuxserver/sonarr', digest: OLD, startedAt: 's0', restartCount: 0 }],
    ['db', { repo: 'postgres', digest: DB_OLD, startedAt: 's0', restartCount: 0 }],
  ]);
  let starts = 0;
  let looks = 0;

  const clock = makeClock();
  const realFs = nodeFs();
  const fs: FsPort = {
    ...realFs,
    appendLine: async (path, line) => {
      if (path.endsWith('journal.jsonl')) {
        const entry = JSON.parse(line) as JournalEntry;
        events.push(`journal:${entry.phase}:${entry.step}`);
      } else if (path.endsWith('ledger.jsonl')) {
        events.push('ledger');
      }
      await realFs.appendLine(path, line);
    },
  };

  const registry: StackRegistryPort = {
    resolveDigest: (image, tag) => {
      registryCalls.push(`resolve ${image}:${tag}`);
      if (knobs.registryDown) return Promise.reject(new RegistryError('unreachable', `${image}: registry unreachable (fetch failed)`));
      return Promise.resolve((knobs.tags.get(image)?.get(tag) ?? null) as never);
    },
    listTags: (image) => {
      registryCalls.push(`tags ${image}`);
      if (knobs.registryDown) return Promise.reject(new RegistryError('unreachable', `${image}: registry unreachable`));
      return Promise.resolve([...(knobs.tags.get(image)?.keys() ?? [])]);
    },
  };

  const docker: DockerPort = {
    async compose(_target, args, opts) {
      composeCalls.push(args);
      composeTimeouts.push(opts?.timeoutMs);
      events.push(`compose:${args[0] ?? ''}`);
      if (args[0] === 'exec') {
        if (knobs.backupExit === 0) {
          // Written "now" by the engine's clock, which the soaks before have moved on.
          const path = join(artifactsDir, `dump-${String(clock.now().getTime())}.sql`);
          await writeFile(path, 'data', 'utf8');
          await utimes(path, clock.now(), clock.now());
        }
        return exec(knobs.backupExit);
      }
      if (args[0] === 'up') {
        const code = knobs.upExits.shift() ?? 0;
        if (code !== 0) return exec(code);
        const text = await readFile(composePath, 'utf8');
        for (const service of args.filter((a, i) => i > 5)) {
          const line = new RegExp(`\\n  ${service}:\\n    image: "?([^\\s"]+)`).exec(text)?.[1] ?? '';
          // A line with no digest runs what its tag named locally before: the original image.
          const digest = /@(sha256:[0-9a-f]{64})/.exec(line)?.[1] ?? (service === 'web' ? OLD : service === 'db' ? DB_OLD : undefined);
          if (digest === undefined) continue;
          const was = running.get(service);
          if (was?.digest !== digest) running.set(service, { repo: was?.repo ?? '', digest, startedAt: `s${String(++starts)}`, restartCount: 0 });
        }
      }
      return exec(0);
    },
    containers(_target, service) {
      looks += 1;
      if (knobs.restartWebAfterLooks !== null && looks > knobs.restartWebAfterLooks) {
        const web = running.get('web');
        if (web !== undefined && web.digest !== OLD) running.set('web', { ...web, restartCount: 1 });
      }
      const list: RunningContainer[] = [...running.entries()]
        .filter(([svc]) => service === undefined || svc === service)
        .map(([svc, c]) => ({
          id: `c-${svc}-${c.startedAt}`,
          service: svc,
          repoDigests: [`${c.repo}@${c.digest}`],
          labels: {},
          state: 'running',
          networks: ['stack_default'],
          startedAt: c.startedAt,
          restartCount: c.restartCount,
          health: knobs.health.get(c.digest) ?? 'none',
        }));
      return Promise.resolve(list);
    },
    probeHealth: () => Promise.resolve({ httpStatus: knobs.probeStatus, body: 'ok' }),
    freeBytes: () => Promise.resolve(1e12),
    images: (repo) =>
      Promise.resolve(
        [...knobs.local].filter((ref) => ref.startsWith(`${repo}@`)).map((ref) => ({ id: ref, repoTags: [], repoDigests: [ref], created: 0, size: 1 })),
      ),
    removeImage: () => Promise.resolve(),
    pullImage: (ref) => {
      pulls.push(ref);
      events.push(`pull:${ref}`);
      return exec(knobs.pullExit, 'pulled');
    },
  };

  const manifest = StackManifest.parse({
    kind: 'stack',
    name: 'media',
    compose: { files: [composePath], project: 'media' },
    updates: 'digest',
    services: {
      web: { image: 'lscr.io/linuxserver/sonarr', track: { tag: 'latest' } },
      db: { image: 'postgres', track: { semver: '16.x' } },
      cache: { image: 'redis', track: 'pinned' },
    },
    steps: { backup: { service: 'db', argv: ['pg_dumpall', '-f', '/backups/x.sql'], artifactsDir } },
    soakSeconds: 3,
    ...options.manifest,
  });
  const stacks: LoadedStacks = new Map([['media', { manifest, file: join(dataRoot, 'stacks', 'media.yml'), sha256: 'x'.repeat(64) }]]);
  const log = makeLog();
  const ports: StackUpdatePorts = { registry, docker, fs, clock, log };
  const journal = new Journal(fs, join(dataRoot, 'agent', 'journal.jsonl'), clock, log);
  const ledger = await Ledger.open(fs, join(dataRoot, 'agent', 'ledger.jsonl'));
  const ctx: StackUpdateContext = {
    dataRoot,
    stacks,
    journal,
    ledger,
    historyDir: join(dataRoot, 'agent', 'history'),
    onStep: (step) => steps.push(step),
    healthTimeoutMs: 10_000,
    checkIntervalMs: 1_000,
    soakIntervalMs: 1_000,
    probeTimeoutMs: 1_000,
  };
  return { root, dataRoot, composePath, artifactsDir, events, steps, pulls, composeCalls, composeTimeouts, running, knobs, ports, ctx, ledger, journal, registryCalls };
}

let ids = 0;
function uuid(): string {
  ids += 1;
  return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`;
}

function update(digests: Record<string, string>, updateId = uuid()): StackUpdateJob {
  return { updateId, kind: 'update', stack: 'media', digests, requesterLabel: 'test' };
}

describe('resolveTrack and running digests', () => {
  it('a tag track resolves the tag; a semver track picks the highest tag in range; pinned asks nothing', async () => {
    const w = await makeWorld();
    await expect(resolveTrack(w.ports.registry, 'lscr.io/linuxserver/sonarr', { tag: 'latest' })).resolves.toEqual({ kind: 'resolved', tag: 'latest', digest: NEW });
    await expect(resolveTrack(w.ports.registry, 'postgres', { semver: '16.x' })).resolves.toEqual({ kind: 'resolved', tag: '16.4', digest: DB_NEW });
    await expect(resolveTrack(w.ports.registry, 'postgres', { semver: '18.x' })).resolves.toMatchObject({ kind: 'missing' });
    await expect(resolveTrack(w.ports.registry, 'postgres', { tag: 'gone' })).resolves.toMatchObject({ kind: 'missing' });
    w.registryCalls.length = 0;
    await expect(resolveTrack(w.ports.registry, 'redis', 'pinned')).resolves.toEqual({ kind: 'pinned' });
    expect(w.registryCalls).toEqual([]);
    w.knobs.registryDown = true;
    await expect(resolveTrack(w.ports.registry, 'postgres', { tag: '16' })).rejects.toBeInstanceOf(RegistryError);
  });

  it('a semver range it cannot read is "missing", not a crash', async () => {
    const w = await makeWorld();
    await expect(resolveTrack(w.ports.registry, 'postgres', { semver: '>=1.2.3.4' })).resolves.toMatchObject({ kind: 'missing', why: expect.stringContaining('semver range') as unknown });
  });

  it('wouldGoBackwards: only a semver track, only between two versions', () => {
    expect(wouldGoBackwards({ semver: '16.x' }, '17.0', '16.4')).toBe(true);
    expect(wouldGoBackwards({ semver: '16.x' }, '16.3', '16.4')).toBe(false);
    expect(wouldGoBackwards({ semver: '16.x' }, '16.4', '16.4')).toBe(false);
    expect(wouldGoBackwards({ semver: '16.x' }, 'latest', '16.4')).toBe(false);
    expect(wouldGoBackwards({ semver: '16.x' }, null, '16.4')).toBe(false);
    expect(wouldGoBackwards({ tag: '16' }, '17.0', '16')).toBe(false);
    expect(wouldGoBackwards('pinned', '17.0', '16')).toBe(false);
  });

  it("stackImageTags reads each service's tag from its literal image line", async () => {
    const w = await makeWorld();
    await expect(stackImageTags(w.ports.fs, { files: [w.composePath], project: 'media' }, ['web', 'db', 'cache', 'nope'])).resolves.toEqual({
      web: 'latest',
      db: '16',
      cache: null,
      nope: null,
    });
  });

  it('reads running digests across Docker Hub spellings', async () => {
    const w = await makeWorld();
    w.running.set('db', { repo: 'postgres', digest: DB_OLD, startedAt: 's0', restartCount: 0 });
    const got = await stackRunningDigests(w.ports.docker, { files: [w.composePath], project: 'media' }, {
      db: { image: 'docker.io/library/postgres' },
      web: { image: 'lscr.io/linuxserver/sonarr' },
      cache: { image: 'redis' },
    });
    expect(got).toEqual({ db: DB_OLD, web: OLD, cache: null });
  });

  it('tagOfReference reads a tag, never a registry port', () => {
    expect(tagOfReference('postgres:16')).toBe('16');
    expect(tagOfReference('postgres:16@sha256:abc')).toBe('16');
    expect(tagOfReference('registry:5000/x/y')).toBeNull();
    expect(tagOfReference('registry:5000/x/y:1.0')).toBe('1.0');
    expect(tagOfReference(`redis@${OLD}`)).toBeNull();
  });
});

describe('runStackUpdate: an update', () => {
  it('journals, backs up, pulls by digest, rewrites the line, recreates only the service, checks, soaks and records — in that order', async () => {
    const w = await makeWorld();
    const job = update({ web: NEW });
    const result = await runStackUpdate(w.ports, w.ctx, job);

    expect(result).toMatchObject({
      updateId: job.updateId,
      state: 'succeeded',
      images: [{ service: 'web', tag: 'latest', digest: NEW }],
      previous: [{ service: 'web', tag: 'latest', digest: OLD }],
    });
    expect(result.backupArtifact?.path).toMatch(/dump-\d+\.sql$/);
    expect(w.steps).toEqual(['verifying', 'backing_up', 'pulling', 'swapping', 'checking', 'soaking']);
    expect(w.events).toEqual([
      'journal:start:stack-update',
      'journal:start:stack-update:verify',
      'journal:end:stack-update:verify',
      'journal:start:stack-update:backup',
      'compose:exec',
      'journal:end:stack-update:backup',
      // The track re-resolved right before the pull (SHP-REQ-195).
      'journal:start:stack-update:reverify',
      'journal:end:stack-update:reverify',
      'journal:start:stack-update:pull',
      `pull:lscr.io/linuxserver/sonarr@${NEW}`,
      'journal:end:stack-update:pull',
      'journal:start:stack-update:swap',
      'compose:up',
      'journal:end:stack-update:swap',
      'journal:start:stack-update:check',
      'journal:end:stack-update:check',
      'journal:start:stack-update:soak',
      'journal:end:stack-update:soak',
      'ledger',
      'journal:end:stack-update',
    ]);
    // Only the image line changed, and only that service was recreated.
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE.replace('sonarr:latest #', `sonarr:latest@${NEW} #`));
    expect(w.composeCalls.find((a) => a[0] === 'up')).toEqual(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'web']);
    // The previous file is kept under the update's ID.
    const history = JSON.parse(await readFile(join(w.ctx.historyDir, job.updateId, 'manifest.json'), 'utf8')) as { files: { copy: string }[] };
    expect(await readFile(history.files[0]?.copy ?? '', 'utf8')).toBe(COMPOSE);
    // A stack ledger entry, invisible to every app reader.
    expect(w.ledger.stackUpdate('media', job.updateId)).toMatchObject({ kind: 'stack-update', updateKind: 'update', images: [{ service: 'web', repo: 'lscr.io/linuxserver/sonarr', tag: 'latest', digest: NEW }] });
    expect(w.ledger.entries('media')).toEqual([]);
    expect(w.ledger.recent('media')).toEqual([]);
    expect(w.ledger.backupArtifacts('media')).toEqual([]);
    expect(w.ledger.knownDigests('media').size).toBe(0);
    // The backup's output was never journaled.
    const journal = await w.journal.readAll();
    expect(journal.find((e) => e.step === 'stack-update:backup' && e.phase === 'end')?.output).toBeUndefined();
    expect(await w.journal.unfinished()).toEqual([]);
    expect(await w.journal.unfinishedStackUpdates()).toEqual([]);
  });

  it('a semver track writes the picked tag beside the digest, keeping the quotes', async () => {
    const w = await makeWorld({ manifest: { steps: undefined } });
    const result = await runStackUpdate(w.ports, w.ctx, update({ db: DB_NEW }));
    expect(result).toMatchObject({ state: 'succeeded', images: [{ service: 'db', tag: '16.4', digest: DB_NEW }], previous: [{ service: 'db', tag: '16', digest: DB_OLD }] });
    expect(await readFile(w.composePath, 'utf8')).toContain(`    image: "postgres:16.4@${DB_NEW}"\n`);
    expect(w.steps).not.toContain('backing_up');
  });

  it('skips the pull when the digest is already local', async () => {
    const w = await makeWorld();
    w.knobs.local.add(`lscr.io/linuxserver/sonarr@${NEW}`);
    await expect(runStackUpdate(w.ports, w.ctx, update({ web: NEW }))).resolves.toMatchObject({ state: 'succeeded' });
    expect(w.pulls).toEqual([]);
  });

  it('waits for a container healthcheck to say healthy', async () => {
    const w = await makeWorld();
    let looks = 0;
    const containers = w.ports.docker.containers.bind(w.ports.docker);
    w.ports.docker.containers = async (target, service) => {
      const list = await containers(target, service);
      looks += 1;
      return list.map((c) => (c.repoDigests[0]?.endsWith(NEW) === true ? { ...c, health: looks < 4 ? 'starting' : 'healthy' } : c));
    };
    await expect(runStackUpdate(w.ports, w.ctx, update({ web: NEW }))).resolves.toMatchObject({ state: 'succeeded' });
    expect(looks).toBeGreaterThanOrEqual(4);
  });
});

describe('runStackUpdate: refusals change nothing', () => {
  async function expectUntouched(w: World): Promise<void> {
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    expect(w.pulls).toEqual([]);
    expect(w.composeCalls.filter((a) => a[0] === 'up' || a[0] === 'exec')).toEqual([]);
    expect(w.running.get('web')?.digest).toBe(OLD);
  }

  it('digest_not_tracked: the track resolves to another digest now (SHP-REQ-195)', async () => {
    const w = await makeWorld();
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEWER }));
    expect(result).toMatchObject({ state: 'refused', refusal: { code: 'digest_not_tracked' } });
    expect(result.refusal?.message).toContain(NEW);
    await expectUntouched(w);
    // Journaled: the bracket and verify, then closed refused.
    expect(w.events).toEqual(['journal:start:stack-update', 'journal:start:stack-update:verify', 'journal:end:stack-update:verify', 'journal:end:stack-update']);
  });

  it('digest_not_tracked: a pinned service, an untracked service, a track that resolves to nothing', async () => {
    const w = await makeWorld();
    await expect(runStackUpdate(w.ports, w.ctx, update({ cache: d('6') }))).resolves.toMatchObject({ refusal: { code: 'digest_not_tracked', message: expect.stringContaining('pinned') as unknown } });
    await expect(runStackUpdate(w.ports, w.ctx, update({ other: NEW }))).resolves.toMatchObject({ refusal: { code: 'digest_not_tracked' } });
    w.knobs.tags.get('lscr.io/linuxserver/sonarr')?.delete('latest');
    await expect(runStackUpdate(w.ports, w.ctx, update({ web: NEW }))).resolves.toMatchObject({ refusal: { code: 'digest_not_tracked' } });
    await expectUntouched(w);
  });

  it('registry_unreachable: fails closed when the registry cannot answer (SHP-REQ-196)', async () => {
    const w = await makeWorld();
    w.knobs.registryDown = true;
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    expect(result).toMatchObject({ state: 'refused', refusal: { code: 'registry_unreachable' } });
    await expectUntouched(w);
  });

  it('registry_unreachable: a registry whose answer stalls mid-body, through the real OCI adapter', async () => {
    const w = await makeWorld();
    const stalled: typeof fetch = () => Promise.resolve(new Response(new ReadableStream({ start: () => undefined }), { status: 200 }));
    w.ports.registry = createOciRegistry({ fetch: stalled, timeoutMs: 50 });
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    expect(result).toMatchObject({ state: 'refused', refusal: { code: 'registry_unreachable', message: expect.stringContaining('timed out') as unknown } });
    await expectUntouched(w);
  });

  it('updates_disabled: a lifecycle-only stack', async () => {
    const w = await makeWorld();
    const stack = w.ctx.stacks.get('media');
    if (stack === undefined) throw new Error('no stack');
    w.ctx.stacks.set('media', { ...stack, manifest: StackManifest.parse({ kind: 'stack', name: 'media', compose: stack.manifest.compose }) });
    await expect(runStackUpdate(w.ports, w.ctx, update({ web: NEW }))).resolves.toMatchObject({ state: 'refused', refusal: { code: 'updates_disabled' } });
    await expectUntouched(w);
    expect(w.events).toEqual([]);
  });

  it('not_adopted: no such stack', async () => {
    const w = await makeWorld();
    await expect(runStackUpdate(w.ports, w.ctx, { ...update({ web: NEW }), stack: 'nope' })).resolves.toMatchObject({ refusal: { code: 'not_adopted' } });
  });

  it("locked: a deploy or action holds the stack's lock, or the agent says it is busy", async () => {
    const w = await makeWorld();
    const held = await AppLock.acquire(w.dataRoot, 'media', { pid: 1, deployId: 'action-1', requesterLabel: 'someone', sha: '', step: 'action restart', at: new Date().toISOString() });
    if (!(held instanceof AppLock)) throw new Error('could not take the lock');
    try {
      await expect(runStackUpdate(w.ports, w.ctx, update({ web: NEW }))).resolves.toMatchObject({ state: 'refused', refusal: { code: 'locked' } });
    } finally {
      await held.release();
    }
    w.ctx.busy = () => true;
    await expect(runStackUpdate(w.ports, w.ctx, update({ web: NEW }))).resolves.toMatchObject({ state: 'refused', refusal: { code: 'locked' } });
    await expectUntouched(w);
  });

  it('image_line_invalid: an interpolated image line, or another repository', async () => {
    const w = await makeWorld({ compose: COMPOSE.replace('lscr.io/linuxserver/sonarr:latest', '${SONARR_IMAGE}') });
    await expect(runStackUpdate(w.ports, w.ctx, update({ web: NEW }))).resolves.toMatchObject({ state: 'refused', refusal: { code: 'image_line_invalid' } });
    expect(w.pulls).toEqual([]);
    const other = await makeWorld({ compose: COMPOSE.replace('lscr.io/linuxserver/sonarr:latest', 'ghcr.io/someone/else:latest') });
    await expect(runStackUpdate(other.ports, other.ctx, update({ web: NEW }))).resolves.toMatchObject({ refusal: { code: 'image_line_invalid' } });
    expect(other.composeCalls.filter((a) => a[0] === 'exec')).toEqual([]);
  });

  it('backup_failed stops before any change', async () => {
    const w = await makeWorld();
    w.knobs.backupExit = 1;
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'backup_failed' } });
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    expect(w.pulls).toEqual([]);
    expect(w.composeCalls.filter((a) => a[0] === 'up')).toEqual([]);
  });

  // SHP-ADR-012: volumeBackups.beforeUpdate — after the stack's own backup, before the pull.
  it('beforeUpdate backs the volumes up after the backup step and before the pull', async () => {
    const w = await makeWorld({ manifest: { volumeBackups: { beforeUpdate: true } } });
    const calls: string[] = [];
    w.ctx.backupVolumes = (stack, updateId) => {
      calls.push(`${stack} ${updateId}`);
      w.events.push('volume-backup');
      return Promise.resolve(null);
    };
    const job = update({ web: NEW });
    const result = await runStackUpdate(w.ports, w.ctx, job);
    expect(result.state).toBe('succeeded');
    expect(calls).toEqual([`media ${job.updateId}`]);
    const at = (e: string): number => w.events.indexOf(e);
    expect(at('compose:exec')).toBeLessThan(at('volume-backup'));
    expect(at('journal:start:stack-update:volume-backup')).toBeLessThan(at('volume-backup'));
    expect(at('volume-backup')).toBeLessThan(at(`pull:lscr.io/linuxserver/sonarr@${NEW}`));
  });

  it('beforeUpdate: a failed volume backup fails the update before any change', async () => {
    const w = await makeWorld({ manifest: { volumeBackups: { beforeUpdate: true } } });
    w.ctx.backupVolumes = () => Promise.resolve({ code: 'volume_not_owned', gate: 'none', message: 'no container mounts it', fix: 'x' });
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'backup_failed', message: expect.stringContaining('no container mounts it') as unknown } });
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    expect(w.pulls).toEqual([]);
    expect(w.composeCalls.filter((a) => a[0] === 'up')).toEqual([]);
  });

  it('beforeUpdate with no way to back volumes up fails closed; without beforeUpdate the hook is never called', async () => {
    const w = await makeWorld({ manifest: { volumeBackups: { beforeUpdate: true } } });
    await expect(runStackUpdate(w.ports, w.ctx, update({ web: NEW }))).resolves.toMatchObject({ state: 'failed', refusal: { code: 'backup_failed' } });
    expect(w.pulls).toEqual([]);
    const other = await makeWorld({ manifest: { volumeBackups: { beforeUpdate: false } } });
    const hook = vi.fn(() => Promise.resolve(null));
    other.ctx.backupVolumes = hook;
    await expect(runStackUpdate(other.ports, other.ctx, update({ web: NEW }))).resolves.toMatchObject({ state: 'succeeded' });
    expect(hook).not.toHaveBeenCalled();
  });

  it('a failed pull stops before any change', async () => {
    const w = await makeWorld();
    w.knobs.pullExit = 1;
    await expect(runStackUpdate(w.ports, w.ctx, update({ web: NEW }))).resolves.toMatchObject({ state: 'failed', refusal: { code: 'step_failed' } });
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    expect(w.composeCalls.filter((a) => a[0] === 'up')).toEqual([]);
  });
});

describe('runStackUpdate: failure after the swap rolls back image-only (SHP-REQ-198)', () => {
  it('an unhealthy container restores the previous line and digest', async () => {
    const w = await makeWorld();
    w.knobs.health.set(NEW, 'unhealthy');
    const job = update({ web: NEW });
    const result = await runStackUpdate(w.ports, w.ctx, job);
    expect(result).toMatchObject({
      state: 'rolled_back',
      refusal: { code: 'health_failed' },
      images: [{ service: 'web', tag: 'latest', digest: OLD }],
      previous: [{ service: 'web', tag: 'latest', digest: OLD }],
    });
    expect(result.backupArtifact).toBeDefined();
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    expect(w.steps.at(-1)).toBe('rolling_back');
    expect(w.composeCalls.filter((a) => a[0] === 'up')).toEqual([
      ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'web'],
      ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'web'],
    ]);
    expect(w.ledger.stackUpdate('media', job.updateId)).toBeNull();
    expect(w.events.slice(w.events.indexOf('journal:end:stack-update:check'))).toEqual([
      'journal:end:stack-update:check',
      'journal:start:stack-update:rollback',
      'compose:up',
      'journal:end:stack-update:rollback',
      'journal:end:stack-update',
    ]);
  });

  it('the stack HTTP check failing rolls back', async () => {
    const w = await makeWorld({ manifest: { health: { service: 'web', port: 8989, path: '/ping' } } });
    w.knobs.probeStatus = 503;
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    // The old version answers 503 too here, so the rollback cannot confirm health: failed, said plainly.
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'health_failed' } });
    expect(result.refusal?.message).toContain('Rolling back failed too');
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
  });

  it('a restart during the soak rolls back', async () => {
    const w = await makeWorld();
    w.knobs.restartWebAfterLooks = 6;
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    expect(result).toMatchObject({ state: 'rolled_back', refusal: { code: 'health_failed', message: expect.stringContaining('soak') as unknown } });
    expect(w.running.get('web')?.digest).toBe(OLD);
  });

  it('compose up failing rolls back', async () => {
    const w = await makeWorld();
    w.knobs.upExits = [1];
    await expect(runStackUpdate(w.ports, w.ctx, update({ web: NEW }))).resolves.toMatchObject({ state: 'rolled_back', refusal: { code: 'step_failed' } });
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
  });
});

describe('runStackUpdate: a rollback job', () => {
  it("restores an earlier update's digests from the agent's own ledger, without the registry or a backup", async () => {
    const w = await makeWorld();
    const first = update({ web: NEW });
    await expect(runStackUpdate(w.ports, w.ctx, first)).resolves.toMatchObject({ state: 'succeeded' });
    w.knobs.tags.get('lscr.io/linuxserver/sonarr')?.set('latest', NEWER);
    await expect(runStackUpdate(w.ports, w.ctx, update({ web: NEWER }))).resolves.toMatchObject({ state: 'succeeded' });
    expect(w.running.get('web')?.digest).toBe(NEWER);

    w.knobs.registryDown = true;
    w.registryCalls.length = 0;
    w.steps.length = 0;
    const backups = w.composeCalls.filter((a) => a[0] === 'exec').length;
    w.knobs.local.add(`lscr.io/linuxserver/sonarr@${NEW}`);
    const rollback: StackUpdateJob = { updateId: uuid(), kind: 'rollback', stack: 'media', toUpdateId: first.updateId };
    const result = await runStackUpdate(w.ports, w.ctx, rollback);
    expect(result).toMatchObject({ state: 'succeeded', images: [{ service: 'web', tag: 'latest', digest: NEW }], previous: [{ service: 'web', tag: 'latest', digest: NEWER }] });
    expect(w.registryCalls).toEqual([]);
    expect(w.composeCalls.filter((a) => a[0] === 'exec')).toHaveLength(backups);
    expect(w.steps).toEqual(['verifying', 'pulling', 'swapping', 'checking', 'soaking']);
    expect(await readFile(w.composePath, 'utf8')).toContain(`sonarr:latest@${NEW} #`);
    expect(w.ledger.stackUpdate('media', rollback.updateId)).toMatchObject({ updateKind: 'rollback' });
  });

  it('rollback_target_invalid when the ledger has no such update — never trusting the request', async () => {
    const w = await makeWorld();
    const result = await runStackUpdate(w.ports, w.ctx, { updateId: uuid(), kind: 'rollback', stack: 'media', toUpdateId: uuid() });
    expect(result).toMatchObject({ state: 'refused', refusal: { code: 'rollback_target_invalid' } });
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
  });
});

describe('restart recovery', () => {
  it('puts the previous compose file back for an update interrupted after its swap, and closes it', async () => {
    const w = await makeWorld();
    const job = update({ web: NEW });
    // Interrupted mid-check: once the service is recreated, the check never returns.
    let swapped = false;
    const compose = w.ports.docker.compose.bind(w.ports.docker);
    const containers = w.ports.docker.containers.bind(w.ports.docker);
    w.ports.docker.compose = async (target, args, opts) => {
      const res = await compose(target, args, opts);
      if (args[0] === 'up') swapped = true;
      return res;
    };
    w.ports.docker.containers = (target, service) => (swapped ? new Promise<never>(() => undefined) : containers(target, service));
    const running = runStackUpdate(w.ports, w.ctx, job);
    await vi.waitFor(async () => {
      expect((await w.journal.readAll()).some((e) => e.step === 'stack-update:check')).toBe(true);
    });
    void running;
    expect(await readFile(w.composePath, 'utf8')).toContain(`@${NEW}`);
    const [open] = await w.journal.unfinishedStackUpdates();
    expect(open).toMatchObject({ updateId: job.updateId, stack: 'media', swapped: true, lastStep: 'stack-update:check' });
    expect(await w.journal.unfinished()).toEqual([]);

    const ups: string[][] = [];
    const docker: DockerPort = { ...w.ports.docker, compose: (_t, args) => (ups.push(args), exec(0)) };
    const results = await recoverInterruptedStackUpdates({ fs: w.ports.fs, docker, log: w.ports.log }, w.journal, { historyDir: w.ctx.historyDir, ledger: w.ledger });
    expect(results).toMatchObject([{ updateId: job.updateId, succeeded: false, restored: [w.composePath] }]);
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    expect(ups).toEqual([['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'web']]);
    expect(await w.journal.unfinishedStackUpdates()).toEqual([]);
  });
});

describe('runStackUpdate: a semver track never goes backwards (SHP-REQ-195)', () => {
  it('refuses when the image line names a higher version than the track resolves to', async () => {
    const w = await makeWorld({ compose: COMPOSE.replace('"postgres:16"', '"postgres:17.0"'), manifest: { steps: undefined } });
    const result = await runStackUpdate(w.ports, w.ctx, update({ db: DB_NEW }));
    expect(result).toMatchObject({ state: 'refused', refusal: { code: 'digest_not_tracked', message: expect.stringContaining('backwards') as unknown } });
    expect(await readFile(w.composePath, 'utf8')).toContain('"postgres:17.0"');
    expect(w.pulls).toEqual([]);
  });

  it('a running tag that is not a version keeps the update', async () => {
    const w = await makeWorld({ compose: COMPOSE.replace('"postgres:16"', '"postgres:latest"'), manifest: { steps: undefined } });
    await expect(runStackUpdate(w.ports, w.ctx, update({ db: DB_NEW }))).resolves.toMatchObject({ state: 'succeeded', images: [{ service: 'db', tag: '16.4' }] });
  });
});

describe('runStackUpdate: what changes between verify and the write', () => {
  it('re-resolves the track after the backup: a tag that moved meanwhile is refused before the pull', async () => {
    const w = await makeWorld();
    const compose = w.ports.docker.compose.bind(w.ports.docker);
    w.ports.docker.compose = async (target, args, opts) => {
      const res = await compose(target, args, opts);
      if (args[0] === 'exec') w.knobs.tags.get('lscr.io/linuxserver/sonarr')?.set('latest', NEWER);
      return res;
    };
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'digest_not_tracked', message: expect.stringContaining('moved') as unknown } });
    expect(result.backupArtifact).toBeDefined();
    expect(w.pulls).toEqual([]);
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    expect(w.composeCalls.filter((a) => a[0] === 'up')).toEqual([]);
  });

  it('re-resolving fails closed when the registry stops answering', async () => {
    const w = await makeWorld({ manifest: { steps: undefined } });
    let resolves = 0;
    const resolveDigest = w.ports.registry.resolveDigest.bind(w.ports.registry);
    w.ports.registry.resolveDigest = (image, tag) => {
      resolves += 1;
      if (resolves > 1) w.knobs.registryDown = true;
      return resolveDigest(image, tag);
    };
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    // No backup ran, so nothing at all happened: refused.
    expect(result).toMatchObject({ state: 'refused', refusal: { code: 'registry_unreachable' } });
    expect(w.pulls).toEqual([]);
  });

  it('a compose file edited after verify is not overwritten: conflict, no write, nothing recreated', async () => {
    const w = await makeWorld();
    const edited = COMPOSE.replace('restart: unless-stopped', 'restart: always');
    const pullImage = w.ports.docker.pullImage?.bind(w.ports.docker);
    w.ports.docker.pullImage = async (ref) => {
      await writeFile(w.composePath, edited, 'utf8');
      return pullImage === undefined ? exec(1) : pullImage(ref);
    };
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'conflict' } });
    expect(await readFile(w.composePath, 'utf8')).toBe(edited);
    expect(w.composeCalls.filter((a) => a[0] === 'up')).toEqual([]);
    expect(await w.journal.unfinishedStackUpdates()).toEqual([]);
  });

  it('refuses to pull with a Docker adapter that cannot pull by digest', async () => {
    const w = await makeWorld();
    delete w.ports.docker.pullImage;
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'step_failed', message: expect.stringContaining('cannot pull') as unknown } });
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
  });

  it('a rewrite that cannot be written changes nothing and closes the update', async () => {
    const w = await makeWorld();
    const write = w.ports.fs.writeFileAtomic.bind(w.ports.fs);
    w.ports.fs.writeFileAtomic = (path, text) => (path === w.composePath ? Promise.reject(new Error('read-only file system')) : write(path, text));
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'step_failed', message: expect.stringContaining('read-only') as unknown } });
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    expect(w.composeCalls.filter((a) => a[0] === 'up')).toEqual([]);
    expect(await w.journal.unfinishedStackUpdates()).toEqual([]);
  });

  it('compose up in the swap and the rollback runs under a timeout', async () => {
    const w = await makeWorld();
    w.knobs.health.set(NEW, 'unhealthy');
    w.ctx.composeTimeoutMs = 42_000;
    await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    const ups = w.composeCalls.map((a, i) => [a[0], w.composeTimeouts[i]]).filter(([verb]) => verb === 'up');
    expect(ups).toEqual([
      ['up', 42_000],
      ['up', 42_000],
    ]);
    expect(STACK_COMPOSE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('runStackUpdate: a throw after the swap rolls back (SHP-REQ-198)', () => {
  it('a journal that throws once the service is recreated: the previous line comes back', async () => {
    const w = await makeWorld();
    const begin = w.journal.begin.bind(w.journal);
    w.journal.begin = (entry) => (entry.step === 'stack-update:check' ? Promise.reject(new Error('disk full')) : begin(entry));
    const job = update({ web: NEW });
    const result = await runStackUpdate(w.ports, w.ctx, job);
    expect(result).toMatchObject({ state: 'rolled_back', refusal: { code: 'step_failed', message: expect.stringContaining('disk full') as unknown }, images: [{ service: 'web', digest: OLD }] });
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    expect(w.running.get('web')?.digest).toBe(OLD);
    expect(w.composeCalls.filter((a) => a[0] === 'up')).toHaveLength(2);
    expect(w.ledger.stackUpdate('media', job.updateId)).toBeNull();
    expect(await w.journal.unfinishedStackUpdates()).toEqual([]);
  });

  it('a ledger that cannot record the success: not a success, rolled back', async () => {
    const w = await makeWorld();
    w.ledger.append = () => Promise.reject(new Error('ledger chain broken'));
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    expect(result).toMatchObject({ state: 'rolled_back', refusal: { code: 'step_failed', message: expect.stringContaining('ledger chain broken') as unknown } });
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    expect(w.running.get('web')?.digest).toBe(OLD);
  });

  it('a lock that cannot be written mid-check still rolls back', async () => {
    const w = await makeWorld();
    const original = Object.getOwnPropertyDescriptor(AppLock.prototype, 'setStep')?.value as (this: AppLock, step: string) => Promise<void>;
    const spy = vi.spyOn(AppLock.prototype, 'setStep').mockImplementation(function (this: AppLock, step: string) {
      return step === 'stack check' ? Promise.reject(new Error('lock file gone')) : original.call(this, step);
    });
    try {
      const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
      expect(result).toMatchObject({ state: 'rolled_back', refusal: { message: expect.stringContaining('lock file gone') as unknown } });
      expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    } finally {
      spy.mockRestore();
    }
  });

  it('a hand edit made during the soak is kept: only the image line is put back', async () => {
    const w = await makeWorld();
    w.knobs.restartWebAfterLooks = 6;
    const containers = w.ports.docker.containers.bind(w.ports.docker);
    let edited = false;
    w.ports.docker.containers = async (target, service) => {
      if (!edited && w.steps.includes('soaking')) {
        edited = true;
        const text = await readFile(w.composePath, 'utf8');
        await writeFile(w.composePath, text.replace('restart: unless-stopped', 'restart: always'), 'utf8');
      }
      return containers(target, service);
    };
    const result = await runStackUpdate(w.ports, w.ctx, update({ web: NEW }));
    expect(result).toMatchObject({ state: 'rolled_back' });
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE.replace('restart: unless-stopped', 'restart: always'));
  });

  it('when even the image line cannot be put back, the bracket stays open and restart recovery restores the kept file', async () => {
    const w = await makeWorld();
    w.knobs.health.set(NEW, 'unhealthy');
    const write = w.ports.fs.writeFileAtomic.bind(w.ports.fs);
    let composeWrites = 0;
    w.ports.fs.writeFileAtomic = (path, text) => {
      if (path === w.composePath && ++composeWrites > 1) return Promise.reject(new Error('read-only file system'));
      return write(path, text);
    };
    const job = update({ web: NEW });
    const result = await runStackUpdate(w.ports, w.ctx, job);
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'health_failed', message: expect.stringContaining('Rolling back failed too') as unknown, fix: expect.stringContaining('next starts') as unknown } });
    expect(await readFile(w.composePath, 'utf8')).toContain(`@${NEW}`);
    expect(await w.journal.unfinishedStackUpdates()).toMatchObject([{ updateId: job.updateId, swapped: true }]);

    w.ports.fs.writeFileAtomic = write;
    // Until recovery has put it back, a new update of the stack is refused rather than written over it.
    await expect(runStackUpdate(w.ports, w.ctx, update({ db: DB_NEW }))).resolves.toMatchObject({ state: 'refused', refusal: { code: 'conflict' } });
    const results = await recoverInterruptedStackUpdates({ fs: w.ports.fs, docker: w.ports.docker, log: w.ports.log }, w.journal, { historyDir: w.ctx.historyDir, ledger: w.ledger });
    expect(results).toMatchObject([{ updateId: job.updateId, succeeded: false, restored: [w.composePath] }]);
    expect(results[0]?.error).toBeUndefined();
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    expect(await w.journal.unfinishedStackUpdates()).toEqual([]);
  });
});

describe('runStackUpdate: a rollback job whose target the manifest no longer tracks', () => {
  it('is rollback_target_invalid', async () => {
    const w = await makeWorld();
    const first = update({ web: NEW });
    await expect(runStackUpdate(w.ports, w.ctx, first)).resolves.toMatchObject({ state: 'succeeded' });
    const loaded = w.ctx.stacks.get('media');
    if (loaded === undefined || loaded.manifest.updates !== 'digest') throw new Error('no stack');
    const services = Object.fromEntries(Object.entries(loaded.manifest.services).filter(([service]) => service !== 'web'));
    w.ctx.stacks.set('media', { ...loaded, manifest: { ...loaded.manifest, services } });
    const result = await runStackUpdate(w.ports, w.ctx, { updateId: uuid(), kind: 'rollback', stack: 'media', toUpdateId: first.updateId });
    expect(result).toMatchObject({ state: 'refused', refusal: { code: 'rollback_target_invalid', message: expect.stringContaining('no longer tracks') as unknown } });
  });
});

describe('restart recovery: the other cases', () => {
  async function openBracket(w: World, updateId: string, steps: string[]): Promise<void> {
    await w.journal.begin({ deployId: updateId, app: 'media', step: 'stack-update', detail: { kind: 'update', composeFiles: [w.composePath], project: 'media', services: ['web'] } });
    for (const step of steps) await w.journal.begin({ deployId: updateId, app: 'media', step: `stack-update:${step}` });
  }

  async function swapByHand(w: World, updateId: string): Promise<void> {
    const plan = planRewrite([{ path: w.composePath, text: COMPOSE }], [{ service: 'web', repo: 'lscr.io/linuxserver/sonarr', reference: `lscr.io/linuxserver/sonarr:latest@${NEW}` }]);
    await applyRewrite(w.ports.fs, plan, { dir: w.ctx.historyDir, deployId: updateId });
  }

  it('one the ledger shows succeeded is only closed, succeeded', async () => {
    const w = await makeWorld();
    const id = uuid();
    await openBracket(w, id, ['verify', 'swap']);
    await swapByHand(w, id);
    await w.ledger.append({ kind: 'stack-update', app: 'media', deployId: id, updateKind: 'update', images: [{ service: 'web', repo: 'lscr.io/linuxserver/sonarr', tag: 'latest', digest: NEW }], previous: [], backupArtifact: null, at: new Date().toISOString() });
    const results = await recoverInterruptedStackUpdates({ fs: w.ports.fs, docker: w.ports.docker, log: w.ports.log }, w.journal, { historyDir: w.ctx.historyDir, ledger: w.ledger });
    expect(results).toMatchObject([{ updateId: id, succeeded: true, restored: [] }]);
    expect(await readFile(w.composePath, 'utf8')).toContain(`@${NEW}`);
    expect(w.composeCalls).toEqual([]);
    expect(await w.journal.unfinishedStackUpdates()).toEqual([]);
  });

  it('one whose lock is still live is left alone, open', async () => {
    const w = await makeWorld();
    const id = uuid();
    await openBracket(w, id, ['swap']);
    await swapByHand(w, id);
    const results = await recoverInterruptedStackUpdates({ fs: w.ports.fs, docker: w.ports.docker, log: w.ports.log }, w.journal, { historyDir: w.ctx.historyDir, ledger: w.ledger, isLive: () => Promise.resolve(true) });
    expect(results).toEqual([]);
    expect(await readFile(w.composePath, 'utf8')).toContain(`@${NEW}`);
    expect(await w.journal.unfinishedStackUpdates()).toMatchObject([{ updateId: id }]);
  });

  it('one stopped before its swap restores nothing and recreates nothing', async () => {
    const w = await makeWorld();
    const id = uuid();
    await openBracket(w, id, ['verify', 'backup']);
    const results = await recoverInterruptedStackUpdates({ fs: w.ports.fs, docker: w.ports.docker, log: w.ports.log }, w.journal, { historyDir: w.ctx.historyDir, ledger: w.ledger });
    expect(results).toMatchObject([{ updateId: id, succeeded: false, restored: [], lastStep: 'stack-update:backup' }]);
    expect(results[0]?.error).toBeUndefined();
    expect(w.composeCalls).toEqual([]);
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    expect(await w.journal.unfinishedStackUpdates()).toEqual([]);
  });

  it('a compose up that exits non-zero is reported as the error, with a timeout given', async () => {
    const w = await makeWorld();
    const id = uuid();
    await openBracket(w, id, ['swap']);
    await swapByHand(w, id);
    w.knobs.upExits = [130];
    const results = await recoverInterruptedStackUpdates({ fs: w.ports.fs, docker: w.ports.docker, log: w.ports.log }, w.journal, { historyDir: w.ctx.historyDir, composeTimeoutMs: 9_000 });
    expect(results).toMatchObject([{ updateId: id, succeeded: false, restored: [w.composePath], error: expect.stringContaining('exited 130') as unknown }]);
    expect(w.composeTimeouts).toEqual([9_000]);
    expect(await readFile(w.composePath, 'utf8')).toBe(COMPOSE);
    const closed = (await w.journal.readAll()).filter((e) => e.deployId === id && e.step === 'stack-update' && e.phase === 'end');
    expect(closed).toMatchObject([{ detail: { state: 'failed', error: expect.stringContaining('exited 130') as unknown } }]);
  });
});
