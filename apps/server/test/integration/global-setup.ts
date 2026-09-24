import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

/**
 * Integration setup: create the test database if it is absent, then bring its schema up to date.
 *
 * Doing this here rather than in a README step means a dropped volume costs nothing, and CI's
 * Postgres service needs no bespoke provisioning.
 */
export default async function setup(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined) return;

  const parsed = new URL(url);
  const name = parsed.pathname.slice(1);
  if (!name.endsWith('_test')) {
    // A guard worth having: these tests truncate. They may only ever point at a test database.
    throw new Error(`refusing to run integration tests against "${name}": the name must end in _test`);
  }

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (rowCount === 0) await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }

  const require_ = createRequire(import.meta.url);
  const manifestPath = require_.resolve('prisma/package.json');
  const cli = join(dirname(manifestPath), 'build/index.js');
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], {
    cwd: join(import.meta.dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stderr}${result.stdout}`);
  }
}
