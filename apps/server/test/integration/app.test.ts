import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const logger = pino({ enabled: false });
const config = loadConfig({ DATABASE_URL: databaseUrl, SHIPYARD_VERSION: 'test-version' });

function initMigrationName(): string {
  const migrationsDir = join(import.meta.dirname, '../../prisma/migrations');
  const entries = readdirSync(migrationsDir, { withFileTypes: true });
  const dir = entries.find((e) => e.isDirectory() && e.name.includes('init'));
  if (dir === undefined) throw new Error('no init migration directory found');
  return dir.name;
}

beforeEach(async () => {
  await db.$executeRawUnsafe('truncate table "audit_event" cascade');
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/health', () => {
  it('returns ok with the applied schema revision', async () => {
    const app = createApp({ db, logger, config });
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      schemaRevision: initMigrationName(),
      version: 'test-version',
    });
  });
});

describe('unknown routes', () => {
  it('returns a 404 refusal envelope', async () => {
    const app = createApp({ db, logger, config });
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    const body = res.body as { error: { code: string; gate: string; message: string; fix: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.gate).toBe('none');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(body.error.fix.length).toBeGreaterThan(0);
  });
});
