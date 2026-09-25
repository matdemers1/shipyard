import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, signingString, type AgentReport } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { generateToken } from '../../src/tokens/index.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const SHA = '3'.repeat(40);

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

function manifest(name: string): AgentReport['apps'][number]['manifest'] {
  return {
    name,
    repo: `matdemers1/${name}`,
    defaultBranch: 'main',
    workflow: 'ci.yml',
    compose: { files: [`/data/${name}/compose.yml`], project: name },
    services: { web: { image: `ghcr.io/matdemers1/${name}` } },
    health: { service: 'web', port: 8080, path: '/health' },
    soakSeconds: 30,
    approval: 'required',
    diskFloorGb: 5,
    retainImages: 3,
    group: 'core',
  };
}

let app: Express;
let key: Key;

/** Every app row here comes from a signed agent report, as in production. */
async function reportApps(apps: AgentReport['apps']): Promise<void> {
  const path = '/api/agent/report';
  const body: AgentReport = { agentVersion: '0.1.0', composeVersion: '5.0.1', engineApiVersion: '1.51', patExpiresAt: null, apps };
  const text = JSON.stringify(body);
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const data = signingString({ method: 'POST', path, timestamp, nonce, body: Buffer.from(text, 'utf8') });
  const res = await request(app)
    .post(path)
    .set({
      'x-shipyard-key': key.fingerprint,
      'x-shipyard-timestamp': timestamp,
      'x-shipyard-nonce': nonce,
      'x-shipyard-signature': sign(null, Buffer.from(data, 'utf8'), key.privateKey).toString('base64'),
      'content-type': 'application/json',
    })
    .send(text);
  expect(res.status).toBe(200);
}

async function signIn(): Promise<{ userId: string; cookie: string }> {
  const user = await db.user.create({ data: { email: `u-${randomUUID()}@example.com`, displayName: 'u', role: 'deployer' } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, cookie: `${SESSION_COOKIE}=${session.token}` };
}

async function tokenFor(userId: string, apps: string[]): Promise<string> {
  const { token, hash, prefix } = generateToken();
  const rows = await db.app.findMany({ where: { name: { in: apps } }, select: { id: true } });
  await db.apiToken.create({
    data: { userId, label: 'ci', tokenHash: hash, prefix, apps: { create: rows.map((r) => ({ appId: r.id })) } },
  });
  return token;
}

interface Summary {
  name: string;
  liveSha: string | null;
  digests: Record<string, string> | null;
  drift: { observed: unknown } | null;
  active: { state: string; holder: string; currentStep: string | null } | null;
  soakSeconds: number;
  approvalPolicy: string;
  group: string | null;
  reportedAt: string | null;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "drift_event", "target_image", "step", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "session", "user", "app", "agent" cascade',
  );
  key = makeKey();
  await db.agent.create({ data: { publicKey: key.b64, fingerprint: key.fingerprint, confirmedAt: new Date() } });
  app = createApp({ db, logger: pino({ enabled: false }), config });
  await reportApps([
    { manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_A } },
    { manifest: manifest('api'), manifestSha256: 'b'.repeat(64), running: { web: DIGEST_A } },
    { manifest: manifest('billing'), manifestSha256: 'c'.repeat(64), running: { web: null } },
  ]);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/apps', () => {
  it('refuses an anonymous request', async () => {
    const res = await request(app).get('/api/apps');
    expect(res.status).toBe(401);
  });

  it('lists every app for a signed-in user, with the recorded release, drift and active target', async () => {
    const { cookie } = await signIn();
    const web = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
    const done = await db.deploy.create({ data: { requestedSha: SHA, requesterLabel: 'user matthew' } });
    await db.deployTarget.create({
      data: {
        deployId: done.id,
        appId: web.id,
        state: 'succeeded',
        endedAt: new Date(),
        images: { create: [{ service: 'web', repo: 'ghcr.io/matdemers1/web', sha: SHA, digest: DIGEST_A }] },
      },
    });
    // An SSH change: the next report flags it.
    await reportApps([{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_B } }]);
    const api = await db.app.findUniqueOrThrow({ where: { name: 'api' } });
    const running = await db.deploy.create({ data: { requestedSha: SHA, requesterLabel: 'token claude' } });
    await db.deployTarget.create({ data: { deployId: running.id, appId: api.id, state: 'pulling', currentStep: 'pull web' } });

    const res = await request(app).get('/api/apps').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const apps = (res.body as { apps: Summary[] }).apps;
    expect(apps.map((a) => a.name)).toEqual(['api', 'billing', 'web']);

    const w = apps.find((a) => a.name === 'web');
    expect(w).toMatchObject({
      liveSha: SHA,
      digests: { web: DIGEST_A },
      drift: { observed: { web: DIGEST_B } },
      active: null,
      soakSeconds: 30,
      approvalPolicy: 'required',
      group: 'core',
    });
    expect(w?.reportedAt).not.toBeNull();
    expect(apps.find((a) => a.name === 'api')).toMatchObject({
      liveSha: null,
      digests: null,
      drift: null,
      active: { state: 'pulling', holder: 'token claude', currentStep: 'pull web' },
    });
  });

  it('shows a token only the apps it is scoped to', async () => {
    const { userId } = await signIn();
    const token = await tokenFor(userId, ['web', 'billing']);
    const res = await request(app).get('/api/apps').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect((res.body as { apps: Summary[] }).apps.map((a) => a.name)).toEqual(['billing', 'web']);

    const inScope = await request(app).get('/api/apps/web').set('Authorization', `Bearer ${token}`);
    expect(inScope.status).toBe(200);
    const outOfScope = await request(app).get('/api/apps/api').set('Authorization', `Bearer ${token}`);
    expect(outOfScope.status).toBe(404);
  });
});

describe('GET /api/apps/:app', () => {
  it('returns the summary, the read-only manifest and the last 20 targets', async () => {
    const { cookie } = await signIn();
    const web = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
    for (let i = 0; i < 22; i++) {
      const d = await db.deploy.create({ data: { requestedSha: SHA, requesterLabel: `user ${i}` } });
      await db.deployTarget.create({ data: { deployId: d.id, appId: web.id, state: 'failed', endedAt: new Date() } });
    }
    const res = await request(app).get('/api/apps/web').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as Summary & { manifest: { name: string; workflow: string }; targets: { state: string; kind: string }[] };
    expect(body.name).toBe('web');
    expect(body.manifest).toMatchObject({ name: 'web', workflow: 'ci.yml' });
    expect(body.targets).toHaveLength(20);
    expect(body.targets[0]).toMatchObject({ state: 'failed', kind: 'deploy' });
  });

  it('answers 404 for an app the agent has not reported', async () => {
    const { cookie } = await signIn();
    const res = await request(app).get('/api/apps/ghost').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  it('writes nothing: the routes are read-only', async () => {
    const { cookie } = await signIn();
    const res = await request(app).post('/api/apps/web').set('Cookie', cookie).send({ repo: 'evil/repo' });
    expect(res.status).toBe(404);
    expect((await db.app.findUniqueOrThrow({ where: { name: 'web' } })).repo).toBe('matdemers1/web');
  });
});
