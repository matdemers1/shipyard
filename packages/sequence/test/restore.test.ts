import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Manifest } from '@shipyard/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nodeFs } from '../src/adapters/node.js';
import { Journal } from '../src/journal.js';
import { Ledger } from '../src/ledger.js';
import { runDeploy } from '../src/machine.js';
import type { MachineContext } from '../src/machine.js';
import type { LoadedManifests } from '../src/manifest.js';
import type { Clock, ComposeTarget, DockerPort, GitHubPort, HealthResponse, Log, RegistryPort, RunningContainer, SequencePorts } from '../src/ports.js';
import { restoreArgv, runRestore } from '../src/restore.js';
import type { RestoreRequest } from '../src/restore.js';
import { LABEL_MIGRATION, LABEL_REVISION, LABEL_SCHEMA } from '../src/types.js';
import type { JournalEntry } from '../src/types.js';

// ─── A fake world: dep-1 is the release, dep-2 took a backup and left its image running ──────
//
// dep-2 is the failed contract release: it backed up, migrated, swapped and failed its check, so
// the ledger holds its backup (recorded when taken) but not it as a release, and its image still
// runs. Restoring dep-2's backup must put dep-1's images back with dep-1's data.

const REPO = 'ghcr.io/example/toy/app';
const shaOf = (n: number): string => n.toString(16).repeat(40);
const digestOf = (n: number): string => `sha256:${n.toString(16).repeat(64)}`;

interface World {
  ports: SequencePorts;
  ctx: MachineContext;
  root: string;
  artifactsDir: string;
  composePath: string;
  journalPath: string;
  running: Map<string, string>;
  composeCalls: string[][];
  githubCalls: string[];
  health: Map<string, 'ok' | 'fail'>;
  labels: Map<string, Record<string, string>>;
  /** Exit code the fake restore command returns. */
  restoreExit: { code: number };
  advance(ms: number): void;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function composeText(n: number): string {
  return `services:\n  app:\n    image: ${REPO}:sha-${shaOf(n)}@${digestOf(n)}\n    restart: unless-stopped\n`;
}

interface WorldOptions {
  /** Leave the restore step out of the manifest. */
  noRestoreStep?: boolean;
  /** Seed the dep-2 backup (default true). */
  seedBackup?: boolean;
  /** The seeded backup's file name. */
  artifactName?: string;
  /** The release the seeded backup records (default dep-1). */
  backupRelease?: string | null;
  /** Write the seeded artifact to disk (default true). */
  artifactOnDisk?: boolean;
  /** dep-2 succeeded and is the last release (default: it failed and is not in the ledger). */
  dep2Released?: boolean;
}

async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'shp-restore-'));
  roots.push(root);
  const dataRoot = join(root, 'data');
  const stackDir = join(root, 'stack');
  const artifactsDir = join(root, 'backups');
  await mkdir(stackDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(join(dataRoot, 'agent'), { recursive: true });
  const composePath = join(stackDir, 'compose.yml');
  await writeFile(composePath, composeText(2), 'utf8');

  const labels = new Map<string, Record<string, string>>();
  const health = new Map<string, 'ok' | 'fail'>();
  for (let n = 1; n <= 3; n++) {
    labels.set(digestOf(n), {
      [LABEL_REVISION]: shaOf(n),
      [LABEL_SCHEMA]: `s${String(n)}`,
      ...(n >= 2 ? { [LABEL_MIGRATION]: 'contract' } : {}),
    });
    health.set(digestOf(n), n === 1 ? 'ok' : 'fail');
  }
  const running = new Map<string, string>([['app', digestOf(2)]]);
  const starts = new Map<string, number>([['app', 0]]);
  const composeCalls: string[][] = [];
  const githubCalls: string[] = [];
  const restoreExit = { code: 0 };

  let now = Date.now();
  const clock: Clock = {
    now: () => new Date(now),
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };

  const github: GitHubPort = {
    workflowRuns: (...args) => {
      githubCalls.push(`workflowRuns ${args.join(' ')}`);
      return Promise.resolve([{ id: 1, headSha: args[2], path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', event: 'push', headBranch: 'main' }]);
    },
    compare: (...args) => {
      githubCalls.push(`compare ${args.join(' ')}`);
      return Promise.resolve({ status: 'ahead', aheadBy: 1, behindBy: 0, commits: [] });
    },
  };
  const registry: RegistryPort = {
    resolveDigest: (_repo, tag) => Promise.resolve(digestOf(Number.parseInt(tag.slice('sha-'.length, 'sha-'.length + 1), 16))),
    imageConfig: (_repo, digest) => Promise.resolve({ digest, labels: labels.get(digest) ?? {} }),
  };

  let backups = 0;
  const exec = (exitCode: number) => Promise.resolve({ exitCode, stdout: 'secret-output', stderr: '' });
  const docker: DockerPort = {
    async compose(target: ComposeTarget, args: string[]) {
      composeCalls.push(args);
      if (args[0] === 'exec' && args[3] === 'pg_dump') {
        backups += 1;
        const path = join(artifactsDir, `toy-backup-${String(backups)}.dump`);
        await writeFile(path, `dump ${String(backups)}`, 'utf8');
        await utimes(path, new Date(now), new Date(now));
        return exec(0);
      }
      if (args[0] === 'exec' && args[3] === 'pg_restore') return exec(restoreExit.code);
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
    diskFloorGb: 0,
    steps: {
      backup: { service: 'db', argv: ['pg_dump', '-f', '/backups/x.dump'], artifactsDir },
      ...(options.noRestoreStep === true ? {} : { restore: { service: 'db', argv: ['pg_restore', '--clean', '/backups/{artifact}'] } }),
    },
  });
  const manifests: LoadedManifests = new Map([['toy', { manifest, file: join(dataRoot, 'apps', 'toy.yml'), sha256: '0' }]]);
  const journalPath = join(dataRoot, 'agent', 'journal.jsonl');
  const journal = new Journal(fs, journalPath, clock, log);
  const ledger = await Ledger.open(fs, join(dataRoot, 'agent', 'ledger.jsonl'));
  const hourAgo = new Date(now - 3 * 3600_000 - 12 * 60_000).toISOString();
  await ledger.append({
    app: 'toy',
    deployId: 'dep-1',
    kind: 'deploy',
    sha: shaOf(1),
    images: [{ service: 'app', repo: REPO, digest: digestOf(1), migration: null }],
    backupArtifact: null,
    at: hourAgo,
  });
  if (options.seedBackup !== false) {
    const artifact = join(artifactsDir, options.artifactName ?? 'toy-dep-2.dump');
    if (options.artifactOnDisk !== false) await writeFile(artifact, 'the data dep-1 ran on', 'utf8');
    await ledger.recordBackup({
      app: 'toy',
      deployId: 'dep-2',
      backupArtifact: artifact,
      release: options.backupRelease === undefined ? 'dep-1' : options.backupRelease,
      at: hourAgo,
    });
  }
  if (options.dep2Released === true) {
    await ledger.append({
      app: 'toy',
      deployId: 'dep-2',
      kind: 'deploy',
      sha: shaOf(2),
      images: [{ service: 'app', repo: REPO, digest: digestOf(2), migration: 'contract' }],
      backupArtifact: join(artifactsDir, options.artifactName ?? 'toy-dep-2.dump'),
      at: hourAgo,
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
    envNamesProvider: () => Promise.resolve([]),
  };
  return {
    ports,
    ctx,
    root,
    artifactsDir,
    composePath,
    journalPath,
    running,
    composeCalls,
    githubCalls,
    health,
    labels,
    restoreExit,
    advance: (ms) => {
      now += ms;
    },
  };
}

function restore(backupOf: string, overrides: Partial<RestoreRequest> = {}): RestoreRequest {
  return { deployId: 'rs-1', app: 'toy', backupOf, requesterLabel: 'matt (console)', ...overrides };
}

async function journalLines(w: World): Promise<JournalEntry[]> {
  const text = await readFile(w.journalPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as JournalEntry);
}

describe('restoreArgv', () => {
  it('replaces every {artifact} with the file name, never the host path', () => {
    expect(restoreArgv(['pg_restore', '/backups/{artifact}', '--label={artifact}'], '/DATA/apps/toy/backups/toy-1.dump')).toEqual([
      'pg_restore',
      '/backups/toy-1.dump',
      '--label=toy-1.dump',
    ]);
  });

  it.each(['bad name.dump', 'x;rm -rf.dump', '$(id).dump', '..'])('refuses the file name %j', (name) => {
    const out = restoreArgv(['restore', '/backups/{artifact}'], `/backups/${name}`);
    expect(Array.isArray(out)).toBe(false);
    expect(out).toMatchObject({ code: 'restore_limited' });
  });
});

describe('runRestore', () => {
  it('restores the backup a failed contract release took: safety backup, restore, dep-1 images back, check, soak', async () => {
    const w = await makeWorld();
    const result = await runRestore(w.ports, w.ctx, restore('dep-2'));

    expect(result.refusal, JSON.stringify(result.refusal)).toBeNull();
    expect(result.state).toBe('succeeded');
    expect(result.sha).toBe(shaOf(1));
    expect(result.schemaRevision).toBe('s1');
    expect(result.steps.map((s) => s.name)).toEqual(['verify', 'backup', 'restore', 'pull', 'swap', 'check', 'soak']);
    expect(result.gates.map((g) => g.gate)).toEqual(['disk', 'G8']);
    // GitHub is never asked: the ledger says what to run.
    expect(w.githubCalls).toEqual([]);

    // Safety backup first, then the restore command with the artifact's file name, then the swap.
    const execs = w.composeCalls.filter((c) => c[0] === 'exec');
    expect(execs).toEqual([
      ['exec', '-T', 'db', 'pg_dump', '-f', '/backups/x.dump'],
      ['exec', '-T', 'db', 'pg_restore', '--clean', '/backups/toy-dep-2.dump'],
    ]);
    expect(w.running.get('app')).toBe(digestOf(1));
    expect(await readFile(w.composePath, 'utf8')).toContain(`${REPO}:sha-${shaOf(1)}@${digestOf(1)}`);
    expect(result.backupArtifact).toBe(join(w.artifactsDir, 'toy-backup-1.dump'));

    // The ledger: dep-1 was still its last release, so only the restore is recorded.
    expect(w.ctx.ledger.last('toy')).toMatchObject({ deployId: 'dep-1', kind: 'deploy', sha: shaOf(1) });
    expect(w.ctx.ledger.restores('toy')).toMatchObject([
      { deployId: 'rs-1', backupOf: 'dep-2', restoredFrom: join(w.artifactsDir, 'toy-dep-2.dump'), release: 'dep-1', backupArtifact: result.backupArtifact },
    ]);
    // The safety backup is itself a backup this agent took; what ran then was not a release it recorded.
    expect(w.ctx.ledger.backupArtifacts('toy').find((b) => b.deployId === 'rs-1')).toMatchObject({ release: null });

    // Journaled before each step; the restore step's output is never stored (SHP-D-082).
    const lines = await journalLines(w);
    const starts = lines.filter((l) => l.phase === 'start').map((l) => l.step);
    expect(starts).toEqual(['deploy', 'verify', 'backup', 'restore', 'pull', 'swap', 'check', 'soak']);
    const restoreLines = lines.filter((l) => l.step === 'restore');
    expect(restoreLines.every((l) => l.output === undefined)).toBe(true);
    expect(JSON.stringify(lines.filter((l) => l.step === 'restore' || l.step === 'backup'))).not.toContain('secret-output');
    expect(lines.find((l) => l.step === 'deploy' && l.phase === 'start')?.detail).toMatchObject({ kind: 'restore', backupOf: 'dep-2', contract: true });
  });

  it('when a later release is live, the matching release is recorded live again under the restore ID', async () => {
    const w = await makeWorld({ dep2Released: true });
    const result = await runRestore(w.ports, w.ctx, restore('dep-2'));
    expect(result.refusal, JSON.stringify(result.refusal)).toBeNull();
    expect(w.ctx.ledger.last('toy')).toMatchObject({ deployId: 'rs-1', kind: 'rollback', sha: shaOf(1), backupArtifact: null });
    expect(w.ctx.ledger.backupArtifacts('toy').map((b) => [b.deployId, b.release])).toEqual([
      ['dep-2', 'dep-1'],
      // The safety backup was taken with dep-2 running, which the ledger vouches for.
      ['rs-1', 'dep-2'],
    ]);
  });

  it('refuses a deploy ID with no backup in the ledger (restore_limited) and touches nothing', async () => {
    const w = await makeWorld();
    const result = await runRestore(w.ports, w.ctx, restore('dep-9'));
    expect(result.state).toBe('refused');
    expect(result.refusal?.code).toBe('restore_limited');
    expect(result.refusal?.message).toContain('not a backup this agent took');
    expect(w.composeCalls.filter((c) => c[0] !== 'ps')).toEqual([]);
    expect(w.running.get('app')).toBe(digestOf(2));
  });

  it('refuses a second restore of the same app within 24 hours, and allows it after', async () => {
    const w = await makeWorld();
    expect((await runRestore(w.ports, w.ctx, restore('dep-2'))).state).toBe('succeeded');
    const calls = w.composeCalls.length;

    w.advance(23 * 3600_000);
    const again = await runRestore(w.ports, w.ctx, restore('rs-1', { deployId: 'rs-2' }));
    expect(again.state).toBe('refused');
    expect(again.refusal?.code).toBe('restore_limited');
    expect(again.refusal?.message).toContain('another restore is allowed from');
    expect(w.composeCalls.length).toBe(calls);

    w.advance(3600_000);
    const later = await runRestore(w.ports, w.ctx, restore('dep-2', { deployId: 'rs-3', dryRun: true }));
    expect(later.refusal).toBeNull();
  });

  it('refuses when the manifest has no restore step (manifest_invalid), naming it', async () => {
    const w = await makeWorld({ noRestoreStep: true });
    const result = await runRestore(w.ports, w.ctx, restore('dep-2'));
    expect(result.state).toBe('refused');
    expect(result.refusal?.code).toBe('manifest_invalid');
    expect(result.refusal?.message).toContain('steps.restore');
    expect(w.composeCalls.filter((c) => c[0] === 'exec')).toEqual([]);
  });

  it('refuses an artifact whose file name cannot be passed to the command', async () => {
    const w = await makeWorld({ artifactName: 'toy dep 2.dump' });
    const result = await runRestore(w.ports, w.ctx, restore('dep-2'));
    expect(result.state).toBe('refused');
    expect(result.refusal?.code).toBe('restore_limited');
    expect(result.refusal?.message).toContain('cannot be passed to the restore command');
    expect(w.composeCalls.filter((c) => c[0] === 'exec')).toEqual([]);
  });

  it('refuses an artifact that is no longer on disk', async () => {
    const w = await makeWorld({ artifactOnDisk: false });
    const result = await runRestore(w.ports, w.ctx, restore('dep-2'));
    expect(result.refusal?.code).toBe('restore_limited');
    expect(result.refusal?.message).toContain('no longer in');
  });

  it('refuses a backup whose data matches no release in the ledger', async () => {
    const w = await makeWorld({ backupRelease: null });
    const result = await runRestore(w.ports, w.ctx, restore('dep-2'));
    expect(result.refusal?.code).toBe('restore_limited');
    expect(result.refusal?.message).toContain('No release in this agent');
  });

  it('a dry run resolves and reports the loss window, locks nothing and runs nothing', async () => {
    const w = await makeWorld();
    const result = await runRestore(w.ports, w.ctx, restore('dep-2', { dryRun: true }));
    expect(result.refusal).toBeNull();
    expect(result.state).toBe('verifying');
    expect(result.images.map((i) => i.digest)).toEqual([digestOf(1)]);
    expect(result.steps[0]?.output).toContain('Writes made in the last 3 hours 12 minutes would be lost');
    expect(result.steps[0]?.output).toContain('would be put back');
    expect(w.composeCalls).toEqual([]);
    expect(await journalLines(w)).toEqual([]);
  });

  it('a failed check after the restore stops failed: no rollback, no second restore, no ledger record', async () => {
    const w = await makeWorld();
    w.health.set(digestOf(1), 'fail');
    const result = await runRestore(w.ports, w.ctx, restore('dep-2'));
    expect(result.state).toBe('failed');
    expect(result.refusal?.code).toBe('health_failed');
    expect(result.refusal?.message).toContain('nothing was rolled back');
    expect(result.refusal?.message).toContain('safety backup');
    expect(result.steps.map((s) => s.name)).not.toContain('rollback');
    expect(w.composeCalls.filter((c) => c[3] === 'pg_restore')).toHaveLength(1);
    // Left on the restored release's images, not swapped back.
    expect(w.running.get('app')).toBe(digestOf(1));
    expect(w.ctx.ledger.restores('toy')).toEqual([]);
    expect(w.ctx.ledger.last('toy')?.deployId).toBe('dep-1');
  });

  it('a restore command that exits non-zero stops failed before any swap', async () => {
    const w = await makeWorld();
    w.restoreExit.code = 3;
    const result = await runRestore(w.ports, w.ctx, restore('dep-2'));
    expect(result.state).toBe('failed');
    expect(result.refusal?.code).toBe('step_failed');
    expect(result.refusal?.message).toContain('exited 3');
    expect(result.refusal?.message).not.toContain('secret-output');
    expect(result.steps.map((s) => s.name)).toEqual(['verify', 'backup', 'restore']);
    expect(w.running.get('app')).toBe(digestOf(2));
  });

  it('refuses while another deploy holds the app lock', async () => {
    const w = await makeWorld();
    const { AppLock } = await import('../src/machine.js');
    const held = await AppLock.acquire(w.ctx.dataRoot, 'toy', { pid: process.pid, deployId: 'dep-x', requesterLabel: 'claude', sha: shaOf(3), step: 'swap', at: new Date().toISOString() });
    try {
      const result = await runRestore(w.ports, w.ctx, restore('dep-2'));
      expect(result.state).toBe('refused');
      expect(result.refusal?.code).toBe('locked');
    } finally {
      if (held instanceof AppLock) await held.release();
    }
  });
});

describe('a contract release that fails, then is restored', () => {
  it('the failed deploy records its backup in the ledger when taken; restoring it brings the earlier release back', async () => {
    // dep-1 live on digest 1, nothing else in the ledger.
    const w = await makeWorld({ seedBackup: false });
    w.running.set('app', digestOf(1));
    await writeFile(w.composePath, composeText(1), 'utf8');

    const failed = await runDeploy(w.ports, w.ctx, { deployId: 'dep-3', kind: 'deploy', app: 'toy', sha: shaOf(3), dryRun: false, requesterLabel: 'e2e' });
    expect(failed.state).toBe('failed');
    expect(failed.refusal?.fix).toContain('restore the kept backup');
    expect(w.running.get('app')).toBe(digestOf(3));
    expect(w.ctx.ledger.last('toy')?.deployId).toBe('dep-1');
    expect(w.ctx.ledger.backupArtifacts('toy')).toMatchObject([{ deployId: 'dep-3', backupArtifact: failed.backupArtifact, release: 'dep-1' }]);

    const restored = await runRestore(w.ports, w.ctx, restore('dep-3'));
    expect(restored.refusal, JSON.stringify(restored.refusal)).toBeNull();
    expect(restored.state).toBe('succeeded');
    expect(w.running.get('app')).toBe(digestOf(1));
    // dep-1 was still the last release, so no new release line: only the restore record.
    expect(w.ctx.ledger.last('toy')?.deployId).toBe('dep-1');
    expect(w.ctx.ledger.restores('toy')).toHaveLength(1);
  });
});
