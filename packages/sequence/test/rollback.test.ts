import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Manifest } from '@shipyard/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeFs } from '../src/adapters/node.js';
import { Journal } from '../src/journal.js';
import { Ledger } from '../src/ledger.js';
import { AppLock } from '../src/machine.js';
import type { MachineContext } from '../src/machine.js';
import type { LoadedManifests } from '../src/manifest.js';
import { RefusalError } from '../src/ports.js';
import type { Clock, ComposeTarget, DockerPort, GitHubPort, HealthResponse, Log, RegistryPort, RunningContainer, SequencePorts } from '../src/ports.js';
import { runRollback } from '../src/rollback.js';
import type { RollbackRequest } from '../src/rollback.js';
import { LABEL_MIGRATION, LABEL_REVISION, LABEL_SCHEMA } from '../src/types.js';

// ─── A fake world: seven releases in the ledger, dep-7 live ──────────────────

const REPO = 'ghcr.io/example/toy/app';
const N = 7;
const shaOf = (n: number): string => n.toString(16).repeat(40);
const digestOf = (n: number): string => `sha256:${n.toString(16).repeat(64)}`;
const idOf = (n: number): string => `dep-${String(n)}`;

interface World {
  ports: SequencePorts;
  ctx: MachineContext;
  composePath: string;
  running: Map<string, string>;
  composeCalls: string[][];
  githubCalls: string[];
  /** digest → health of the image. */
  health: Map<string, 'ok' | 'fail'>;
  /** Digests the registry no longer serves. */
  gone: Set<string>;
  labels: Map<string, Record<string, string>>;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function composeText(n: number): string {
  return `services:\n  app:\n    image: ${REPO}:sha-${shaOf(n)}@${digestOf(n)}\n    restart: unless-stopped\n`;
}

async function makeWorld(options: { contractAt?: number[] } = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'shp-rollback-'));
  roots.push(root);
  const dataRoot = join(root, 'data');
  const stackDir = join(root, 'stack');
  const artifactsDir = join(root, 'backups');
  await mkdir(stackDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(join(dataRoot, 'agent'), { recursive: true });
  const composePath = join(stackDir, 'compose.yml');
  await writeFile(composePath, composeText(N), 'utf8');

  const contract = new Set(options.contractAt ?? []);
  const labels = new Map<string, Record<string, string>>();
  const health = new Map<string, 'ok' | 'fail'>();
  for (let n = 1; n <= N; n++) {
    labels.set(digestOf(n), {
      [LABEL_REVISION]: shaOf(n),
      [LABEL_SCHEMA]: `s${String(n)}`,
      ...(contract.has(n) ? { [LABEL_MIGRATION]: 'contract' } : {}),
    });
    health.set(digestOf(n), 'ok');
  }
  const running = new Map<string, string>([['app', digestOf(N)]]);
  const starts = new Map<string, number>([['app', 0]]);
  const composeCalls: string[][] = [];
  const githubCalls: string[] = [];
  const gone = new Set<string>();

  const github: GitHubPort = {
    workflowRuns: (...args) => {
      githubCalls.push(`workflowRuns ${args.join(' ')}`);
      return Promise.reject(new Error('a rollback must never call GitHub'));
    },
    compare: (...args) => {
      githubCalls.push(`compare ${args.join(' ')}`);
      return Promise.reject(new Error('a rollback must never call GitHub'));
    },
  };

  const registry: RegistryPort = {
    resolveDigest: () => Promise.reject(new Error('a rollback reads digests from its ledger, never from a tag')),
    imageConfig: (repo, digest) => {
      if (gone.has(digest)) {
        return Promise.reject(new RefusalError({ code: 'ghcr_unreachable', gate: 'none', message: `returned 404 for manifest ${repo}@${digest}`, fix: 'retry' }));
      }
      return Promise.resolve({ digest, labels: labels.get(digest) ?? {} });
    },
  };

  const exec = (exitCode: number) => Promise.resolve({ exitCode, stdout: '', stderr: '' });
  const docker: DockerPort = {
    async compose(target: ComposeTarget, args: string[]) {
      composeCalls.push(args);
      if (args[0] === 'up') {
        const text = await readFile(target.files[0] ?? '', 'utf8');
        const digest = /image: \S+@(sha256:[0-9a-f]{64})/.exec(text)?.[1];
        if (digest !== undefined && running.get('app') !== digest) {
          running.set('app', digest);
          starts.set('app', (starts.get('app') ?? 0) + 1);
        }
      }
      return exec(0);
    },
    containers(_target, service) {
      const list: RunningContainer[] = [...running.entries()]
        .filter(([svc]) => service === undefined || svc === service)
        .map(([svc, digest]) => ({
          id: `c-${svc}`,
          service: svc,
          repoDigests: [`${REPO}@${digest}`],
          labels: labels.get(digest) ?? {},
          state: 'running',
          networks: ['toy_default'],
          startedAt: `start-${String(starts.get(svc) ?? 0)}`,
          restartCount: 0,
        }));
      return Promise.resolve(list);
    },
    probeHealth(): Promise<HealthResponse> {
      const digest = running.get('app') ?? '';
      const schema = labels.get(digest)?.[LABEL_SCHEMA] ?? 's?';
      if (health.get(digest) === 'fail') return Promise.resolve({ httpStatus: 503, body: { status: 'down', schema } });
      return Promise.resolve({ httpStatus: 200, body: { status: 'ok', schema } });
    },
    freeBytes: () => Promise.resolve(100 * 1024 ** 3),
    images: () => Promise.resolve([]),
    removeImage: () => Promise.resolve(),
  };

  let now = Date.now();
  const clock: Clock = {
    now: () => new Date(now),
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
  const log: Log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  const fs = nodeFs();
  const ports: SequencePorts = { github, registry, docker, fs, clock, log };

  const manifest = Manifest.parse({
    name: 'toy',
    repo: 'example/toy',
    workflow: 'ci.yml',
    compose: { files: [composePath], project: 'toy' },
    services: { app: { image: REPO } },
    health: { service: 'app', port: 3000, path: '/health' },
    soakSeconds: 20,
    // Both steps are configured: a rollback must run neither.
    steps: {
      backup: { service: 'app', argv: ['pg_dump', '-f', '/backups/x.sql'], artifactsDir },
      migrate: { service: 'app', argv: ['node', 'migrate.mjs'] },
    },
  });
  const manifests: LoadedManifests = new Map([['toy', { manifest, file: join(dataRoot, 'apps', 'toy.yml'), sha256: '0' }]]);
  const journal = new Journal(fs, join(dataRoot, 'agent', 'journal.jsonl'), clock, log);
  const ledger = await Ledger.open(fs, join(dataRoot, 'agent', 'ledger.jsonl'));
  for (let n = 1; n <= N; n++) {
    await ledger.append({
      app: 'toy',
      deployId: idOf(n),
      kind: 'deploy',
      sha: shaOf(n),
      images: [{ service: 'app', repo: REPO, digest: digestOf(n), migration: contract.has(n) ? 'contract' : null }],
      backupArtifact: null,
      at: new Date().toISOString(),
    });
  }

  const ctx: MachineContext = {
    dataRoot,
    manifests,
    journal,
    ledger,
    workDir: join(dataRoot, 'agent', 'work'),
    historyDir: join(dataRoot, 'agent', 'history'),
    healthTimeoutMs: 10_000,
    checkIntervalMs: 1_000,
    soakIntervalMs: 10_000,
  };
  return { ports, ctx, composePath, running, composeCalls, githubCalls, health, gone, labels };
}

function rollback(toDeployId: string, overrides: Partial<RollbackRequest> = {}): RollbackRequest {
  return { deployId: 'rb-1', app: 'toy', toDeployId, requesterLabel: 'matt (phone)', ...overrides };
}

let w: World;

// ─── The target comes only from the ledger (SHP-REQ-051, SHP-D-080) ──────────

describe('runRollback — target validity', () => {
  beforeEach(async () => {
    w = await makeWorld();
  });

  it.each([
    ['an id that is not in the ledger', 'dep-nope', 'not in this agent'],
    ['the live release itself', idOf(7), 'live now'],
    ['the sixth most recent entry', idOf(2), 'older than the last five'],
    ['the oldest entry', idOf(1), 'older than the last five'],
  ])('refuses %s with rollback_target_invalid, naming what is allowed', async (_what, id, why) => {
    const compose = await readFile(w.composePath, 'utf8');
    const result = await runRollback(w.ports, w.ctx, rollback(id));

    expect(result.state).toBe('refused');
    expect(result.refusal?.code).toBe('rollback_target_invalid');
    expect(result.refusal?.message).toContain(why);
    expect(result.refusal?.message).toContain(`allowed: ${[6, 5, 4, 3].map((n) => `${idOf(n)} (${shaOf(n).slice(0, 7)})`).join(', ')}`);
    expect(w.composeCalls).toEqual([]);
    expect(await readFile(w.composePath, 'utf8')).toBe(compose);
    expect(w.ctx.ledger.last('toy')?.deployId).toBe(idOf(7));
  });

  it.each([3, 4, 5, 6])('accepts each of the four releases before live (dep-%i) as a dry run', async (n) => {
    const result = await runRollback(w.ports, w.ctx, rollback(idOf(n), { dryRun: true }));
    expect(result.refusal).toBeNull();
    expect(result.state).toBe('verifying');
    expect(result.gates.map((g) => g.gate)).toEqual(['disk', 'G8', 'G10']);
    expect(result.images).toMatchObject([{ service: 'app', digest: digestOf(n), reference: `${REPO}:sha-${shaOf(n)}@${digestOf(n)}` }]);
    // A dry run changes nothing: no Docker calls, nothing journaled, the ledger untouched.
    expect(w.composeCalls).toEqual([]);
    expect(await w.ctx.journal.readAll()).toEqual([]);
    expect(w.ctx.ledger.entries('toy')).toHaveLength(N);
  });
});

// ─── G10: a later contract release (SHP-REQ-052) ─────────────────────────────

describe('runRollback — contract crossing', () => {
  it('refuses a rollback across a later contract release, pointing at restore', async () => {
    w = await makeWorld({ contractAt: [5] });
    const result = await runRollback(w.ports, w.ctx, rollback(idOf(4)));

    expect(result.state).toBe('refused');
    expect(result.refusal?.code).toBe('later_contract_release');
    expect(result.refusal?.gate).toBe('G10');
    expect(result.refusal?.fix).toContain('restore');
    expect(result.gates.find((g) => g.gate === 'G10')?.pass).toBe(false);
    expect(w.composeCalls).toEqual([]);
    expect(w.ctx.ledger.last('toy')?.deployId).toBe(idOf(7));
  });

  it('ignores a contract release at or before the target', async () => {
    w = await makeWorld({ contractAt: [4, 6] });
    const result = await runRollback(w.ports, w.ctx, rollback(idOf(6)));
    expect(result.refusal).toBeNull();
    expect(result.state).toBe('succeeded');
    expect(result.gates.find((g) => g.gate === 'G10')?.pass).toBe(true);
  });
});

// ─── G8: digests still pullable ──────────────────────────────────────────────

describe('runRollback — pullable', () => {
  it('refuses with image_missing when the recorded digest is no longer in the registry', async () => {
    w = await makeWorld();
    w.gone.add(digestOf(5));
    const result = await runRollback(w.ports, w.ctx, rollback(idOf(5)));

    expect(result.state).toBe('refused');
    expect(result.refusal?.code).toBe('image_missing');
    expect(result.refusal?.gate).toBe('G8');
    expect(result.refusal?.message).toContain(digestOf(5));
    expect(w.composeCalls).toEqual([]);
  });
});

// ─── The run itself ──────────────────────────────────────────────────────────

describe('runRollback — execution', () => {
  beforeEach(async () => {
    w = await makeWorld();
  });

  it('rolls back image-only through pull → swap → check → soak, and records a rollback ledger entry', async () => {
    const result = await runRollback(w.ports, w.ctx, rollback(idOf(5)));

    expect(result.refusal).toBeNull();
    expect(result.state).toBe('succeeded');
    expect(result.sha).toBe(shaOf(5));
    expect(result.schemaRevision).toBe('s5');
    expect(result.backupArtifact).toBeNull();
    expect(result.steps.map((s) => s.name)).toEqual(['verify', 'pull', 'swap', 'check', 'soak']);
    // Neither the backup (`exec`) nor the migrate (`run`) step ran.
    expect(w.composeCalls.map((c) => c[0])).toEqual(['pull', 'up']);

    expect(w.running.get('app')).toBe(digestOf(5));
    expect(await readFile(w.composePath, 'utf8')).toBe(composeText(5));
    expect(w.ctx.ledger.last('toy')).toMatchObject({
      deployId: 'rb-1',
      kind: 'rollback',
      sha: shaOf(5),
      images: [{ service: 'app', repo: REPO, digest: digestOf(5) }],
      backupArtifact: null,
    });

    const journal = await w.ctx.journal.readAll();
    expect(journal.filter((e) => e.phase === 'start').map((e) => e.step)).toEqual(['deploy', 'verify', 'pull', 'swap', 'check', 'soak']);
    expect(journal.find((e) => e.step === 'deploy' && e.phase === 'start')?.detail).toMatchObject({ kind: 'rollback', rollbackTo: idOf(5) });
    expect(journal.find((e) => e.step === 'verify' && e.phase === 'end')?.detail).toMatchObject({ contract: false });
  });

  it('repairs drift: the live release is a target when something else is running (redeploy recorded)', async () => {
    // Someone changed the running image by hand: the ledger's live entry (7) is no longer what runs.
    w.running.set('app', digestOf(3));
    const result = await runRollback(w.ports, w.ctx, rollback(idOf(7)));
    expect(result.refusal).toBeNull();
    expect(result.state).toBe('succeeded');
    expect(w.running.get('app')).toBe(digestOf(7));
  });

  it('never calls GitHub', async () => {
    const result = await runRollback(w.ports, w.ctx, rollback(idOf(3)));
    expect(result.state).toBe('succeeded');
    expect(w.githubCalls).toEqual([]);
  });

  it('can roll back again, to a release before the rollback entry', async () => {
    expect((await runRollback(w.ports, w.ctx, rollback(idOf(6)))).state).toBe('succeeded');
    // Now rb-1 (sha 6) is live; dep-7 is a candidate, and so is dep-4.
    const again = await runRollback(w.ports, w.ctx, rollback(idOf(7), { deployId: 'rb-2' }));
    expect(again.state).toBe('succeeded');
    expect(w.running.get('app')).toBe(digestOf(7));
    expect(w.ctx.ledger.last('toy')).toMatchObject({ deployId: 'rb-2', kind: 'rollback', sha: shaOf(7) });
  });

  it('a target that fails its check is rolled back to what was live, even when it carries the contract label', async () => {
    w = await makeWorld({ contractAt: [6] });
    w.health.set(digestOf(6), 'fail');
    const before = await readFile(w.composePath, 'utf8');
    const result = await runRollback(w.ports, w.ctx, rollback(idOf(6)));

    expect(result.state).toBe('rolled_back');
    expect(result.refusal?.code).toBe('health_failed');
    expect(result.steps.map((s) => s.name)).toEqual(['verify', 'pull', 'swap', 'check', 'rollback']);
    expect(w.running.get('app')).toBe(digestOf(7));
    expect(await readFile(w.composePath, 'utf8')).toBe(before);
    expect(w.ctx.ledger.last('toy')?.deployId).toBe(idOf(7));
  });

  it('is refused while another deploy holds the app lock, naming the holder', async () => {
    const held = await AppLock.acquire(w.ctx.dataRoot, 'toy', { pid: 1, deployId: 'dep-8', requesterLabel: 'claude', sha: shaOf(8), step: 'soak', at: new Date().toISOString() });
    if (!(held instanceof AppLock)) throw new Error('could not take the lock for the test');
    try {
      const result = await runRollback(w.ports, w.ctx, rollback(idOf(5)));
      expect(result.state).toBe('refused');
      expect(result.refusal?.code).toBe('locked');
      expect(result.refusal?.message).toContain('claude');
      expect(w.composeCalls).toEqual([]);
      expect(w.ctx.ledger.last('toy')?.deployId).toBe(idOf(7));
    } finally {
      await held.release();
    }
  });

  it('refuses an unknown app', async () => {
    const result = await runRollback(w.ports, w.ctx, rollback(idOf(5), { app: 'nope' }));
    expect(result.state).toBe('refused');
    expect(result.refusal?.code).toBe('unknown_app');
  });
});
