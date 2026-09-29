import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, signingString, type BuildSettings, type PollResponse, type Refusal, type SystemStatus } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { Bus } from '../../src/events.js';
import { BUILD_SETTING_KEY } from '../../src/settings/build.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * Settings → Builds and the System screen's build cache (SHP-REQ-131, SHP-REQ-132, SHP-REQ-133,
 * SHP-T-7.11): an admin saves CPU/memory/cache-cap limits; the very next agent poll carries them;
 * an agent's report of its BuildKit cache shows up on GET /api/system.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret', SHIPYARD_VERSION: 'sha-test123' });
const logger = pino({ enabled: false });

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

let bus: Bus;
let app: Express;

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

async function signIn(role: Role): Promise<{ id: string; cookie: string }> {
  const email = `${role}-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { id: user.id, cookie: `${SESSION_COOKIE}=${session.token}` };
}

async function tokenFor(role: Role): Promise<string> {
  const user = await db.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role } });
  const { token, hash, prefix } = generateToken();
  await db.apiToken.create({ data: { userId: user.id, label: 'test token', tokenHash: hash, prefix } });
  return token;
}

interface Key {
  privateKey: KeyObject;
  b64: string;
  fingerprint: string;
}

function makeKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  return { privateKey, b64: raw.toString('base64'), fingerprint: fingerprintOf(raw) };
}

function signed(key: Key, method: string, path: string, body: string): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const data = signingString({ method, path, timestamp, nonce, body: Buffer.from(body, 'utf8') });
  return {
    'x-shipyard-key': key.fingerprint,
    'x-shipyard-timestamp': timestamp,
    'x-shipyard-nonce': nonce,
    'x-shipyard-signature': sign(null, Buffer.from(data, 'utf8'), key.privateKey).toString('base64'),
    'content-type': 'application/json',
  };
}

async function enrolAgent(key: Key): Promise<string> {
  const row = await db.agent.create({ data: { publicKey: key.b64, fingerprint: key.fingerprint, confirmedAt: new Date() } });
  return row.id;
}

async function post(path: string, body: unknown, key: Key) {
  const text = JSON.stringify(body);
  return request(app).post(path).set(signed(key, 'POST', path, text)).send(text);
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "outbox", "target_image", "step", "drift_event", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user", "setting" cascade',
  );
  bus = new Bus();
  const deps: ServiceDeps = { db, logger, config, bus };
  app = createApp(deps);
});

afterAll(async () => {
  await db.$disconnect();
});

const get = (cookie: string) => request(app).get('/api/settings/builds').set('Cookie', cookie);
const put = (cookie: string, body: unknown) => request(app).put('/api/settings/builds').set('Cookie', cookie).send(body as object);

describe('GET /api/settings/builds', () => {
  it('defaults before anything is saved', async () => {
    const { cookie } = await signIn('admin');
    const res = await get(cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cpus: 2, memoryMb: 4096, cacheCapGb: 20 } satisfies BuildSettings);
  });

  it('is admin-only: other roles 403, nobody 401, a token 403', async () => {
    for (const role of ['deployer', 'operator', 'viewer'] as const) {
      const { cookie } = await signIn(role);
      expect((await get(cookie)).status).toBe(403);
      expect((await put(cookie, { cpus: 4, memoryMb: 8192, cacheCapGb: 40 })).status).toBe(403);
    }
    expect((await request(app).get('/api/settings/builds')).status).toBe(401);
    const bearer = await tokenFor('admin');
    expect((await request(app).get('/api/settings/builds').set('Authorization', `Bearer ${bearer}`)).status).toBe(403);
  });
});

describe('PUT /api/settings/builds', () => {
  it('saves the limits, audits them, and GET reflects them', async () => {
    const admin = await signIn('admin');
    const res = await put(admin.cookie, { cpus: 4, memoryMb: 8192, cacheCapGb: 50 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cpus: 4, memoryMb: 8192, cacheCapGb: 50 } satisfies BuildSettings);

    expect((await get(admin.cookie)).body).toEqual({ cpus: 4, memoryMb: 8192, cacheCapGb: 50 });

    const row = await db.setting.findUniqueOrThrow({ where: { key: BUILD_SETTING_KEY } });
    expect(row.value).toEqual({ cpus: 4, memoryMb: 8192, cacheCapGb: 50 });
    expect(row.updatedById).toBe(admin.id);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'settings.builds.updated' } });
    expect(audit.after).toEqual({ cpus: 4, memoryMb: 8192, cacheCapGb: 50 });
    expect(audit.before).toEqual({ cpus: 2, memoryMb: 4096, cacheCapGb: 20 });
  });

  it('refuses a CPU value that is not a half-CPU step', async () => {
    const admin = await signIn('admin');
    const res = await put(admin.cookie, { cpus: 1.3, memoryMb: 4096, cacheCapGb: 20 });
    expect(res.status).toBe(400);
    expect(err(res).code).toBe('invalid_request');
    expect(await db.setting.count()).toBe(0);
  });

  it('refuses memory below the floor', async () => {
    const admin = await signIn('admin');
    const res = await put(admin.cookie, { cpus: 2, memoryMb: 100, cacheCapGb: 20 });
    expect(res.status).toBe(400);
    expect(err(res).code).toBe('invalid_request');
  });

  it('refuses a cache cap above the ceiling', async () => {
    const admin = await signIn('admin');
    const res = await put(admin.cookie, { cpus: 2, memoryMb: 4096, cacheCapGb: 5000 });
    expect(res.status).toBe(400);
    expect(err(res).code).toBe('invalid_request');
  });
});

describe('the agent poll carries buildSettings', () => {
  it('defaults on the very next poll before anything is saved', async () => {
    const key = makeKey();
    await enrolAgent(key);
    const res = await post('/api/agent/poll', { waitSeconds: 0 }, key);
    expect(res.status).toBe(200);
    const body = res.body as PollResponse;
    expect(body.buildSettings).toEqual({ cpus: 2, memoryMb: 4096, cacheCapGb: 20 });
  });

  it('reaches the agent on the very next poll after a save', async () => {
    const admin = await signIn('admin');
    await put(admin.cookie, { cpus: 8, memoryMb: 16384, cacheCapGb: 100 });

    const key = makeKey();
    await enrolAgent(key);
    const res = await post('/api/agent/poll', { waitSeconds: 0 }, key);
    expect(res.status).toBe(200);
    const body = res.body as PollResponse;
    expect(body.buildSettings).toEqual({ cpus: 8, memoryMb: 16384, cacheCapGb: 100 });
  });
});

describe('the agent report carries buildCache, and GET /api/system shows it', () => {
  it('is null before any agent has reported one', async () => {
    const key = makeKey();
    await enrolAgent(key);
    const { cookie } = await signIn('deployer');
    const res = await request(app).get('/api/system').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect((res.body as SystemStatus).buildCache).toBeNull();
  });

  it("appears on GET /api/system after the agent's report", async () => {
    const key = makeKey();
    await enrolAgent(key);

    const reportBody = {
      agentVersion: '1.0.0',
      composeVersion: 'v5.2.1',
      engineApiVersion: '1.47',
      patExpiresAt: null,
      apps: [],
      buildCache: {
        bytes: 1_073_741_824,
        capBytes: 21_474_836_480,
        lastGcAt: '2026-09-27T03:00:00.000Z',
        limitsApplied: { cpus: 4, memoryMb: 8192 },
      },
    };
    const reportRes = await post('/api/agent/report', reportBody, key);
    expect(reportRes.status).toBe(200);

    const { cookie } = await signIn('deployer');
    const res = await request(app).get('/api/system').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect((res.body as SystemStatus).buildCache).toEqual(reportBody.buildCache);
  });
});
