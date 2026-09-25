import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseManifestYaml } from '@shipyard/schema';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db.js';
import {
  type JobDeps,
  libpqTarget,
  nextNightlyRun,
  type ProcessRunner,
  pruneDumps,
  runBackupJob,
  runDrillJob,
  startBackups,
  takeBackup,
} from '../../src/jobs/backup.js';
import type { Alert, Mailer } from '../../src/mail/index.js';
import type { Config } from '../../src/config.js';
import type { ServiceDeps } from '../../src/deps.js';

const URL_WITH_PASSWORD = 'postgresql://shipyard:s%40cret@postgres:5432/shipyard?schema=public';
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shp-backup-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Call {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
}

/** A fake pg_dump: reports version 16 and writes `content` to the --file path. */
function fakeRunner(options: { version?: string; code?: number; content?: string; stderr?: string } = {}): { run: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: ProcessRunner = async (command, args, env) => {
    calls.push({ command, args, env });
    if (args[0] === '--version') return { code: 0, stdout: options.version ?? 'pg_dump (PostgreSQL) 16.15\n', stderr: '' };
    const file = args[args.indexOf('--file') + 1];
    if (file !== undefined && options.content !== undefined) await writeFile(file, options.content);
    return { code: options.code ?? 0, stdout: '', stderr: options.stderr ?? '' };
  };
  return { run, calls };
}

const config = (): Pick<Config, 'DATABASE_URL' | 'BACKUP_DIR' | 'BACKUP_RETENTION_DAYS'> => ({
  DATABASE_URL: URL_WITH_PASSWORD,
  BACKUP_DIR: dir,
  BACKUP_RETENTION_DAYS: 14,
});

describe('libpqTarget', () => {
  it('moves the password to PGPASSWORD and drops Prisma-only parameters', () => {
    const target = libpqTarget(URL_WITH_PASSWORD, 'scratch');
    expect(target.env).toEqual({ PGPASSWORD: 's@cret' });
    expect(target.url).toBe('postgresql://shipyard@postgres:5432/scratch');
  });
});

describe('takeBackup', () => {
  it('runs pg_dump with an argv array, the password in env, into a renamed custom-format file', async () => {
    const { run, calls } = fakeRunner({ content: 'PGDMP…' });
    const now = new Date('2026-09-25T03:30:00.000Z');
    const result = await takeBackup({ config: config(), run, binDir: '/opt/pg16/bin', now: () => now });

    expect(calls[0]).toMatchObject({ command: '/opt/pg16/bin/pg_dump', args: ['--version'] });
    const dump = calls[1];
    expect(dump?.command).toBe('/opt/pg16/bin/pg_dump');
    expect(dump?.args).toEqual([
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--file',
      join(dir, '.shipyard-2026-09-25T03-30-00-000Z.dump.partial'),
      '--dbname=postgresql://shipyard@postgres:5432/shipyard',
    ]);
    expect(dump?.env).toEqual({ PGPASSWORD: 's@cret' });
    expect(JSON.stringify(dump?.args)).not.toContain('s%40cret');

    expect(result.file).toBe(join(dir, 'shipyard-2026-09-25T03-30-00-000Z.dump'));
    expect(result.bytes).toBeGreaterThan(0);
    expect(await readdir(dir)).toEqual(['shipyard-2026-09-25T03-30-00-000Z.dump']);
  });

  it('refuses a pg_dump that is not version 16, without dumping', async () => {
    const { run, calls } = fakeRunner({ version: 'pg_dump (PostgreSQL) 17.2\n', content: 'x' });
    await expect(takeBackup({ config: config(), run })).rejects.toThrow(/must be PostgreSQL 16.*17\.2/);
    expect(calls).toHaveLength(1);
  });

  it('fails on a non-zero exit or an empty file, and leaves no partial file behind', async () => {
    const failing = fakeRunner({ code: 1, content: 'half', stderr: 'connection refused' });
    await expect(takeBackup({ config: config(), run: failing.run })).rejects.toThrow(/pg_dump exited 1: connection refused/);
    const empty = fakeRunner({ content: '' });
    await expect(takeBackup({ config: config(), run: empty.run })).rejects.toThrow(/empty dump/);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('pruneDumps', () => {
  it('removes dumps past retention but always keeps the newest three, however old', async () => {
    const now = new Date('2026-09-25T12:00:00.000Z');
    const names = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'].map((d) => `shipyard-${d}T03-30-00-000Z.dump`);
    for (const name of names) {
      await writeFile(join(dir, name), 'x');
      const when = new Date(now.getTime() - 200 * DAY);
      await utimes(join(dir, name), when, when);
    }
    await writeFile(join(dir, 'unrelated.txt'), 'x');

    const removed = await pruneDumps(dir, 14, now);
    expect(removed.sort()).toEqual(names.slice(0, 2));
    expect((await readdir(dir)).sort()).toEqual([...names.slice(2), 'unrelated.txt'].sort());
  });

  it('keeps dumps within retention', async () => {
    const now = new Date('2026-09-25T12:00:00.000Z');
    for (let i = 0; i < 6; i++) {
      const name = `shipyard-2026-09-${String(10 + i)}T03-30-00-000Z.dump`;
      await writeFile(join(dir, name), 'x');
      const when = new Date(now.getTime() - (15 - i) * DAY);
      await utimes(join(dir, name), when, when);
    }
    // Ages 15, 14, 13, 12, 11, 10 days: only the 15-day-old one is past 14 days.
    expect(await pruneDumps(dir, 14, now)).toEqual(['shipyard-2026-09-10T03-30-00-000Z.dump']);
  });
});

describe('nextNightlyRun', () => {
  it('is the next 03:30 local, never now', () => {
    const before = new Date(2026, 8, 25, 1, 0, 0);
    expect(nextNightlyRun(before)).toEqual(new Date(2026, 8, 25, 3, 30, 0));
    const at = new Date(2026, 8, 25, 3, 30, 0);
    expect(nextNightlyRun(at)).toEqual(new Date(2026, 8, 26, 3, 30, 0));
    const after = new Date(2026, 8, 25, 22, 0, 0);
    expect(nextNightlyRun(after)).toEqual(new Date(2026, 8, 26, 3, 30, 0));
  });
});

describe('runBackupJob / runDrillJob', () => {
  function harness(): { deps: JobDeps; audits: unknown[]; alerts: Alert[]; mailer: Mailer } {
    const audits: unknown[] = [];
    const alerts: Alert[] = [];
    const db = { auditEvent: { create: vi.fn((arg: { data: unknown }) => { audits.push(arg.data); return Promise.resolve(arg.data); }) } };
    const deps = { db: db as unknown as Db, logger: pino({ level: 'silent' }), config: { ...config(), BACKUP_DIR: dir } as Config };
    const mailer: Mailer = { send: (alert) => { alerts.push(alert); return Promise.resolve({ sent: true }); } };
    return { deps, audits, alerts, mailer };
  }

  it('records a successful backup as system.backup with ok, file and bytes, and sends no alert', async () => {
    const { deps, audits, alerts, mailer } = harness();
    const outcome = await runBackupJob(deps, mailer, { run: fakeRunner({ content: 'PGDMP' }).run });
    expect(outcome.ok).toBe(true);
    expect(alerts).toEqual([]);
    expect(audits).toEqual([
      {
        actorType: 'system',
        actorLabel: 'nightly-backup',
        action: 'system.backup',
        entityType: 'system',
        entityId: 'backup',
        after: { ok: true, file: outcome.file, bytes: 5, durationMs: expect.any(Number) as number },
      },
    ]);
  });

  it('turns a failed backup into a backup-failed alert and an ok:false audit, never a throw', async () => {
    const { deps, audits, alerts, mailer } = harness();
    const outcome = await runBackupJob(deps, mailer, { run: fakeRunner({ code: 1, stderr: 'no route to host' }).run, actorLabel: 'host-admin' });
    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('no route to host') as string });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'backup-failed', body: expect.stringContaining('no route to host') as string });
    expect(audits[0]).toMatchObject({ action: 'system.backup', actorLabel: 'host-admin', after: { ok: false, error: expect.stringContaining('no route to host') as string } });
  });

  it('turns a drill with no dump into a drill-failed alert and an ok:false system.drill audit', async () => {
    const { deps, audits, alerts, mailer } = harness();
    const run: ProcessRunner = () => Promise.resolve({ code: 0, stdout: 'pg_restore (PostgreSQL) 16.15', stderr: '' });
    const outcome = await runDrillJob(deps, mailer, { run });
    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('no dump') as string });
    expect(alerts[0]?.kind).toBe('drill-failed');
    expect(audits[0]).toMatchObject({ action: 'system.drill', entityType: 'system', entityId: 'drill', after: { ok: false } });
  });

  it('takes a catch-up backup soon after start when there is no recent dump, alerts on failure, and stops cleanly', async () => {
    const { deps, audits, alerts, mailer } = harness();
    const run: ProcessRunner = () => Promise.reject(new Error('spawn pg_dump ENOENT'));
    const jobs = startBackups({ ...deps, bus: {} } as unknown as ServiceDeps, mailer, { run, startupDelayMs: 0 });
    await vi.waitFor(() => { expect(audits).toHaveLength(1); });
    await jobs.stop();
    expect(audits[0]).toMatchObject({ action: 'system.backup', after: { ok: false, error: expect.stringContaining('ENOENT') as string } });
    expect(alerts.map((a) => a.kind)).toEqual(['backup-failed']);
  });

  it('skips the catch-up backup when a dump is fresh', async () => {
    const { deps, audits, mailer } = harness();
    await writeFile(join(dir, 'shipyard-2026-09-25T03-30-00-000Z.dump'), 'x');
    const run = vi.fn<ProcessRunner>();
    const jobs = startBackups({ ...deps, bus: {} } as unknown as ServiceDeps, mailer, { run, startupDelayMs: 0 });
    await new Promise((r) => setTimeout(r, 50));
    await jobs.stop();
    expect(run).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it('still returns when the audit write itself fails', async () => {
    const { deps, mailer } = harness();
    const broken = { ...deps, db: { auditEvent: { create: () => Promise.reject(new Error('db down')) } } as unknown as Db };
    await expect(runBackupJob(broken, mailer, { run: fakeRunner({ content: 'x' }).run })).resolves.toMatchObject({ ok: true });
  });
});

describe('docs/manifests/shipyard.yml', () => {
  it('backs the server up with the host-admin backup command into the host path of its bind mount', async () => {
    const text = await readFile(resolve(import.meta.dirname, '../../../../docs/manifests/shipyard.yml'), 'utf8');
    const manifest = parseManifestYaml(text);
    expect(manifest.steps?.backup).toEqual({ service: 'server', argv: ['node', 'dist/cli/host-admin.js', 'backup'], artifactsDir: '/DATA/shipyard/backups' });
  });
});
