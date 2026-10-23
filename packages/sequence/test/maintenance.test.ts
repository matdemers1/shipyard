import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StackManifest, type MaintenanceJob, type MaintenanceStep } from '@shipyard/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nodeArchiveFiles, nodeFs } from '../src/adapters/node.js';
import { Journal, MAINTENANCE_STEP, maintenanceStep } from '../src/journal.js';
import { Ledger } from '../src/ledger.js';
import {
  archiveTimestamp,
  backupVolumesBeforeUpdate,
  closeInterruptedMaintenance,
  recoverInterruptedMaintenance,
  runMaintenance,
  type MaintenanceContext,
  type MaintenancePorts,
} from '../src/maintenance.js';
import type { LoadedManifests, LoadedStacks } from '../src/manifest.js';
import type { BuildCacheRecord, Clock, DockerPort, ExecResult, HostContainerRecord, HostImageRecord, Log } from '../src/ports.js';

// SHP-ADR-012, SHP-T-17.2: volume backups (SHP-REQ-201), restores (SHP-REQ-202), orphan deletes
// (SHP-REQ-203), prunes after a dry run (SHP-REQ-205) and retention (SHP-REQ-206). Real files,
// journal and ledger in a temp dir; a fake Docker whose `tar` writes the archive.

const IMAGE = `sha256:${'a'.repeat(64)}`;
const VOLUME = 'media_config';
const PROJECT = 'media';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

let ids = 0;
function uuid(): string {
  ids += 1;
  return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}`;
}

function makeLog(): Log {
  const log: Log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return log;
}

function makeClock(start = Date.parse('2026-10-22T03:04:05.678Z')): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

function container(o: Partial<HostContainerRecord> & { name: string }): HostContainerRecord {
  return {
    id: `${o.name}-id`.padEnd(64, '0'),
    image: 'x',
    imageId: `sha256:${'f'.repeat(64)}`,
    state: 'running',
    health: 'none',
    restartCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    compose: null,
    ports: [],
    mounts: [],
    networkIds: [],
    ...o,
  };
}

function volumeMount(volume: string): HostContainerRecord['mounts'][number] {
  return { type: 'volume', volume, source: null, destination: '/data', readOnly: false };
}

interface World {
  root: string;
  backupRoot: string;
  ports: MaintenancePorts;
  ctx: MaintenanceContext;
  ledger: Ledger;
  journal: Journal;
  clock: ReturnType<typeof makeClock>;
  /** Every `docker` CLI argv, in order. */
  cli: string[][];
  /** Every compose argv, in order. */
  compose: string[][];
  /** Interleaved journal lines and Docker calls, to show the journal comes first. */
  events: string[];
  steps: MaintenanceStep[];
  containers: HostContainerRecord[];
  images: HostImageRecord[];
  cache: BuildCacheRecord[];
  /** What the volume "holds": what `tar -c` writes and `tar -x` restores. */
  volumeContent: { value: string };
  knobs: { tarExit: number; extractExit: number; wipeExit: number; stopExit: number; startExit: number; rmExit: number };
}

async function makeWorld(options: { retain?: number; quiesce?: boolean; volumes?: string[] } = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'shp-maint-'));
  roots.push(root);
  const dataRoot = join(root, 'data');
  const backupRoot = join(root, 'backups');
  const clock = makeClock();
  const cli: string[][] = [];
  const compose: string[][] = [];
  const events: string[] = [];
  const steps: MaintenanceStep[] = [];
  const knobs = { tarExit: 0, extractExit: 0, wipeExit: 0, stopExit: 0, startExit: 0, rmExit: 0 };
  const volumeContent = { value: 'original' };
  const containers = [container({ name: 'media-app-1', compose: { project: PROJECT, service: 'app' }, mounts: [volumeMount(VOLUME)] })];
  const images: HostImageRecord[] = [];
  const cache: BuildCacheRecord[] = [];

  const realFs = nodeFs();
  const fs = {
    ...realFs,
    appendLine: async (path: string, text: string) => {
      if (path.endsWith('journal.jsonl')) {
        const entry = JSON.parse(text) as { phase: string; step: string };
        events.push(`journal:${entry.phase}:${entry.step}`);
      }
      await realFs.appendLine(path, text);
    },
  };

  /** `-v <src>:<dst>` → src for dst. */
  const mountOf = (argv: string[], dst: string): string | undefined => {
    for (let i = 0; i < argv.length - 1; i++) {
      const v = argv[i + 1] ?? '';
      if (argv[i] === '-v' && (v.endsWith(`:${dst}`) || v.includes(`:${dst}:`))) return v.slice(0, v.indexOf(':'));
    }
    return undefined;
  };

  const docker: DockerPort = {
    compose(_target, args) {
      compose.push(args);
      events.push(`compose:${args.join(' ')}`);
      const code = args[0] === 'stop' ? knobs.stopExit : args[0] === 'start' ? knobs.startExit : 0;
      return Promise.resolve({ exitCode: code, stdout: '', stderr: '' });
    },
    containers: () => Promise.resolve([]),
    probeHealth: () => Promise.reject(new Error('unused')),
    freeBytes: () => Promise.resolve(1e12),
    images: () => Promise.resolve([]),
    removeImage: () => Promise.resolve(),
    hostContainers: () => Promise.resolve(containers.map((c) => ({ ...c }))),
    hostImages: () => Promise.resolve(images.map((i) => ({ ...i }))),
    buildCacheRecords: () => Promise.resolve(cache.map((c) => ({ ...c }))),
    async dockerCli(args): Promise<ExecResult> {
      cli.push(args);
      events.push(`docker:${args.slice(0, 2).join(' ')}`);
      const entry = args[args.indexOf('--entrypoint') + 1];
      if (args[0] === 'run' && entry === 'tar' && args.includes('-cpf')) {
        if (knobs.tarExit !== 0) return { exitCode: knobs.tarExit, stdout: '', stderr: 'tar: boom' };
        const out = mountOf(args, '/out') ?? '';
        const file = (args[args.indexOf('-cpf') + 1] ?? '').replace('/out/', '');
        // The agent created the file first; the helper writes into it.
        await stat(join(out, file));
        await writeFile(join(out, file), `archive of ${volumeContent.value}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'run' && entry === 'find') {
        if (knobs.wipeExit === 0) volumeContent.value = '';
        return { exitCode: knobs.wipeExit, stdout: '', stderr: '' };
      }
      if (args[0] === 'run' && entry === 'tar' && args.includes('-xpf')) {
        if (knobs.extractExit !== 0) return { exitCode: knobs.extractExit, stdout: '', stderr: '' };
        const dir = mountOf(args, '/in') ?? '';
        const file = (args[args.indexOf('-xpf') + 1] ?? '').replace('/in/', '');
        volumeContent.value = (await readFile(join(dir, file), 'utf8')).replace(/^archive of /, '');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: knobs.rmExit, stdout: '', stderr: knobs.rmExit === 0 ? '' : 'Error: conflict: unable to remove' };
    },
  };

  const stack = StackManifest.parse({
    kind: 'stack',
    name: 'media',
    compose: { files: [join(root, 'compose.yml')], project: PROJECT },
    volumeBackups: { retain: options.retain ?? 7, quiesce: options.quiesce ?? false, ...(options.volumes === undefined ? {} : { volumes: options.volumes }) },
  });
  const stacks: LoadedStacks = new Map([['media', { manifest: stack, file: join(dataRoot, 'stacks', 'media.yml'), sha256: 'x'.repeat(64) }]]);
  const apps: LoadedManifests = new Map();
  const log = makeLog();
  const journal = new Journal(fs, join(dataRoot, 'agent', 'journal.jsonl'), clock, log);
  const ledger = await Ledger.open(fs, join(dataRoot, 'agent', 'ledger.jsonl'));
  const ports: MaintenancePorts = { docker, fs, files: nodeArchiveFiles(), clock, log };
  const ctx: MaintenanceContext = {
    dataRoot,
    backupRoot,
    apps,
    stacks,
    journal,
    ledger,
    helperImage: () => Promise.resolve(IMAGE),
    onStep: (s) => steps.push(s),
  };
  return { root, backupRoot, ports, ctx, ledger, journal, clock, cli, compose, events, steps, containers, images, cache, volumeContent, knobs };
}

function backupJob(o: { quiesce?: boolean; volume?: string; owner?: { kind: 'app' | 'stack'; name: string } } = {}): MaintenanceJob {
  return { jobId: uuid(), kind: 'volume-backup', volume: o.volume ?? VOLUME, owner: o.owner ?? { kind: 'stack', name: 'media' }, quiesce: o.quiesce ?? false };
}

function restoreJob(archiveId: string): MaintenanceJob {
  return { jobId: uuid(), kind: 'volume-restore', volume: VOLUME, owner: { kind: 'stack', name: 'media' }, archiveId };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** No argv anywhere is a shell (non-negotiable 1). */
function expectNoShell(w: World): void {
  for (const argv of [...w.cli, ...w.compose]) {
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).not.toContain('sh');
    expect(argv).not.toContain('-c');
    expect(argv.some((a) => a.includes('&&') || a.includes(';') || a.includes('|'))).toBe(false);
  }
}

describe('volume backup (SHP-REQ-201)', () => {
  it("runs the agent's own image with the volume read-only, writes a temp file, renames it, hashes it, records it", async () => {
    const w = await makeWorld();
    const job = backupJob();
    const result = await runMaintenance(w.ports, w.ctx, job);
    expect(result.state).toBe('succeeded');

    const dir = join(w.backupRoot, 'volumes', VOLUME);
    const [argv] = w.cli;
    const tmpName = argv?.[argv.indexOf('-cpf') + 1]?.replace('/out/', '') ?? '';
    expect(tmpName).toMatch(/^\.20261022T030405Z-.+\.tar\.zst\.tmp$/);
    expect(argv).toEqual([
      'run',
      '--rm',
      '--name',
      expect.stringMatching(new RegExp(`^shipyard-maintenance-${job.jobId}-archive-`)) as unknown,
      '--network',
      'none',
      '--read-only',
      '--entrypoint',
      'tar',
      '-v',
      `${VOLUME}:/volume:ro`,
      '-v',
      `${dir}:/out`,
      IMAGE,
      '--zstd',
      '--numeric-owner',
      '-cpf',
      `/out/${tmpName}`,
      '-C',
      '/volume',
      '.',
    ]);
    expect(w.cli).toHaveLength(1);

    // The temp file became <timestamp>.tar.zst: 0600 in a 0700 directory, and nothing else is left.
    expect(await readdir(dir)).toEqual(['20261022T030405Z.tar.zst']);
    const file = join(dir, '20261022T030405Z.tar.zst');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(w.backupRoot, 'volumes'))).mode & 0o777).toBe(0o700);

    const archive = result.archive;
    expect(archive).toEqual({
      archiveId: expect.any(String) as unknown,
      volume: VOLUME,
      owner: { kind: 'stack', name: 'media' },
      createdAt: '2026-10-22T03:04:05.678Z',
      sizeBytes: 'archive of original'.length,
      sha256: sha256('archive of original'),
      quiesced: false,
    });
    // The path never leaves the agent; only its ledger holds it.
    expect(JSON.stringify(result)).not.toContain(w.backupRoot);
    expect(w.ledger.volumeArchives(VOLUME)).toEqual([{ kind: 'volume-archive', ...archive, file }]);
    expect(result.removedArchives).toEqual([]);
    expect(w.compose).toEqual([]);
    expect(w.steps).toEqual(['checking', 'archiving', 'retaining']);
    expectNoShell(w);
  });

  it('journals the job and the archive step before the helper runs', async () => {
    const w = await makeWorld();
    await runMaintenance(w.ports, w.ctx, backupJob());
    const at = (e: string): number => w.events.indexOf(e);
    expect(at(`journal:start:${MAINTENANCE_STEP}`)).toBeLessThan(at(`journal:start:${maintenanceStep('volume-backup', 'archive')}`));
    expect(at(`journal:start:${maintenanceStep('volume-backup', 'archive')}`)).toBeLessThan(at('docker:run --rm'));
    expect(w.events.at(-1)).toBe(`journal:end:${MAINTENANCE_STEP}`);
    // Never the helper's output (non-negotiable 10).
    const lines = (await w.journal.readAll()).filter((e) => e.step.startsWith('maintenance'));
    expect(lines.every((e) => e.output === undefined)).toBe(true);
  });

  it('quiesce stops the project, archives, and starts it again', async () => {
    const w = await makeWorld();
    const result = await runMaintenance(w.ports, w.ctx, backupJob({ quiesce: true }));
    expect(result).toMatchObject({ state: 'succeeded', archive: { quiesced: true } });
    expect(w.compose).toEqual([['stop'], ['start']]);
    expect(w.events.filter((e) => e.startsWith('compose') || e.startsWith('docker'))).toEqual(['compose:stop', 'docker:run --rm', 'compose:start']);
    expect(w.steps).toEqual(['checking', 'stopping', 'archiving', 'starting', 'retaining']);
  });

  it('quiesce starts the project again even when the archive fails, and removes the partial file', async () => {
    const w = await makeWorld();
    w.knobs.tarExit = 2;
    const result = await runMaintenance(w.ports, w.ctx, backupJob({ quiesce: true }));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'backup_failed' } });
    expect(result.archive).toBeUndefined();
    expect(w.compose).toEqual([['stop'], ['start']]);
    expect(await readdir(join(w.backupRoot, 'volumes', VOLUME))).toEqual([]);
    expect(w.ledger.volumeArchives()).toEqual([]);
    // tar's stderr is not reported.
    expect(result.output ?? '').not.toContain('boom');
  });

  it('a stop that fails still gets a start, and nothing is archived', async () => {
    const w = await makeWorld();
    w.knobs.stopExit = 1;
    const result = await runMaintenance(w.ports, w.ctx, backupJob({ quiesce: true }));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'backup_failed' } });
    expect(w.compose).toEqual([['stop'], ['start']]);
    expect(w.cli).toEqual([]);
  });

  it('a start that fails after a good archive keeps the archive and says the stack may be stopped', async () => {
    const w = await makeWorld();
    w.knobs.startExit = 1;
    const result = await runMaintenance(w.ports, w.ctx, backupJob({ quiesce: true }));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'step_failed', message: expect.stringContaining('may still be stopped') as unknown } });
    expect(result.archive).toBeDefined();
    expect(w.ledger.volumeArchives()).toHaveLength(1);
  });

  it('volume_not_owned: an owner the agent does not manage, or whose project does not mount the volume', async () => {
    const w = await makeWorld();
    await expect(runMaintenance(w.ports, w.ctx, backupJob({ owner: { kind: 'stack', name: 'other' } }))).resolves.toMatchObject({
      state: 'refused',
      refusal: { code: 'volume_not_owned' },
    });
    await expect(runMaintenance(w.ports, w.ctx, backupJob({ owner: { kind: 'app', name: 'media' } }))).resolves.toMatchObject({
      state: 'refused',
      refusal: { code: 'volume_not_owned' },
    });
    // Mounted, but by a container of another project.
    w.containers.splice(0, 1, container({ name: 'x', compose: { project: 'elsewhere', service: 'x' }, mounts: [volumeMount(VOLUME)] }));
    await expect(runMaintenance(w.ports, w.ctx, backupJob())).resolves.toMatchObject({ state: 'refused', refusal: { code: 'volume_not_owned' } });
    expect(w.cli).toEqual([]);
    expect(w.compose).toEqual([]);
    expect((await w.journal.readAll()).length).toBe(0);
  });

  it('refuses when the agent cannot find its own image, and never pulls another', async () => {
    const w = await makeWorld();
    w.ctx.helperImage = () => Promise.reject(new Error('not in a container'));
    await expect(runMaintenance(w.ports, w.ctx, backupJob())).resolves.toMatchObject({ state: 'refused', refusal: { code: 'step_failed' } });
    expect(w.cli).toEqual([]);
  });

  it("is refused locked while the owner's deploy lock is held", async () => {
    const w = await makeWorld();
    w.ctx.lockOwner = () => Promise.resolve({ code: 'locked', gate: 'G4', message: 'media is locked', fix: 'wait' });
    await expect(runMaintenance(w.ports, w.ctx, backupJob())).resolves.toMatchObject({ state: 'refused', refusal: { code: 'locked' } });
    expect(w.cli).toEqual([]);
  });
});

describe('retention (SHP-REQ-206)', () => {
  it('keeps the newest `retain` archives of the volume and removes the oldest, recording each removal', async () => {
    const w = await makeWorld({ retain: 2 });
    const taken: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await runMaintenance(w.ports, w.ctx, backupJob());
      taken.push(r.archive?.archiveId ?? '');
      if (i < 2) expect(r.removedArchives).toEqual([]);
      else expect(r.removedArchives).toEqual([taken[0]]);
      w.clock.advance(60_000);
    }
    expect(w.ledger.volumeArchives(VOLUME).map((a) => a.archiveId)).toEqual(taken.slice(1));
    expect(w.ledger.volumeArchive(taken[0] ?? '')).toBeNull();
    expect((await readdir(join(w.backupRoot, 'volumes', VOLUME))).sort()).toEqual(['20261022T030505Z.tar.zst', '20261022T030605Z.tar.zst']);
  });

  it('two archives in the same second do not overwrite each other', async () => {
    const w = await makeWorld();
    await runMaintenance(w.ports, w.ctx, backupJob());
    await runMaintenance(w.ports, w.ctx, backupJob());
    expect(await readdir(join(w.backupRoot, 'volumes', VOLUME))).toHaveLength(2);
    expect(w.ledger.volumeArchives(VOLUME)).toHaveLength(2);
  });
});

describe('volume restore (SHP-REQ-202)', () => {
  async function backedUp(w: World): Promise<string> {
    const r = await runMaintenance(w.ports, w.ctx, backupJob());
    w.clock.advance(60_000);
    w.cli.length = 0;
    w.compose.length = 0;
    w.steps.length = 0;
    return r.archive?.archiveId ?? '';
  }

  it('stops the project, takes a safety archive, empties the volume, extracts, and starts it again', async () => {
    const w = await makeWorld();
    const archiveId = await backedUp(w);
    w.volumeContent.value = 'changed';
    const job = restoreJob(archiveId);
    const result = await runMaintenance(w.ports, w.ctx, job);
    expect(result.state).toBe('succeeded');
    expect(w.volumeContent.value).toBe('original');

    const dir = join(w.backupRoot, 'volumes', VOLUME);
    expect(w.compose).toEqual([['stop'], ['start']]);
    expect(w.cli).toHaveLength(3);
    expect(w.cli[1]).toEqual(['run', '--rm', '--name', `shipyard-maintenance-${job.jobId}-empty`, '--network', 'none', '--read-only', '--entrypoint', 'find', '-v', `${VOLUME}:/volume`, IMAGE, '/volume', '-mindepth', '1', '-delete']);
    expect(w.cli[2]).toEqual([
      'run',
      '--rm',
      '--name',
      `shipyard-maintenance-${job.jobId}-extract`,
      '--network',
      'none',
      '--read-only',
      '--entrypoint',
      'tar',
      '-v',
      `${VOLUME}:/volume`,
      '-v',
      `${dir}:/in:ro`,
      IMAGE,
      '--zstd',
      '--numeric-owner',
      '-xpf',
      '/in/20261022T030405Z.tar.zst',
      '-C',
      '/volume',
    ]);
    // The safety archive holds what was there before, quiesced, and the output names it.
    const archives = w.ledger.volumeArchives(VOLUME);
    expect(archives).toHaveLength(2);
    const safety = archives[1];
    expect(safety).toMatchObject({ quiesced: true, sha256: sha256('archive of changed') });
    expect(result.output).toContain(safety?.archiveId ?? 'missing');
    expect(w.steps).toEqual(['checking', 'stopping', 'archiving', 'restoring', 'starting']);
    expectNoShell(w);
  });

  it('archive_not_found: not in this ledger, or an archive of another volume', async () => {
    const w = await makeWorld();
    await expect(runMaintenance(w.ports, w.ctx, restoreJob(uuid()))).resolves.toMatchObject({ state: 'refused', refusal: { code: 'archive_not_found' } });
    w.containers.push(container({ name: 'media-db-1', compose: { project: PROJECT, service: 'db' }, mounts: [volumeMount('media_db')] }));
    const other = await runMaintenance(w.ports, w.ctx, backupJob({ volume: 'media_db' }));
    await expect(runMaintenance(w.ports, w.ctx, restoreJob(other.archive?.archiveId ?? ''))).resolves.toMatchObject({ state: 'refused', refusal: { code: 'archive_not_found' } });
    expect(w.compose).toEqual([]);
  });

  it('archive_not_found: the file changed since it was taken, or is gone', async () => {
    const w = await makeWorld();
    const archiveId = await backedUp(w);
    const file = w.ledger.volumeArchive(archiveId)?.file ?? '';
    await writeFile(file, 'archive of something else');
    await expect(runMaintenance(w.ports, w.ctx, restoreJob(archiveId))).resolves.toMatchObject({
      state: 'refused',
      refusal: { code: 'archive_not_found', message: expect.stringContaining('changed') as unknown },
    });
    await rm(file);
    await expect(runMaintenance(w.ports, w.ctx, restoreJob(archiveId))).resolves.toMatchObject({ state: 'refused', refusal: { code: 'archive_not_found' } });
    expect(w.compose).toEqual([]);
    expect(w.cli).toEqual([]);
  });

  it('an extract that fails still starts the project, and names the safety archive', async () => {
    const w = await makeWorld();
    const archiveId = await backedUp(w);
    w.knobs.extractExit = 2;
    const result = await runMaintenance(w.ports, w.ctx, restoreJob(archiveId));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'step_failed' } });
    const safety = w.ledger.volumeArchives(VOLUME)[1]?.archiveId ?? 'missing';
    expect(result.refusal?.message).toContain(safety);
    expect(w.compose).toEqual([['stop'], ['start']]);
  });

  it('a safety backup that fails leaves the volume untouched and starts the project', async () => {
    const w = await makeWorld();
    const archiveId = await backedUp(w);
    w.volumeContent.value = 'changed';
    w.knobs.tarExit = 1;
    const result = await runMaintenance(w.ports, w.ctx, restoreJob(archiveId));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'backup_failed' } });
    expect(w.volumeContent.value).toBe('changed');
    expect(w.cli.filter((a) => a.includes('find') || a.includes('-xpf'))).toEqual([]);
    expect(w.compose).toEqual([['stop'], ['start']]);
  });

  it('a start that fails after a good restore is reported', async () => {
    const w = await makeWorld();
    const archiveId = await backedUp(w);
    w.knobs.startExit = 1;
    await expect(runMaintenance(w.ports, w.ctx, restoreJob(archiveId))).resolves.toMatchObject({
      state: 'failed',
      refusal: { code: 'step_failed', message: expect.stringContaining('restored') as unknown },
    });
  });
});

describe('volume delete (SHP-REQ-203)', () => {
  it('refuses volume_in_use while any container mounts it, even a stopped one', async () => {
    const w = await makeWorld();
    w.containers.push(container({ name: 'old-job', state: 'exited', mounts: [volumeMount('orphan')] }));
    const result = await runMaintenance(w.ports, w.ctx, { jobId: uuid(), kind: 'volume-delete', volume: 'orphan' });
    expect(result).toMatchObject({ state: 'refused', refusal: { code: 'volume_in_use', message: expect.stringContaining('old-job (exited)') as unknown } });
    expect(w.cli).toEqual([]);
  });

  it('removes a volume nothing mounts with `docker volume rm`, no -f, journaled first', async () => {
    const w = await makeWorld();
    const result = await runMaintenance(w.ports, w.ctx, { jobId: uuid(), kind: 'volume-delete', volume: 'orphan' });
    expect(result.state).toBe('succeeded');
    expect(w.cli).toEqual([['volume', 'rm', 'orphan']]);
    const at = (e: string): number => w.events.indexOf(e);
    expect(at(`journal:start:${maintenanceStep('volume-delete', 'remove')}`)).toBeLessThan(at('docker:volume rm'));
  });

  it('a `volume rm` that fails is failed, not succeeded', async () => {
    const w = await makeWorld();
    w.knobs.rmExit = 1;
    await expect(runMaintenance(w.ports, w.ctx, { jobId: uuid(), kind: 'volume-delete', volume: 'orphan' })).resolves.toMatchObject({ state: 'failed' });
  });
});

describe('prune (SHP-REQ-205)', () => {
  const now = Date.parse('2026-10-22T03:04:05.678Z');
  const hoursAgo = (h: number): string => new Date(now - h * 3_600_000).toISOString();
  const img = (c: string, o: Partial<HostImageRecord> = {}): HostImageRecord => ({ id: `sha256:${c.repeat(64)}`, repoTags: [], repoDigests: [], sizeBytes: 100, createdAt: hoursAgo(1), ...o });

  function seed(w: World): void {
    w.images.push(
      img('1'), // dangling, unused → listed
      img('2'), // dangling but a stopped container uses it → never
      img('3', { repoDigests: ['lscr.io/x@sha256:' + '9'.repeat(64)], createdAt: hoursAgo(1) }), // digest-only: not dangling, too new
      img('4', { repoTags: ['old:1'], createdAt: hoursAgo(200), sizeBytes: 400 }), // unused and old → listed
      img('5', { repoTags: ['new:1'], createdAt: hoursAgo(2) }), // unused but new → never
      img('6', { repoTags: ['used:1'], createdAt: hoursAgo(500) }), // old but used → never
      img('7', { repoTags: ['a:1', 'b:1'], createdAt: hoursAgo(300), sizeBytes: 700 }), // unused, old, two tags → listed
    );
    w.containers.push(container({ name: 'stopped', state: 'exited', imageId: `sha256:${'2'.repeat(64)}` }));
    w.containers.push(container({ name: 'runs-6', imageId: `sha256:${'6'.repeat(64)}` }));
    w.cache.push(
      { id: 'oldcache1', sizeBytes: 50, createdAt: hoursAgo(400), lastUsedAt: hoursAgo(300), inUse: false }, // listed
      { id: 'inuse1', sizeBytes: 50, createdAt: hoursAgo(400), lastUsedAt: hoursAgo(300), inUse: true }, // never
      { id: 'recent1', sizeBytes: 50, createdAt: hoursAgo(400), lastUsedAt: hoursAgo(1), inUse: false }, // used lately → never
    );
  }

  const dry = (): MaintenanceJob => ({ jobId: uuid(), kind: 'prune', dryRun: true, images: { dangling: true, unusedOlderThanHours: 168 }, buildCache: { olderThanHours: 168 } });
  const real = (fromDryRunId: string): MaintenanceJob => ({
    jobId: uuid(),
    kind: 'prune',
    dryRun: false,
    fromDryRunId,
    images: { dangling: true, unusedOlderThanHours: 168 },
    buildCache: { olderThanHours: 168 },
  });

  it('a dry run lists dangling, unused-and-old images and old cache — never used images or in-use cache — and removes nothing', async () => {
    const w = await makeWorld();
    seed(w);
    const job = dry();
    const result = await runMaintenance(w.ports, w.ctx, job);
    expect(result.state).toBe('succeeded');
    const items = result.prune?.items ?? [];
    expect(items.map((i) => `${i.kind}:${i.id.slice(0, 8)}:${i.reason}`)).toEqual([
      'image:sha256:1:dangling',
      'image:sha256:4:unused',
      'image:sha256:7:unused',
      'build-cache:oldcache:old-cache',
    ]);
    expect(items[1]?.ref).toBe('old:1');
    expect(result.prune).toMatchObject({ reclaimableBytes: 100 + 400 + 700 + 50, reclaimedBytes: null });
    expect(w.cli).toEqual([]);
    expect(w.ledger.prunePlan(job.jobId)?.items).toEqual(items);
  });

  it('dangling only, or no cache: the other sets are left alone', async () => {
    const w = await makeWorld();
    seed(w);
    const result = await runMaintenance(w.ports, w.ctx, { jobId: uuid(), kind: 'prune', dryRun: true, images: { dangling: true, unusedOlderThanHours: null }, buildCache: { olderThanHours: null } });
    expect(result.prune?.items.map((i) => i.reason)).toEqual(['dangling']);
  });

  it('dry_run_required: a real prune with no plan in this ledger removes nothing', async () => {
    const w = await makeWorld();
    seed(w);
    await expect(runMaintenance(w.ports, w.ctx, real(uuid()))).resolves.toMatchObject({ state: 'refused', refusal: { code: 'dry_run_required' } });
    expect(w.cli).toEqual([]);
  });

  it('a real prune removes only the planned items still eligible, without -f, and reports what it reclaimed', async () => {
    const w = await makeWorld();
    seed(w);
    const plan = await runMaintenance(w.ports, w.ctx, dry());
    // Meanwhile a container starts using image 4, and a new dangling image appears (not in the plan).
    w.containers.push(container({ name: 'now-uses-4', imageId: `sha256:${'4'.repeat(64)}` }));
    w.images.push(img('8'));
    const result = await runMaintenance(w.ports, w.ctx, real(plan.jobId));
    expect(result.state).toBe('succeeded');
    expect(w.cli).toEqual([
      ['image', 'rm', `sha256:${'1'.repeat(64)}`],
      ['image', 'rm', 'a:1', 'b:1'],
      ['builder', 'prune', '--force', '--filter', 'id=oldcache1'],
    ]);
    expect(w.cli.flat()).not.toContain('-f');
    expect(result.prune).toMatchObject({ reclaimableBytes: 100 + 700 + 50, reclaimedBytes: 100 + 700 + 50 });
    expect(result.prune?.items.map((i) => i.id.slice(0, 8))).toEqual(['sha256:1', 'sha256:7', 'oldcache']);
    expect(result.output).toContain('no longer eligible');
    expectNoShell(w);
  });

  it('a real prune is refused locked while a deploy runs on the host', async () => {
    const w = await makeWorld();
    seed(w);
    const plan = await runMaintenance(w.ports, w.ctx, dry());
    w.ctx.busy = () => true;
    await expect(runMaintenance(w.ports, w.ctx, real(plan.jobId))).resolves.toMatchObject({ state: 'refused', refusal: { code: 'locked' } });
    expect(w.cli).toEqual([]);
  });

  it('a removal Docker refuses makes the prune failed, keeping what was removed', async () => {
    const w = await makeWorld();
    seed(w);
    const plan = await runMaintenance(w.ports, w.ctx, dry());
    w.knobs.rmExit = 1;
    const result = await runMaintenance(w.ports, w.ctx, real(plan.jobId));
    expect(result).toMatchObject({ state: 'failed', refusal: { code: 'step_failed' }, prune: { reclaimedBytes: 0 } });
  });
});

describe('restart recovery', () => {
  it('starts again a project an interrupted quiesced backup had stopped, removes its temp file and helper', async () => {
    const w = await makeWorld();
    const jobId = uuid();
    const tmp = join(w.root, '.x.tar.zst.tmp');
    await writeFile(tmp, 'partial');
    await w.journal.begin({ deployId: jobId, app: 'media', step: MAINTENANCE_STEP, detail: { kind: 'volume-backup', volume: VOLUME, composeFiles: ['/c.yml'], project: PROJECT } });
    await w.journal.begin({ deployId: jobId, app: 'media', step: maintenanceStep('volume-backup', 'stop'), argv: ['stop'] });
    await w.journal.end({ deployId: jobId, app: 'media', step: maintenanceStep('volume-backup', 'stop'), argv: ['stop'], exitCode: 0 });
    await w.journal.begin({ deployId: jobId, app: 'media', step: maintenanceStep('volume-backup', 'archive'), detail: { tmp, helper: `shipyard-maintenance-${jobId}-archive-1` } });

    const recovered = await recoverInterruptedMaintenance(w.ports, w.journal);
    expect(recovered).toMatchObject([{ jobId, kind: 'volume-backup', restarted: true, startExitCode: 0, report: true, lastStep: maintenanceStep('volume-backup', 'archive') }]);
    expect(w.compose).toEqual([['start']]);
    expect(w.cli).toEqual([['rm', '--force', `shipyard-maintenance-${jobId}-archive-1`]]);
    await expect(stat(tmp)).rejects.toThrow();
    // Still open until the agent has told the server; then closed for good.
    expect(await w.journal.unfinishedMaintenance()).toHaveLength(1);
    const first = recovered[0];
    if (first === undefined) throw new Error('nothing recovered');
    await closeInterruptedMaintenance(w.journal, first);
    expect(await w.journal.unfinishedMaintenance()).toEqual([]);
  });

  it('a job that had started its project again, or never stopped it, is not started again', async () => {
    const w = await makeWorld();
    const a = uuid();
    await w.journal.begin({ deployId: a, app: VOLUME, step: MAINTENANCE_STEP, detail: { kind: 'volume-delete', volume: 'orphan' } });
    const b = uuid();
    await w.journal.begin({ deployId: b, app: 'media', step: MAINTENANCE_STEP, detail: { kind: 'volume-restore', composeFiles: ['/c.yml'], project: PROJECT } });
    await w.journal.begin({ deployId: b, app: 'media', step: maintenanceStep('volume-restore', 'stop') });
    await w.journal.end({ deployId: b, app: 'media', step: maintenanceStep('volume-restore', 'stop'), exitCode: 0 });
    await w.journal.begin({ deployId: b, app: 'media', step: maintenanceStep('volume-restore', 'start') });
    await w.journal.end({ deployId: b, app: 'media', step: maintenanceStep('volume-restore', 'start'), exitCode: 0 });
    const recovered = await recoverInterruptedMaintenance(w.ports, w.journal);
    expect(recovered.map((r) => r.restarted)).toEqual([false, false]);
    expect(w.compose).toEqual([]);
  });

  it('maintenance lines are never read as an interrupted deploy, action or stack update', async () => {
    const w = await makeWorld();
    w.knobs.tarExit = 0;
    await w.journal.begin({ deployId: uuid(), app: 'media', step: MAINTENANCE_STEP, detail: { kind: 'volume-backup' } });
    await runMaintenance(w.ports, w.ctx, backupJob({ quiesce: true }));
    expect(await w.journal.unfinished()).toEqual([]);
    expect(await w.journal.unfinishedActions()).toEqual([]);
    expect(await w.journal.unfinishedStackUpdates()).toEqual([]);
  });
});

describe('before a stack update (volumeBackups.beforeUpdate)', () => {
  it("backs up every named volume the stack's containers mount, with its quiesce, inside the held lock", async () => {
    const w = await makeWorld({ quiesce: true });
    w.containers.push(container({ name: 'media-db-1', compose: { project: PROJECT, service: 'db' }, mounts: [volumeMount('media_db')] }));
    const lock = vi.fn();
    w.ctx.lockOwner = lock;
    const out = await backupVolumesBeforeUpdate(w.ports, w.ctx, { stack: 'media', updateId: uuid() });
    expect(out.refusal).toBeNull();
    expect(out.archives).toHaveLength(2);
    expect(w.ledger.volumeArchives().map((a) => a.volume)).toEqual(['media_config', 'media_db']);
    expect(lock).not.toHaveBeenCalled();
    expect(w.compose).toEqual([['stop'], ['start'], ['stop'], ['start']]);
    // Its brackets are closed and are not jobs the server knows.
    expect(await w.journal.unfinishedMaintenance()).toEqual([]);
    const brackets = (await w.journal.readAll()).filter((e) => e.step === MAINTENANCE_STEP && e.phase === 'start');
    expect(brackets.every((e) => e.detail?.['report'] === false)).toBe(true);
  });

  it('a listed volume the stack does not mount, or a failed archive, is a refusal', async () => {
    const w = await makeWorld({ volumes: ['not_mounted'] });
    await expect(backupVolumesBeforeUpdate(w.ports, w.ctx, { stack: 'media', updateId: uuid() })).resolves.toMatchObject({ refusal: { code: 'volume_not_owned' } });
    const x = await makeWorld();
    x.knobs.tarExit = 1;
    await expect(backupVolumesBeforeUpdate(x.ports, x.ctx, { stack: 'media', updateId: uuid() })).resolves.toMatchObject({ refusal: { code: 'backup_failed' } });
  });
});

describe('archiveTimestamp', () => {
  it('is UTC YYYYMMDDTHHMMSSZ', () => {
    expect(archiveTimestamp(new Date('2026-01-02T03:04:05.999Z'))).toBe('20260102T030405Z');
  });
});
