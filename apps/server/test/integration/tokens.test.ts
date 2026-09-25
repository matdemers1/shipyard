import { randomUUID } from 'node:crypto';
import { Router, type Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, assertCanActOn, createSession } from '../../src/auth/index.js';
import { sendRefusal } from '../../src/errors.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { hashToken } from '../../src/tokens/index.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

function buildApp(): Express {
  const testRouter = Router();
  // Stands in for a later deploy route: every app-scoped action calls assertCanActOn.
  testRouter.post('/act/:app', async (req, res) => {
    const app = typeof req.params['app'] === 'string' ? req.params['app'] : '';
    const denied = assertCanActOn(req, app);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    await req.audit({ action: 'test.act', entityType: 'app', entityId: app });
    res.json({ ok: true, actor: req.actor, apps: [...(req.tokenApps ?? [])] });
  });
  return createApp({ db, logger: pino({ enabled: false }), config, testRouter });
}

let app: Express;

interface Summary {
  revokedAt: string | null;
}

/** The refusal in an error response. */
function err(res: { body: unknown }): { code: string; message: string } {
  return (res.body as { error: { code: string; message: string } }).error;
}

async function signIn(role: Role): Promise<{ userId: string; cookie: string }> {
  const user = await db.user.create({
    data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role },
  });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, cookie: `${SESSION_COOKIE}=${session.token}` };
}

async function seedApps(...names: string[]): Promise<void> {
  const agent = await db.agent.create({
    data: { publicKey: 'test-key', fingerprint: `fp-${randomUUID()}` },
  });
  for (const name of names) {
    await db.app.create({
      data: { name, agentId: agent.id, manifestYaml: `name: ${name}\n`, manifestSha256: '0'.repeat(64) },
    });
  }
}

async function issue(cookie: string, apps: string[], label = 'ci'): Promise<{ id: string; token: string; prefix: string }> {
  const res = await request(app).post('/api/tokens').set('Cookie', cookie).send({ label, apps });
  expect(res.status).toBe(201);
  return res.body as { id: string; token: string; prefix: string };
}

/** Every column of every row of a table, as text, so a search cannot miss one. */
async function tableText(table: 'api_token' | 'audit_event' | 'api_token_app'): Promise<string> {
  const rows = await db.$queryRawUnsafe<{ t: string }[]>(`select row_to_json(x)::text as t from "${table}" x`);
  return rows.map((r) => r.t).join('\n');
}

beforeEach(async () => {
  await db.$executeRawUnsafe('truncate table "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade');
  await seedApps('web', 'api', 'billing');
  app = buildApp();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('issuing a token', () => {
  it('shows the token once, and stores only its hash: no plaintext in any column of api_token or audit_event', async () => {
    const { cookie, userId } = await signIn('deployer');
    const res = await request(app).post('/api/tokens').set('Cookie', cookie).send({ label: 'ci', apps: ['web', 'api'] });

    expect(res.status).toBe(201);
    const body = res.body as { id: string; label: string; prefix: string; apps: string[]; token: string };
    expect(body.token).toMatch(/^shp_[A-Za-z0-9_-]{43}$/);
    expect(body.prefix).toBe(body.token.slice(0, 12));
    expect(body.apps).toEqual(['api', 'web']);
    expect(body.label).toBe('ci');

    const row = await db.apiToken.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.userId).toBe(userId);
    expect(row.tokenHash).toBe(hashToken(body.token));
    expect(row.tokenHash).not.toBe(body.token);
    expect(row.tokenHash).not.toContain(body.token);

    const random = body.token.slice(4);
    for (const table of ['api_token', 'audit_event', 'api_token_app'] as const) {
      const text = await tableText(table);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(body.token);
      expect(text).not.toContain(random);
    }
    // The audit row has the hash nowhere either.
    expect(await tableText('audit_event')).not.toContain(row.tokenHash);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'token.created' } });
    expect(audit.entityId).toBe(body.id);
    expect(audit.after).toEqual({ label: 'ci', prefix: body.prefix, apps: ['api', 'web'] });
  });

  it('refuses an app the agent has not reported, naming it', async () => {
    const { cookie } = await signIn('admin');
    const res = await request(app).post('/api/tokens').set('Cookie', cookie).send({ label: 'x', apps: ['web', 'ghost'] });
    expect(res.status).toBe(404);
    expect(err(res).code).toBe('unknown_app');
    expect(err(res).message).toContain('ghost');
    expect(await db.apiToken.count()).toBe(0);
  });

  it('refuses a body without apps', async () => {
    const { cookie } = await signIn('admin');
    const res = await request(app).post('/api/tokens').set('Cookie', cookie).send({ label: 'x', apps: [] });
    expect(res.status).toBe(400);
    expect(err(res).code).toBe('invalid_request');
  });

  it('refuses a viewer (SHP-REQ-065)', async () => {
    const { cookie } = await signIn('viewer');
    const res = await request(app).post('/api/tokens').set('Cookie', cookie).send({ label: 'x', apps: ['web'] });
    expect(res.status).toBe(403);
    expect(err(res).code).toBe('forbidden');
    expect(await db.apiToken.count()).toBe(0);
  });

  it('refuses anonymous requests', async () => {
    const res = await request(app).post('/api/tokens').send({ label: 'x', apps: ['web'] });
    expect(res.status).toBe(401);
  });

  it('refuses a token trying to manage tokens', async () => {
    const { cookie } = await signIn('admin');
    const { token } = await issue(cookie, ['web']);
    for (const res of [
      await request(app).post('/api/tokens').set('Authorization', `Bearer ${token}`).send({ label: 'x', apps: ['web'] }),
      await request(app).get('/api/tokens').set('Authorization', `Bearer ${token}`),
    ]) {
      expect(res.status).toBe(403);
      expect(err(res).code).toBe('forbidden');
    }
    expect(await db.apiToken.count()).toBe(1);
  });
});

describe('using a token', () => {
  it('authenticates a bearer request as the token and records last-used time and address', async () => {
    const { cookie } = await signIn('deployer');
    const { id, token } = await issue(cookie, ['web']);

    const res = await request(app).post('/api/_test/act/web').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect((res.body as { actor: unknown }).actor).toEqual({ type: 'token', id, label: 'token ci' });
    expect((res.body as { apps: unknown }).apps).toEqual(['web']);

    const row = await db.apiToken.findUniqueOrThrow({ where: { id } });
    expect(row.lastUsedAt).not.toBeNull();
    expect(row.lastUsedIp).toBeTruthy();

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'test.act' } });
    expect(audit.actorType).toBe('token');
    expect(audit.actorTokenId).toBe(id);
  });

  it('bumps last-used at most once a minute', async () => {
    const { cookie } = await signIn('deployer');
    const { id, token } = await issue(cookie, ['web']);
    await request(app).post('/api/_test/act/web').set('Authorization', `Bearer ${token}`);
    const first = (await db.apiToken.findUniqueOrThrow({ where: { id } })).lastUsedAt;
    await request(app).post('/api/_test/act/web').set('Authorization', `Bearer ${token}`);
    const second = (await db.apiToken.findUniqueOrThrow({ where: { id } })).lastUsedAt;
    expect(second?.getTime()).toBe(first?.getTime());
  });

  it('refuses an app outside the token scope with 403 (SHP-REQ-047)', async () => {
    const { cookie } = await signIn('deployer');
    const { token } = await issue(cookie, ['web', 'api']);

    expect((await request(app).post('/api/_test/act/api').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const res = await request(app).post('/api/_test/act/billing').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(err(res).code).toBe('forbidden');
    expect(err(res).message).toContain('not scoped to billing');
  });

  it('refuses a token whose owner has since been made a viewer', async () => {
    const { cookie, userId } = await signIn('deployer');
    const { token } = await issue(cookie, ['web']);
    await db.user.update({ where: { id: userId }, data: { role: 'viewer' } });
    const res = await request(app).post('/api/_test/act/web').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('refuses a viewer session in assertCanActOn, and lets a deployer session through', async () => {
    const viewer = await signIn('viewer');
    const res = await request(app).post('/api/_test/act/web').set('Cookie', viewer.cookie);
    expect(res.status).toBe(403);
    expect(err(res).code).toBe('forbidden');

    const deployer = await signIn('deployer');
    expect((await request(app).post('/api/_test/act/web').set('Cookie', deployer.cookie)).status).toBe(200);
  });

  it('answers an unknown token with 401, even alongside a valid session', async () => {
    const { cookie } = await signIn('admin');
    const unknown = `shp_${'A'.repeat(43)}`;
    const res = await request(app)
      .post('/api/_test/act/web')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${unknown}`);
    expect(res.status).toBe(401);
    expect(err(res).code).toBe('unauthenticated');
  });

  it('answers a malformed Authorization header with 401', async () => {
    for (const header of ['Bearer', 'Bearer not-a-token', 'Basic dXNlcjpwYXNz', 'shp_abc']) {
      const res = await request(app).get('/api/health').set('Authorization', header);
      expect(res.status, header).toBe(401);
    }
  });
});

describe('listing and revoking', () => {
  it('lists your own tokens with prefix, apps and last use, never the token or its hash; an admin sees all', async () => {
    const alice = await signIn('deployer');
    const bob = await signIn('deployer');
    const admin = await signIn('admin');
    const a = await issue(alice.cookie, ['web'], 'alice-ci');
    await issue(bob.cookie, ['api'], 'bob-ci');
    await request(app).post('/api/_test/act/web').set('Authorization', `Bearer ${a.token}`);

    const res = await request(app).get('/api/tokens').set('Cookie', alice.cookie);
    expect(res.status).toBe(200);
    const list = res.body as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: a.id, label: 'alice-ci', prefix: a.prefix, apps: ['web'], revokedAt: null });
    expect(list[0]?.['lastUsedAt']).toEqual(expect.any(String));
    expect(list[0]?.['lastUsedIp']).toEqual(expect.any(String));
    expect(list[0]).not.toHaveProperty('tokenHash');
    expect(list[0]).not.toHaveProperty('token');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(a.token);
    expect(text).not.toContain(hashToken(a.token));

    const all = await request(app).get('/api/tokens').set('Cookie', admin.cookie);
    expect((all.body as unknown[]).length).toBe(2);
  });

  it('revokes a token: it then answers 401, and revoking again is idempotent', async () => {
    const { cookie } = await signIn('deployer');
    const { id, token } = await issue(cookie, ['web']);

    const res = await request(app).delete(`/api/tokens/${id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect((res.body as Summary).revokedAt).toEqual(expect.any(String));
    const again = await request(app).delete(`/api/tokens/${id}`).set('Cookie', cookie);
    expect(again.status).toBe(200);
    expect((again.body as Summary).revokedAt).toBe((res.body as Summary).revokedAt);

    const used = await request(app).post('/api/_test/act/web').set('Authorization', `Bearer ${token}`);
    expect(used.status).toBe(401);
    expect(err(used).code).toBe('unauthenticated');

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'token.revoked' } });
    expect(audit.entityId).toBe(id);
    expect(await tableText('audit_event')).not.toContain(token);
  });

  it("lets only the owner or an admin revoke; someone else's token is not found", async () => {
    const alice = await signIn('deployer');
    const bob = await signIn('deployer');
    const admin = await signIn('admin');
    const { id } = await issue(alice.cookie, ['web']);

    expect((await request(app).delete(`/api/tokens/${id}`).set('Cookie', bob.cookie)).status).toBe(404);
    expect((await db.apiToken.findUniqueOrThrow({ where: { id } })).revokedAt).toBeNull();
    expect((await request(app).delete(`/api/tokens/${id}`).set('Cookie', admin.cookie)).status).toBe(200);
    expect((await request(app).delete('/api/tokens/not-a-uuid').set('Cookie', admin.cookie)).status).toBe(404);
  });

  it('refuses a viewer revoking', async () => {
    const owner = await signIn('deployer');
    const { id } = await issue(owner.cookie, ['web']);
    await db.user.update({ where: { id: owner.userId }, data: { role: 'viewer' } });
    const res = await request(app).delete(`/api/tokens/${id}`).set('Cookie', owner.cookie);
    expect(res.status).toBe(403);
  });
});
