import pino from 'pino';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { CompletedSignIn, OidcClient } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * `GET /api/auth/methods` tells the console's sign-in screen which ways in exist (SHP-REQ-001), so
 * the D3 Auth button is shown only when the OIDC client was built at boot.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  PUBLIC_URL: 'http://127.0.0.1',
  SESSION_SECRET: 'test-session-secret',
});

const stubOidc: OidcClient = {
  issuer: 'https://auth.example.test',
  beginSignIn: () => Promise.resolve({ url: 'https://auth.example.test/authorize', tx: 'tx' }),
  completeSignIn: (): Promise<CompletedSignIn> => Promise.reject(new Error('not used')),
};

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/auth/methods', () => {
  it('reports D3 Auth available when an OIDC client was given to createApp', async () => {
    const app = createApp({ db, logger: pino({ enabled: false }), config, oidc: stubOidc });
    const res = await request(app).get('/api/auth/methods');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ password: true, d3auth: true });
  });

  it('reports password only when the OIDC client is null', async () => {
    const app = createApp({ db, logger: pino({ enabled: false }), config, oidc: null });
    const res = await request(app).get('/api/auth/methods');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ password: true, d3auth: false });
  });

  it('reports password only when no OIDC client is passed at all', async () => {
    const app = createApp({ db, logger: pino({ enabled: false }), config });
    const res = await request(app).get('/api/auth/methods');
    expect(res.body).toEqual({ password: true, d3auth: false });
  });

  it('needs no session', async () => {
    const app = createApp({ db, logger: pino({ enabled: false }), config, oidc: null });
    const res = await request(app).get('/api/auth/methods');
    expect(res.status).toBe(200);
  });
});
