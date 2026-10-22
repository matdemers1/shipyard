import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db.js';

/**
 * The JSON body limits (SHP-T-14.5): the agent's report carries the host inventory (SHP-ADR-009)
 * and may be up to 2 MB; every other route keeps 256 kB. No database: an unsigned request is
 * refused by the signature check before anything is read, so a 401 shows the body was parsed and a
 * refusal before that shows it was not.
 */

const config = loadConfig({ DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused_test' });
const app = createApp({ db: {} as Db, logger: pino({ enabled: false }), config });

function bodyOf(bytes: number): string {
  return JSON.stringify({ padding: 'x'.repeat(bytes) });
}

describe('JSON body limits', () => {
  it('parses a ~600 kB body on POST /api/agent/report (reaching the signature check)', async () => {
    const res = await request(app).post('/api/agent/report').set('content-type', 'application/json').send(bodyOf(600 * 1024));
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('unauthenticated');
  });

  it('still refuses a body over 2 MB on POST /api/agent/report', async () => {
    const res = await request(app).post('/api/agent/report').set('content-type', 'application/json').send(bodyOf(2 * 1024 * 1024 + 1024));
    expect(res.status).not.toBe(401);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a 300 kB body on any other route before it reaches the route', async () => {
    const res = await request(app).post('/api/agent/poll').set('content-type', 'application/json').send(bodyOf(300 * 1024));
    expect(res.status).not.toBe(401);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const small = await request(app).post('/api/agent/poll').set('content-type', 'application/json').send(bodyOf(1024));
    expect(small.status).toBe(401);
  });
});
