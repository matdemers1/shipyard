import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import type { Config } from '../config.js';
import { assertPg16, BackupError, libpqTarget, listDumps, type PgTools, toolPath } from './backup.js';

/**
 * The restore drill (SHP-REQ-092): performed, not documented. It restores the newest dump into a
 * scratch database on the same server, asks the restored copy questions only a real restore can
 * answer, and drops the scratch database — always, even when the drill fails.
 *
 * What it asserts, and why these and not more:
 *
 * - **The schema came back.** The restored `_prisma_migrations` has an applied migration, and that
 *   migration is one the live database has applied too (the dump is of *this* database's lineage).
 *   When it is the live database's newest, every live table must exist in the restore as well. A
 *   dump taken before a deploy's migration is still a good dump, so an older migration is allowed.
 * - **The data came back.** Every key table exists and can be counted, and `user` and `app` —
 *   rows that are never hard-deleted — are non-empty in the restore wherever they are non-empty
 *   live. Exact equality with live counts would fail on every audit row written since the dump.
 *
 * The database user needs CREATEDB (the postgres image's POSTGRES_USER is a superuser, so it has it).
 */

export interface DrillOptions extends PgTools {
  readonly config: Pick<Config, 'DATABASE_URL' | 'BACKUP_DIR'>;
  readonly now?: () => Date;
}

export interface DrillResult {
  readonly file: string;
  /** Tables restored into the public schema. */
  readonly tables: number;
  /** The newest migration the restored database has applied. */
  readonly migration: string;
  /** Row counts of the key tables in the restore. */
  readonly counts: Record<string, number>;
  readonly scratch: string;
}

export const KEY_TABLES = ['user', 'app', 'deploy', 'deploy_target', 'audit_event'] as const;
/** Key tables whose rows are never hard-deleted: non-empty live means non-empty in any recent dump. */
const MUST_SURVIVE = new Set<string>(['user', 'app']);

const NEWEST_MIGRATION = `select migration_name from _prisma_migrations
  where finished_at is not null and rolled_back_at is null order by finished_at desc limit 1`;
const APPLIED_MIGRATIONS = `select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null`;
const PUBLIC_TABLES = `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;

function withDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** `shipyard_drill_20260925033000_ab12cd` — lower case, a legal unquoted identifier. */
export function scratchName(now: Date): string {
  const digits = now.toISOString().replace(/\D/g, '').slice(0, 14);
  return `shipyard_drill_${digits}_${randomBytes(3).toString('hex')}`;
}

async function counts(client: Client): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of KEY_TABLES) {
    const { rows } = await client.query<{ n: string }>(`select count(*)::text as n from "${table}"`);
    out[table] = Number(rows[0]?.n ?? '0');
  }
  return out;
}

async function tableNames(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ table_name: string }>(PUBLIC_TABLES);
  return new Set(rows.map((r) => r.table_name));
}

export async function runDrill(options: DrillOptions): Promise<DrillResult> {
  const now = options.now ?? (() => new Date());
  await assertPg16(options, 'pg_restore');

  const newest = (await listDumps(options.config.BACKUP_DIR))[0];
  if (newest === undefined) throw new BackupError(`there is no dump in ${options.config.BACKUP_DIR} to restore`);
  const file = join(options.config.BACKUP_DIR, newest);

  const live = new Client({ connectionString: options.config.DATABASE_URL });
  await live.connect();
  const scratch = scratchName(now());
  let created = false;
  let dropError: Error | undefined;
  let result: DrillResult;
  try {
    try {
      await live.query(`create database "${scratch}"`);
      created = true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '42501') {
        const role = decodeURIComponent(new URL(options.config.DATABASE_URL).username);
        throw new BackupError(
          `the database user "${role}" may not CREATE DATABASE, which the drill needs for its scratch copy; grant it with: ALTER ROLE "${role}" CREATEDB;`,
        );
      }
      throw new BackupError(`could not create the scratch database: ${err instanceof Error ? err.message : String(err)}`);
    }
    result = await restoreAndVerify(options, live, file, newest, scratch);
  } finally {
    // Always, even on failure: a drill that leaves scratch databases behind eventually fills the
    // disk it protects. A failed drop never hides why the drill failed (the original error wins).
    if (created) {
      await live.query(`drop database if exists "${scratch}" with (force)`).catch((err: unknown) => {
        dropError = err instanceof Error ? err : new Error(String(err));
      });
    }
    await live.end();
  }
  if (dropError !== undefined) {
    throw new BackupError(`the drill passed but its scratch database ${scratch} could not be dropped: ${dropError.message}`);
  }
  return result;
}

async function restoreAndVerify(options: DrillOptions, live: Client, file: string, newest: string, scratch: string): Promise<DrillResult> {
  const target = libpqTarget(options.config.DATABASE_URL, scratch);
  const restored = await options.run(
    toolPath(options, 'pg_restore'),
    ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${target.url}`, file],
    target.env,
  );
  if (restored.code !== 0) throw new BackupError(`pg_restore of ${newest} exited ${String(restored.code)}: ${restored.stderr.trim()}`);

  const copy = new Client({ connectionString: withDatabase(options.config.DATABASE_URL, scratch) });
  await copy.connect();
  try {
    const restoredTables = await tableNames(copy);
    if (!restoredTables.has('_prisma_migrations')) throw new BackupError(`${newest} restored without _prisma_migrations: not a Shipyard database`);
    const migration = (await copy.query<{ migration_name: string }>(NEWEST_MIGRATION)).rows[0]?.migration_name;
    if (migration === undefined) throw new BackupError(`${newest} restored with no applied migration`);

    const liveApplied = new Set((await live.query<{ migration_name: string }>(APPLIED_MIGRATIONS)).rows.map((r) => r.migration_name));
    if (!liveApplied.has(migration)) {
      throw new BackupError(`${newest} is at migration ${migration}, which the live database has never applied: not a dump of this database`);
    }
    const liveNewest = (await live.query<{ migration_name: string }>(NEWEST_MIGRATION)).rows[0]?.migration_name;
    if (migration === liveNewest) {
      const missing = [...(await tableNames(live))].filter((t) => !restoredTables.has(t));
      if (missing.length > 0) throw new BackupError(`${newest} restored without tables the live database has: ${missing.join(', ')}`);
    }

    const absent = KEY_TABLES.filter((t) => !restoredTables.has(t));
    if (absent.length > 0) throw new BackupError(`${newest} restored without key tables: ${absent.join(', ')}`);
    const restoredCounts = await counts(copy);
    const liveCounts = await counts(live);
    for (const table of MUST_SURVIVE) {
      if ((liveCounts[table] ?? 0) > 0 && restoredCounts[table] === 0) {
        throw new BackupError(
          `${newest} restored no rows of "${table}" while the live database has ${String(liveCounts[table])}; if the dump predates them, take a backup and drill again`,
        );
      }
    }
    return { file, tables: restoredTables.size, migration, counts: restoredCounts, scratch };
  } finally {
    await copy.end();
  }
}
