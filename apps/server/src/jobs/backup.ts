import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { ServiceDeps } from '../deps.js';
import type { Mailer } from '../mail/index.js';
import { runDrill } from './drill.js';

/**
 * Shipyard's own nightly `pg_dump`, and the restore drill that proves it (SHP-REQ-092, SHP-D-035,
 * SHP-T-6.3).
 *
 * Client tools are pinned to PostgreSQL 16: a newer `pg_dump` writes dumps a 16 server's
 * `pg_restore` refuses, so the job checks the version itself rather than trusting the image.
 * Commands are spawned with an argv array, never a shell string, and the password travels in
 * `PGPASSWORD` rather than on the command line.
 *
 * Every outcome is an audit event — `system.backup` / `system.drill`, entity `system` — which is
 * what the System screen reads. A failure is also emailed. Nothing here ever throws into the server.
 */

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command (argv only) and collects its output. Injected in tests; real `spawn` otherwise. */
export type ProcessRunner = (command: string, args: readonly string[], env: Record<string, string>) => Promise<RunResult>;

export const spawnRunner: ProcessRunner = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) });
    });
  });

export interface PgTools {
  readonly run: ProcessRunner;
  /** Directory holding pg_dump/pg_restore; unset means whatever is on PATH. */
  readonly binDir?: string | undefined;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export function toolPath(tools: PgTools, name: 'pg_dump' | 'pg_restore'): string {
  return tools.binDir === undefined ? name : join(tools.binDir, name);
}

/** Refuses anything but major version 16 of the named tool. */
export async function assertPg16(tools: PgTools, name: 'pg_dump' | 'pg_restore'): Promise<void> {
  let result: RunResult;
  try {
    result = await tools.run(toolPath(tools, name), ['--version'], {});
  } catch (err) {
    throw new BackupError(`${name} could not be run: ${err instanceof Error ? err.message : String(err)}`);
  }
  const major = /(\d+)(?:\.\d+)?/.exec(result.stdout)?.[1];
  if (result.code !== 0 || major !== '16') {
    throw new BackupError(
      `${name} must be PostgreSQL 16 client tools (a newer one writes dumps 16 cannot restore); got ${JSON.stringify(result.stdout.trim() || result.stderr.trim())}`,
    );
  }
}

/** Prisma-only query parameters libpq would reject as unknown. */
const PRISMA_ONLY_PARAMS = ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size', 'socket_timeout'];

/**
 * A libpq connection for a spawned tool: the URL without its password, and the password in
 * `PGPASSWORD`, so it is never in argv (`ps`). `database` replaces the path when given.
 */
export function libpqTarget(databaseUrl: string, database?: string): { url: string; env: Record<string, string> } {
  const url = new URL(databaseUrl);
  const env: Record<string, string> = {};
  if (url.password !== '') env['PGPASSWORD'] = decodeURIComponent(url.password);
  url.password = '';
  if (database !== undefined) url.pathname = `/${database}`;
  for (const param of PRISMA_ONLY_PARAMS) url.searchParams.delete(param);
  return { url: url.toString(), env };
}

export const DUMP_PREFIX = 'shipyard-';
export const DUMP_SUFFIX = '.dump';
const PARTIAL_SUFFIX = '.partial';
/** Always kept, however old: retention must never leave the host with no dump at all. */
export const KEEP_NEWEST = 3;

const isDump = (name: string): boolean => name.startsWith(DUMP_PREFIX) && name.endsWith(DUMP_SUFFIX);

/** `2026-09-25T03-30-00-000Z`: sortable, and legal in a file name. */
export const stamp = (now: Date): string => now.toISOString().replace(/[:.]/g, '-');

/** Dump file names in `dir`, newest first (the stamp sorts). Missing directory → none. */
export async function listDumps(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  });
  return names.filter(isDump).sort().reverse();
}

/**
 * Removes dumps older than the retention period, but never the newest {@link KEEP_NEWEST} — a
 * host whose backups stopped a month ago still has its last three. Also clears partial files a
 * crashed dump left behind. Returns the names removed.
 */
export async function pruneDumps(dir: string, retentionDays: number, now: Date): Promise<string[]> {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  const dumps = await listDumps(dir);
  for (const name of dumps.slice(KEEP_NEWEST)) {
    const info = await stat(join(dir, name));
    if (info.mtime.getTime() >= cutoff) continue;
    await unlink(join(dir, name));
    removed.push(name);
  }
  for (const name of await readdir(dir)) {
    if (!name.startsWith(`.${DUMP_PREFIX}`) || !name.endsWith(PARTIAL_SUFFIX)) continue;
    const info = await stat(join(dir, name));
    if (now.getTime() - info.mtime.getTime() < 24 * 60 * 60 * 1000) continue;
    await unlink(join(dir, name));
    removed.push(name);
  }
  return removed;
}

export interface BackupOptions extends PgTools {
  readonly config: Pick<Config, 'DATABASE_URL' | 'BACKUP_DIR' | 'BACKUP_RETENTION_DAYS'>;
  readonly now?: () => Date;
}

export interface BackupResult {
  readonly file: string;
  readonly bytes: number;
  readonly pruned: string[];
}

/**
 * `pg_dump --format=custom` into BACKUP_DIR under a temporary name, renamed only once it exited 0
 * and is non-empty — so a half-written file is never the newest dump. Then prunes.
 */
export async function takeBackup(options: BackupOptions): Promise<BackupResult> {
  const now = options.now ?? (() => new Date());
  const dir = options.config.BACKUP_DIR;
  await assertPg16(options, 'pg_dump');
  await mkdir(dir, { recursive: true });

  const name = `${DUMP_PREFIX}${stamp(now())}${DUMP_SUFFIX}`;
  const file = join(dir, name);
  const partial = join(dir, `.${name}${PARTIAL_SUFFIX}`);
  const target = libpqTarget(options.config.DATABASE_URL);
  // `--no-owner --no-privileges`: a dump that only restores as the role that made it fails on
  // the day it is needed, on a fresh host.
  const args = ['--format=custom', '--no-owner', '--no-privileges', '--file', partial, `--dbname=${target.url}`];

  try {
    const result = await options.run(toolPath(options, 'pg_dump'), args, target.env);
    if (result.code !== 0) throw new BackupError(`pg_dump exited ${String(result.code)}: ${result.stderr.trim()}`);
    const info = await stat(partial).catch(() => null);
    if (info === null || info.size === 0) throw new BackupError('pg_dump exited 0 but wrote an empty dump');
    await rename(partial, file);
    const pruned = await pruneDumps(dir, options.config.BACKUP_RETENTION_DAYS, now());
    return { file, bytes: info.size, pruned };
  } finally {
    await unlink(partial).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Audited, alerted jobs: what the timer and the host CLI both run.

export type JobDeps = Pick<ServiceDeps, 'db' | 'logger' | 'config'>;

export interface JobOptions extends Partial<PgTools> {
  readonly now?: () => Date;
  /** Who ran it, for the audit trail: the nightly timer, or `host-admin` on demand. */
  readonly actorLabel?: string;
}

export interface BackupOutcome {
  readonly ok: boolean;
  readonly file?: string;
  readonly bytes?: number;
  readonly durationMs: number;
  readonly error?: string;
}

export interface DrillOutcome {
  readonly ok: boolean;
  readonly file?: string;
  readonly tables?: number;
  readonly migration?: string;
  readonly durationMs: number;
  readonly error?: string;
}

/** Bounded: an error is for a person to read on the System screen, not a log to store. */
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

async function audit(deps: JobDeps, kind: 'backup' | 'drill', actorLabel: string, after: object): Promise<void> {
  try {
    await deps.db.auditEvent.create({
      data: { actorType: 'system', actorLabel, action: `system.${kind}`, entityType: 'system', entityId: kind, after },
    });
  } catch (err) {
    deps.logger.error({ err: message(err), kind }, 'could not record the backup outcome');
  }
}

/** Takes a backup, records `system.backup`, and emails on failure. Never throws. */
export async function runBackupJob(deps: JobDeps, mailer: Mailer | undefined, options: JobOptions = {}): Promise<BackupOutcome> {
  const now = options.now ?? (() => new Date());
  const started = now().getTime();
  const actorLabel = options.actorLabel ?? 'nightly-backup';
  let outcome: BackupOutcome;
  try {
    const result = await takeBackup({ config: deps.config, run: options.run ?? spawnRunner, binDir: options.binDir, now });
    outcome = { ok: true, file: result.file, bytes: result.bytes, durationMs: now().getTime() - started };
    deps.logger.info({ file: result.file, bytes: result.bytes, pruned: result.pruned }, 'database backed up');
  } catch (err) {
    outcome = { ok: false, durationMs: now().getTime() - started, error: message(err) };
    deps.logger.error({ err: outcome.error }, 'database backup failed');
    await mailer?.send({
      kind: 'backup-failed',
      subject: 'Nightly database backup failed',
      body: `Shipyard's own database backup failed:\n\n${outcome.error ?? ''}\n\nThe newest good dump is still in ${deps.config.BACKUP_DIR}. Run it by hand on the host:\ndocker compose -p shipyard exec server node dist/cli/host-admin.js backup`,
    });
  }
  await audit(deps, 'backup', actorLabel, outcome);
  return outcome;
}

/** Runs the restore drill against the newest dump, records `system.drill`, and emails on failure. Never throws. */
export async function runDrillJob(deps: JobDeps, mailer: Mailer | undefined, options: JobOptions = {}): Promise<DrillOutcome> {
  const now = options.now ?? (() => new Date());
  const started = now().getTime();
  const actorLabel = options.actorLabel ?? 'nightly-backup';
  let outcome: DrillOutcome;
  try {
    const result = await runDrill({ config: deps.config, run: options.run ?? spawnRunner, binDir: options.binDir, now });
    outcome = { ok: true, file: result.file, tables: result.tables, migration: result.migration, durationMs: now().getTime() - started };
    deps.logger.info({ ...result }, 'restore drill passed');
  } catch (err) {
    outcome = { ok: false, durationMs: now().getTime() - started, error: message(err) };
    deps.logger.error({ err: outcome.error }, 'restore drill failed');
    await mailer?.send({
      kind: 'drill-failed',
      subject: 'Restore drill failed',
      body: `The restore drill could not prove last night's dump restores:\n\n${outcome.error ?? ''}\n\nRe-run it on the host:\ndocker compose -p shipyard exec server node dist/cli/host-admin.js drill`,
    });
  }
  await audit(deps, 'drill', actorLabel, outcome);
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// The nightly timer.

/** 03:30 server local time: quiet on a home server, and after any evening deploys. */
export const NIGHTLY_HOUR = 3;
export const NIGHTLY_MINUTE = 30;
/** After start, a missing or older dump than this is taken at once rather than waiting for the night. */
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60_000;

/** The next 03:30 local strictly after `from`. */
export function nextNightlyRun(from: Date): Date {
  const next = new Date(from);
  next.setHours(NIGHTLY_HOUR, NIGHTLY_MINUTE, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export interface StartBackupsOptions extends JobOptions {
  readonly startupDelayMs?: number;
}

/** Starts the nightly backup + drill (SHP-T-6.3), and a catch-up backup shortly after start. */
export function startBackups(deps: ServiceDeps, mailer: Mailer, options: StartBackupsOptions = {}): { stop: () => Promise<void> } {
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const exclusive = (work: () => Promise<void>): void => {
    running = running.then(async () => {
      if (stopped) return;
      try {
        await work();
      } catch (err) {
        // The jobs never throw; this is the belt to their braces. The server must not crash.
        deps.logger.error({ err: message(err) }, 'backup timer failed');
      }
    });
  };

  const nightly = async (): Promise<void> => {
    const backup = await runBackupJob(deps, mailer, options);
    // A drill of yesterday's dump after tonight's failed is noise: the failure is already alerted.
    if (backup.ok && !stopped) await runDrillJob(deps, mailer, options);
  };

  const schedule = (): void => {
    if (stopped) return;
    const at = nextNightlyRun(now());
    timer = setTimeout(() => {
      exclusive(nightly);
      exclusive(() => {
        schedule();
        return Promise.resolve();
      });
    }, Math.max(0, at.getTime() - now().getTime()));
    timer.unref();
  };

  const catchUp = setTimeout(() => {
    exclusive(async () => {
      const newest = (await listDumps(deps.config.BACKUP_DIR))[0];
      const age = newest === undefined ? Infinity : now().getTime() - (await stat(join(deps.config.BACKUP_DIR, newest))).mtime.getTime();
      if (age > STALE_AFTER_MS) {
        deps.logger.info({ newest: newest ?? null }, 'no recent dump; taking one now');
        await runBackupJob(deps, mailer, options);
      }
    });
  }, options.startupDelayMs ?? STARTUP_DELAY_MS);
  catchUp.unref();

  schedule();

  return {
    stop: async () => {
      stopped = true;
      clearTimeout(catchUp);
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
}
