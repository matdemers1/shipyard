import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { Router, type Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, signingString } from '@shipyard/schema';
import { ENROL_LIMIT, type AgentSummary } from '../../src/agent/enrol.js';
import { verifyAgentRequest } from '../../src/agent/verify.js';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { generateToken } from '../../src/tokens/index.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

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

function signed(key: Key, method: string, path: string, body = ''): Record<string, string> {
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

const ENROL = '/api/agent/enrol';
const POLL = '/api/_test/poll';
const POLL_BODY = JSON.stringify({ waitSeconds: 25 });

function buildApp(): Express {
  const logger = pino({ enabled: false });
  const deps = { db, logger, config, bus: new Bus() };
  const testRouter = Router();
  // The same guard the real poll uses: plain verifyAgentRequest, no allowances.
  testRouter.post('/poll', verifyAgentRequest(deps), (req, res) => {
    res.json({ ok: true, agentId: req.agent?.id });
  });
  return createApp({ db, logger, config, testRouter });
}

function enrol(app: Express, key: Key, agentVersion = '0.1.0') {
  const body = JSON.stringify({ publicKey: key.b64, agentVersion });
  return request(app).post(ENROL).set(signed(key, 'POST', ENROL, body)).send(body);
}

function poll(app: Express, key: Key) {
  return request(app).post(POLL).set(signed(key, 'POST', POLL, POLL_BODY)).send(POLL_BODY);
}

async function signIn(role: Role): Promise<{ userId: string; cookie: string }> {
  const user = await db.user.create({
    data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role },
  });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, cookie: `${SESSION_COOKIE}=${session.token}` };
}

function err(res: { body: unknown }): { code: string; message: string } {
  return (res.body as { error: { code: string; message: string } }).error;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "audit_event", "agent_nonce", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
});

afterAll(async () => {
  await db.$disconnect();
});

describe('agent enrolment by fingerprint confirmation (SHP-REQ-035)', () => {
  it('refuses polls with not_enrolled until a deployer confirms the typed fingerprint', async () => {
    const app = buildApp();
    const key = makeKey();

    // 1. A fresh key enrols: an unconfirmed row, audited.
    const res = await enrol(app, key);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fingerprint: key.fingerprint, confirmed: false });
    const row = await db.agent.findUniqueOrThrow({ where: { fingerprint: key.fingerprint } });
    expect(row.confirmedAt).toBeNull();
    expect(row.publicKey).toBe(key.b64);
    expect(row.agentVersion).toBe('0.1.0');
    const requested = await db.auditEvent.findFirstOrThrow({ where: { action: 'agent.enrol_requested' } });
    expect(requested).toMatchObject({ actorType: 'agent', actorAgentId: row.id, entityId: row.id });

    // 2. A poll-like signed request is refused.
    const refused = await poll(app, key);
    expect(refused.status).toBe(403);
    expect(err(refused).code).toBe('not_enrolled');

    // 3. A mismatched fingerprint is a conflict, and confirms nothing.
    const deployer = await signIn('deployer');
    const wrong = await request(app)
      .post(`/api/agent/${row.id}/confirm`)
      .set('Cookie', deployer.cookie)
      .send({ fingerprint: makeKey().fingerprint });
    expect(wrong.status).toBe(409);
    expect(err(wrong).code).toBe('conflict');
    expect(err(wrong).message).toMatch(/fingerprint does not match/);
    expect((await poll(app, key)).status).toBe(403);

    // 4. The right fingerprint confirms it.
    const ok = await request(app)
      .post(`/api/agent/${row.id}/confirm`)
      .set('Cookie', deployer.cookie)
      .send({ fingerprint: key.fingerprint });
    expect(ok.status).toBe(200);
    expect((ok.body as AgentSummary).confirmed).toBe(true);
    expect((ok.body as AgentSummary).confirmedBy?.id).toBe(deployer.userId);
    const confirmed = await db.agent.findUniqueOrThrow({ where: { id: row.id } });
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(confirmed.confirmedByUserId).toBe(deployer.userId);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'agent.confirmed' } });
    expect(audit).toMatchObject({ actorType: 'user', actorUserId: deployer.userId, entityId: row.id });

    // 5. The same kind of signed poll now passes.
    const passed = await poll(app, key);
    expect(passed.status).toBe(200);
    expect(passed.body).toEqual({ ok: true, agentId: row.id });

    // Idempotent: confirming again keeps the first confirmation.
    const again = await request(app)
      .post(`/api/agent/${row.id}/confirm`)
      .set('Cookie', deployer.cookie)
      .send({ fingerprint: key.fingerprint });
    expect(again.status).toBe(200);
    expect((again.body as AgentSummary).confirmedAt).toBe(confirmed.confirmedAt?.toISOString());

    // Enrolling again reports confirmed, and records a new agent version.
    const re = await enrol(app, key, '0.2.0');
    expect(re.status).toBe(200);
    expect(re.body).toEqual({ fingerprint: key.fingerprint, confirmed: true });
    expect((await db.agent.findUniqueOrThrow({ where: { id: row.id } })).agentVersion).toBe('0.2.0');
    expect(await db.agent.count()).toBe(1);
  });

  it('lets an operator or admin confirm, but not a viewer', async () => {
    const app = buildApp();
    for (const role of ['operator', 'admin'] as const) {
      const key = makeKey();
      await enrol(app, key);
      const row = await db.agent.findUniqueOrThrow({ where: { fingerprint: key.fingerprint } });
      const user = await signIn(role);
      const res = await request(app).post(`/api/agent/${row.id}/confirm`).set('Cookie', user.cookie).send({ fingerprint: key.fingerprint });
      expect(res.status, role).toBe(200);
    }

    const key = makeKey();
    await enrol(app, key);
    const row = await db.agent.findUniqueOrThrow({ where: { fingerprint: key.fingerprint } });
    const viewer = await signIn('viewer');
    const res = await request(app).post(`/api/agent/${row.id}/confirm`).set('Cookie', viewer.cookie).send({ fingerprint: key.fingerprint });
    expect(res.status).toBe(403);
    expect(err(res).code).toBe('forbidden');
    expect((await db.agent.findUniqueOrThrow({ where: { id: row.id } })).confirmedAt).toBeNull();
    expect((await poll(app, key)).status).toBe(403);
  });

  it('refuses an API token, even an admin\'s, because confirmation is console-only', async () => {
    const app = buildApp();
    const key = makeKey();
    await enrol(app, key);
    const row = await db.agent.findUniqueOrThrow({ where: { fingerprint: key.fingerprint } });
    const admin = await signIn('admin');
    const { token, hash, prefix } = generateToken();
    await db.apiToken.create({ data: { userId: admin.userId, label: 'ci', tokenHash: hash, prefix } });

    for (const path of [`/api/agent/${row.id}/confirm`, `/api/agent/${row.id}/revoke`]) {
      const res = await request(app).post(path).set('Authorization', `Bearer ${token}`).send({ fingerprint: key.fingerprint });
      expect(res.status, path).toBe(403);
      expect(err(res).code).toBe('forbidden');
    }
    expect((await db.agent.findUniqueOrThrow({ where: { id: row.id } })).confirmedAt).toBeNull();
  });

  it('refuses an unknown agent id and a missing fingerprint', async () => {
    const app = buildApp();
    const deployer = await signIn('deployer');
    const missing = await request(app).post(`/api/agent/${randomUUID()}/confirm`).set('Cookie', deployer.cookie).send({ fingerprint: 'SHA256:x' });
    expect(missing.status).toBe(404);
    const junk = await request(app).post('/api/agent/not-a-uuid/confirm').set('Cookie', deployer.cookie).send({ fingerprint: 'SHA256:x' });
    expect(junk.status).toBe(404);

    const key = makeKey();
    await enrol(app, key);
    const row = await db.agent.findUniqueOrThrow({ where: { fingerprint: key.fingerprint } });
    const empty = await request(app).post(`/api/agent/${row.id}/confirm`).set('Cookie', deployer.cookie).send({});
    expect(empty.status).toBe(400);
  });

  it('puts a revoked agent back to not_enrolled; only an admin may revoke', async () => {
    const app = buildApp();
    const key = makeKey();
    await enrol(app, key);
    const row = await db.agent.findUniqueOrThrow({ where: { fingerprint: key.fingerprint } });
    const deployer = await signIn('deployer');
    await request(app).post(`/api/agent/${row.id}/confirm`).set('Cookie', deployer.cookie).send({ fingerprint: key.fingerprint });
    expect((await poll(app, key)).status).toBe(200);

    const byDeployer = await request(app).post(`/api/agent/${row.id}/revoke`).set('Cookie', deployer.cookie).send({});
    expect(byDeployer.status).toBe(403);
    expect((await poll(app, key)).status).toBe(200);

    const admin = await signIn('admin');
    const revoked = await request(app).post(`/api/agent/${row.id}/revoke`).set('Cookie', admin.cookie).send({});
    expect(revoked.status).toBe(200);
    expect((revoked.body as AgentSummary).confirmed).toBe(false);
    const after = await poll(app, key);
    expect(after.status).toBe(403);
    expect(err(after).code).toBe('not_enrolled');
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'agent.revoked' } });
    expect(audit).toMatchObject({ actorUserId: admin.userId, entityId: row.id });

    // Re-enrolling the same key does not confirm it again.
    expect((await enrol(app, key)).body).toEqual({ fingerprint: key.fingerprint, confirmed: false });
  });

  it('rate-limits enrolment per source IP', async () => {
    const app = buildApp();
    for (let i = 0; i < ENROL_LIMIT; i++) {
      const res = await enrol(app, makeKey());
      expect(res.status, `attempt ${i + 1}`).toBe(200);
    }
    const tripped = await enrol(app, makeKey());
    expect(tripped.status).toBe(429);
    expect(err(tripped).code).toBe('too_many_attempts');
    expect(await db.agent.count()).toBe(ENROL_LIMIT);

    // The limit is checked before any signature work: unsigned junk is throttled too.
    const junk = await request(app).post(ENROL).send({});
    expect(junk.status).toBe(429);
    // A fresh server process starts a fresh window.
    expect((await request(buildApp()).post(ENROL).send({})).status).toBe(401);
  });

  it('lists agents with confirmation, versions and heartbeat staleness, to any signed-in user', async () => {
    const app = buildApp();
    const deployer = await signIn('deployer');
    const fresh = await db.agent.create({
      data: {
        publicKey: makeKey().b64,
        fingerprint: 'SHA256:fresh',
        confirmedAt: new Date(),
        confirmedByUserId: deployer.userId,
        lastHeartbeatAt: new Date(Date.now() - 30_000),
        agentVersion: '0.1.0',
        composeVersion: '2.29.0',
        engineApiVersion: '1.47',
      },
    });
    const old = await db.agent.create({
      data: { publicKey: makeKey().b64, fingerprint: 'SHA256:old', lastHeartbeatAt: new Date(Date.now() - 6 * 60_000) },
    });
    const never = await db.agent.create({ data: { publicKey: makeKey().b64, fingerprint: 'SHA256:never' } });

    const viewer = await signIn('viewer');
    const res = await request(app).get('/api/agent').set('Cookie', viewer.cookie);
    expect(res.status).toBe(200);
    const list = res.body as AgentSummary[];
    const byId = new Map(list.map((a) => [a.id, a]));
    expect(byId.get(fresh.id)).toMatchObject({
      fingerprint: 'SHA256:fresh',
      confirmed: true,
      confirmedBy: { id: deployer.userId },
      agentVersion: '0.1.0',
      composeVersion: '2.29.0',
      engineApiVersion: '1.47',
      stale: false,
    });
    expect(byId.get(old.id)).toMatchObject({ confirmed: false, confirmedAt: null, stale: true });
    expect(byId.get(never.id)).toMatchObject({ lastHeartbeatAt: null, stale: true });
    // Never the public key.
    expect(JSON.stringify(list)).not.toContain(fresh.publicKey);

    const anon = await request(app).get('/api/agent');
    expect(anon.status).toBe(401);
  });
});
