import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import pino from 'pino';
import { Client } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/host-admin.js';
import type { Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { runBackupJob, runDrillJob, type JobDeps } from '../../src/jobs/backup.js';
import { getSchemaRevision } from '../../src/schema-revision.js';

/**
 * The real thing: PostgreSQL 16 `pg_dump` and `pg_restore` against the test database (SHP-REQ-092).
 * PG_BIN_DIR names the client tools; otherwise the usual Homebrew and Debian/Ubuntu 16 locations.
 */
const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) throw new Error('DATABASE_URL must be set for integration tests');
const binDir = [process.env['PG_BIN_DIR'], '/opt/homebrew/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin'].find(
  (candidate): candidate is string => candidate !== undefined && existsSync(join(candidate, 'pg_dump')),
);

const db: Db = createDb(databaseUrl);
let dir: string;

async function scratchDatabases(): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>("select datname from pg_database where datname like 'shipyard_drill_%'");
    return rows.map((r) => r.datname);
  } finally {
    await client.end();
  }
}

function deps(): JobDeps {
  const config = { DATABASE_URL: databaseUrl, BACKUP_DIR: dir, BACKUP_RETENTION_DAYS: 14 } as Config;
  return { db, logger: pino({ level: 'silent' }), config };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shp-backup-it-'));
  await db.$executeRawUnsafe('truncate table "audit_event", "app", "agent", "session", "user" cascade');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterAll(async () => {
  await db.$disconnect();
});

async function seed(): Promise<void> {
  const agent = await db.agent.create({ data: { publicKey: 'k', fingerprint: 'SHA256:backup' } });
  await db.user.create({ data: { email: 'op@example.com', displayName: 'Op', role: 'admin' } });
  await db.app.create({ data: { name: 'web', agentId: agent.id, manifestYaml: '{}', manifestSha256: '0'.repeat(64), reportedAt: new Date() } });
}

describe.skipIf(binDir === undefined)('nightly backup and restore drill (real pg_dump/pg_restore 16)', () => {
  it('dumps, restores into a scratch database, verifies it, drops it, and audits both', async () => {
    await seed();
    const backup = await runBackupJob(deps(), undefined, { binDir });
    expect(backup).toMatchObject({ ok: true });
    expect(backup.bytes).toBeGreaterThan(1024);
    expect(await readdir(dir)).toEqual([backup.file?.slice(dir.length + 1)]);

    const drill = await runDrillJob(deps(), undefined, { binDir });
    expect(drill).toMatchObject({ ok: true, file: backup.file, migration: await getSchemaRevision(db) });
    expect(drill.tables).toBeGreaterThan(10);
    expect(await scratchDatabases()).toEqual([]);

    const events = await db.auditEvent.findMany({ where: { entityType: 'system' }, orderBy: { at: 'asc' } });
    expect(events.map((e) => [e.action, e.entityId, e.actorType, (e.after as { ok: boolean }).ok])).toEqual([
      ['system.backup', 'backup', 'system', true],
      ['system.drill', 'drill', 'system', true],
    ]);
  });

  it('fails a drill whose restore is missing rows the live database has, and still drops the scratch database', async () => {
    const backup = await runBackupJob(deps(), undefined, { binDir });
    expect(backup.ok).toBe(true);
    await seed(); // users and apps written after the dump
    const drill = await runDrillJob(deps(), undefined, { binDir });
    expect(drill).toMatchObject({ ok: false, error: expect.stringMatching(/restored no rows of "user"/) as string });
    expect(await scratchDatabases()).toEqual([]);
  });

  it('fails a drill on a corrupt newest dump, and still drops the scratch database', async () => {
    await seed();
    expect((await runBackupJob(deps(), undefined, { binDir })).ok).toBe(true);
    await writeFile(join(dir, 'shipyard-9999-01-01T00-00-00-000Z.dump'), 'not a dump');
    const drill = await runDrillJob(deps(), undefined, { binDir });
    expect(drill).toMatchObject({ ok: false, error: expect.stringMatching(/pg_restore of shipyard-9999.* exited/) as string });
    expect(await scratchDatabases()).toEqual([]);
  });

  it('runs both on demand through host-admin (pg tools on PATH), exit 0', async () => {
    await seed();
    const saved = { PATH: process.env['PATH'], BACKUP_DIR: process.env['BACKUP_DIR'] };
    process.env['PATH'] = `${binDir ?? ''}${delimiter}${saved.PATH ?? ''}`;
    process.env['BACKUP_DIR'] = dir;
    try {
      expect(await main(['backup'])).toBe(0);
      expect(await main(['drill'])).toBe(0);
    } finally {
      process.env['PATH'] = saved.PATH;
      if (saved.BACKUP_DIR === undefined) delete process.env['BACKUP_DIR'];
      else process.env['BACKUP_DIR'] = saved.BACKUP_DIR;
    }
    const events = await db.auditEvent.findMany({ where: { entityType: 'system', actorLabel: 'host-admin' } });
    expect(events.map((e) => e.action).sort()).toEqual(['system.backup', 'system.drill']);
  });
});
