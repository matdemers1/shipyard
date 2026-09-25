import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import type { DeployAccepted, Refusal } from '@shipyard/schema';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { Bus } from '../../src/events.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * Freeze (SHP-T-5.1, SHP-REQ-077, SHP-D-049) — the doneWhen: a frozen app refuses deploy, accepts
 * rollback. Also covers set/clear, who may act, and a held approval decided after a freeze.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b1c2d3e4f5'.repeat(4);

let bus: Bus;
let app: Express;
let appIds: Map<string, string>;

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

async function signIn(role: Role): Promise<{ userId: string; email: string; cookie: string }> {
  const email = `${role}-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, email, cookie: `${SESSION_COOKIE}=${session.token}` };
}

/** A deployer's token scoped to `apps`; returns the plaintext token. */
async function tokenFor(label: string, apps: string[]): Promise<string> {
  const user = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.com`, displayName: label, role: 'deployer' } });
  const { token, hash, prefix } = generateToken();
  await db.apiToken.create({
    data: { userId: user.id, label, tokenHash: hash, prefix, apps: { create: apps.map((a) => ({ appId: appIds.get(a) ?? '' })) } },
  });
  return token;
}

async function seedApps(...names: string[]): Promise<Map<string, string>> {
  const agent = await db.agent.create({ data: { publicKey: 'test-key', fingerprint: `fp-${randomUUID()}` } });
  const ids = new Map<string, string>();
  for (const name of names) {
    const row = await db.app.create({
      data: { name, agentId: agent.id, manifestYaml: `name: ${name}\n`, manifestSha256: '0'.repeat(64), reportedAt: new Date() },
    });
    ids.set(name, row.id);
  }
  return ids;
}

const requester = (label: string) => ({ repo: 'matdemers1/web', branch: 'main', label });

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "freeze", "approval", "target_image", "step", "outbox", "drift_event", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  appIds = await seedApps('web', 'api');
  bus = new Bus();
  const deps: ServiceDeps = { db, logger, config, bus };
  app = createApp(deps);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('set (POST /api/apps/:app/freeze)', () => {
  it('a deployer freezes an app with a reason; a second freeze is refused conflict', async () => {
    const deployer = await signIn('deployer');
    const res = await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'Host maintenance' });
    expect(res.status).toBe(201);
    const body = res.body as { id: string; app: string; reason: string; by: string; from: string; until: string | null; clearedAt: string | null };
    expect(body).toMatchObject({ app: 'web', reason: 'Host maintenance', by: deployer.email, until: null, clearedAt: null });
    expect(typeof body.from).toBe('string');

    const audit = await db.auditEvent.findMany({ where: { action: 'app.frozen' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(deployer.userId);

    const again = await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'again' });
    expect(again.status).toBe(409);
    expect(err(again).code).toBe('conflict');
  });

  it('an admin may freeze with an until in the future; a past until is refused invalid_request', async () => {
    const admin = await signIn('admin');
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const res = await request(app).post('/api/apps/web/freeze').set('Cookie', admin.cookie).send({ reason: 'window', until });
    expect(res.status).toBe(201);
    expect((res.body as { until: string }).until).toBe(until);

    const past = new Date(Date.now() - 1000).toISOString();
    const refused = await request(app).post('/api/apps/api/freeze').set('Cookie', admin.cookie).send({ reason: 'x', until: past });
    expect(refused.status).toBe(400);
    expect(err(refused).code).toBe('invalid_request');
  });

  it('a viewer or a token cannot freeze; neither can an anonymous caller', async () => {
    const viewer = await signIn('viewer');
    const v = await request(app).post('/api/apps/web/freeze').set('Cookie', viewer.cookie).send({ reason: 'x' });
    expect(v.status).toBe(403);
    expect(err(v).code).toBe('forbidden');

    const token = await tokenFor('claude', ['web']);
    const t = await request(app).post('/api/apps/web/freeze').set('Authorization', `Bearer ${token}`).send({ reason: 'x' });
    expect(t.status).toBe(403);
    expect(err(t).code).toBe('forbidden');

    const anon = await request(app).post('/api/apps/web/freeze').send({ reason: 'x' });
    expect(anon.status).toBe(401);

    expect(await db.freeze.count()).toBe(0);
  });

  it('an unknown app is refused unknown_app; an empty or overlong reason is refused invalid_request', async () => {
    const deployer = await signIn('deployer');
    const missing = await request(app).post('/api/apps/nope/freeze').set('Cookie', deployer.cookie).send({ reason: 'x' });
    expect(missing.status).toBe(404);
    expect(err(missing).code).toBe('unknown_app');

    const empty = await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: '' });
    expect(empty.status).toBe(400);
    expect(err(empty).code).toBe('invalid_request');

    const overlong = await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'a'.repeat(501) });
    expect(overlong.status).toBe(400);
    expect(err(overlong).code).toBe('invalid_request');
  });
});

describe('clear (DELETE /api/apps/:app/freeze)', () => {
  it('clears the active freeze, and a second clear is refused not_found', async () => {
    const deployer = await signIn('deployer');
    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'Host maintenance' }).expect(201);

    const res = await request(app).delete('/api/apps/web/freeze').set('Cookie', deployer.cookie);
    expect(res.status).toBe(200);
    expect((res.body as { clearedAt: string | null }).clearedAt).not.toBeNull();

    const audit = await db.auditEvent.findMany({ where: { action: 'app.unfrozen' } });
    expect(audit).toHaveLength(1);

    const again = await request(app).delete('/api/apps/web/freeze').set('Cookie', deployer.cookie);
    expect(again.status).toBe(404);
    expect(err(again).code).toBe('not_found');
  });

  it('clearing an app that was never frozen is refused not_found; a viewer cannot clear', async () => {
    const deployer = await signIn('deployer');
    const res = await request(app).delete('/api/apps/web/freeze').set('Cookie', deployer.cookie);
    expect(res.status).toBe(404);
    expect(err(res).code).toBe('not_found');

    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'x' }).expect(201);
    const viewer = await signIn('viewer');
    const v = await request(app).delete('/api/apps/web/freeze').set('Cookie', viewer.cookie);
    expect(v.status).toBe(403);
  });
});

describe('GET /api/apps/:app/freeze', () => {
  it('reports the active freeze, and null once cleared or expired', async () => {
    const deployer = await signIn('deployer');
    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'Host maintenance' }).expect(201);

    const res = await request(app).get('/api/apps/web/freeze').set('Cookie', deployer.cookie);
    expect(res.status).toBe(200);
    const body = res.body as { freeze: { reason: string; by: string; from: string; until: string | null } | null };
    expect(body.freeze).toMatchObject({ reason: 'Host maintenance', by: deployer.email, until: null });

    await request(app).delete('/api/apps/web/freeze').set('Cookie', deployer.cookie).expect(200);
    const after = await request(app).get('/api/apps/web/freeze').set('Cookie', deployer.cookie);
    expect((after.body as { freeze: unknown }).freeze).toBeNull();
  });

  it('an until in the past is not active, even without clearing', async () => {
    const admin = await signIn('admin');
    const until = new Date(Date.now() + 2000).toISOString();
    await request(app).post('/api/apps/web/freeze').set('Cookie', admin.cookie).send({ reason: 'brief', until }).expect(201);
    await db.freeze.updateMany({ where: {}, data: { until: new Date(Date.now() - 1000) } });

    const res = await request(app).get('/api/apps/web/freeze').set('Cookie', admin.cookie);
    expect((res.body as { freeze: unknown }).freeze).toBeNull();
  });
});

describe('deploy refusal — the doneWhen: frozen refuses deploy, accepts rollback (SHP-REQ-077, SHP-D-049)', () => {
  it('a real deploy of a frozen app is refused app_frozen (G2) naming the reason', async () => {
    const deployer = await signIn('deployer');
    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'Host maintenance' }).expect(201);

    const res = await request(app).post('/api/deploys').set('Cookie', deployer.cookie).send({ kind: 'deploy', app: 'web', sha: SHA_A });
    expect(res.status).toBe(409);
    const refusal = err(res);
    expect(refusal.code).toBe('app_frozen');
    expect(refusal.gate).toBe('G2');
    expect(refusal.message).toContain('web is frozen: Host maintenance');
    expect(refusal.message).toContain(deployer.email);
    expect(refusal.fix).toContain('Unfreeze');

    expect(await db.deploy.count()).toBe(0);
  });

  it("a dry run of a frozen app is refused too — it reports what a real deploy would do", async () => {
    const deployer = await signIn('deployer');
    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'window' }).expect(201);

    const res = await request(app)
      .post('/api/deploys')
      .set('Cookie', deployer.cookie)
      .send({ kind: 'deploy', app: 'web', sha: SHA_A, dryRun: true });
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('app_frozen');
  });

  it('a rollback of a frozen app is accepted (locked), unaffected by the freeze', async () => {
    const deployer = await signIn('deployer');
    const earlier = await db.deploy.create({
      data: {
        requestedSha: SHA_B,
        requesterLabel: 'earlier',
        targets: { create: { appId: appIds.get('web') ?? '', state: 'succeeded', endedAt: new Date(), dispatchedAt: new Date() } },
      },
      select: { id: true },
    });
    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'window' }).expect(201);

    const res = await request(app)
      .post('/api/deploys')
      .set('Cookie', deployer.cookie)
      .send({ kind: 'rollback', app: 'web', toDeployId: earlier.id, requester: requester('rollback while frozen') });
    expect(res.status).toBe(201);
    expect((res.body as DeployAccepted).state).toBe('locked');
  });

  it('a token deploy of a frozen app is refused too, before it ever reaches held', async () => {
    const token = await tokenFor('claude', ['web']);
    const deployer = await signIn('deployer');
    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'window' }).expect(201);

    const res = await request(app)
      .post('/api/deploys')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'deploy', app: 'web', sha: SHA_A, requester: requester('claude') });
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('app_frozen');
    expect(await db.approval.count()).toBe(0);
  });

  it('deploying a different, unfrozen app is unaffected', async () => {
    const deployer = await signIn('deployer');
    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'window' }).expect(201);

    const res = await request(app).post('/api/deploys').set('Cookie', deployer.cookie).send({ kind: 'deploy', app: 'api', sha: SHA_A });
    expect(res.status).toBe(201);
    expect((res.body as DeployAccepted).state).toBe('locked');
  });

  it('once cleared, a deploy is accepted again', async () => {
    const deployer = await signIn('deployer');
    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'window' }).expect(201);
    await request(app).delete('/api/apps/web/freeze').set('Cookie', deployer.cookie).expect(200);

    const res = await request(app).post('/api/deploys').set('Cookie', deployer.cookie).send({ kind: 'deploy', app: 'web', sha: SHA_A });
    expect(res.status).toBe(201);
    expect((res.body as DeployAccepted).state).toBe('locked');
  });
});

describe('a held approval of an app frozen after the request (SHP-REQ-077)', () => {
  it('approving a held deploy is refused app_frozen; a held rollback is still approvable', async () => {
    const token = await tokenFor('claude', ['web']);
    const app2 = await db.app.update({ where: { name: 'web' }, data: { approvalPolicy: 'required' } });
    expect(app2.approvalPolicy).toBe('required');

    const held = await request(app)
      .post('/api/deploys')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'deploy', app: 'web', sha: SHA_A, requester: requester('claude: held') });
    expect((held.body as DeployAccepted).state).toBe('awaiting_approval');

    const deployer = await signIn('deployer');
    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'froze after request' }).expect(201);

    const approve = await request(app).post(`/api/deploys/${(held.body as DeployAccepted).deployId}/approve`).set('Cookie', deployer.cookie);
    expect(approve.status).toBe(409);
    expect(err(approve).code).toBe('app_frozen');
  });

  it('a held rollback stays approvable while the app is frozen', async () => {
    const token = await tokenFor('claude', ['web']);
    await db.app.update({ where: { name: 'web' }, data: { approvalPolicy: 'required' } });
    const earlier = await db.deploy.create({
      data: {
        requestedSha: SHA_B,
        requesterLabel: 'earlier',
        targets: { create: { appId: appIds.get('web') ?? '', state: 'succeeded', endedAt: new Date(), dispatchedAt: new Date() } },
      },
      select: { id: true },
    });
    const held = await request(app)
      .post('/api/deploys')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'rollback', app: 'web', toDeployId: earlier.id, requester: requester('claude: held rollback') });
    expect((held.body as DeployAccepted).state).toBe('awaiting_approval');

    const deployer = await signIn('deployer');
    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'froze after request' }).expect(201);

    const approve = await request(app).post(`/api/deploys/${(held.body as DeployAccepted).deployId}/approve`).set('Cookie', deployer.cookie);
    expect(approve.status).toBe(200);
    expect((approve.body as DeployAccepted).state).toBe('locked');
  });
});
