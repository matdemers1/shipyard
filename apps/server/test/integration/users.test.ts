import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession, totpCode } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { hashInviteToken } from '../../src/users/index.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  PUBLIC_URL: 'http://shipyard.example.test',
  SESSION_SECRET: 'test-session-secret',
});

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';
const PASSWORD = 'a long enough password';

let app: Express;
const unaudited: string[] = [];

function err(res: { body: unknown }): { code: string; message: string; fix: string } {
  return (res.body as { error: { code: string; message: string; fix: string } }).error;
}

async function signIn(role: Role): Promise<{ userId: string; cookie: string }> {
  const user = await db.user.create({
    data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role, totpEnabledAt: new Date() },
  });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, cookie: `${SESSION_COOKIE}=${session.token}` };
}

async function invite(cookie: string, email: string, role: 'deployer' | 'viewer') {
  const res = await request(app).post('/api/invites').set('Cookie', cookie).send({ email, role });
  expect(res.status).toBe(201);
  return res.body as { id: string; token: string; link: string; email: string; role: Role };
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "audit_event", "invite", "drift_event", "identity", "session", "api_token_app", "api_token", "app", "agent", "user" cascade',
  );
  unaudited.length = 0;
  app = createApp({
    db,
    logger: pino({ enabled: false }),
    config,
    onUnauditedMutation: (info) => unaudited.push(`${info.method} ${info.path}`),
  });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('invites', () => {
  it('round trip: one user with the invite role, only after the TOTP confirm, who can then sign in', async () => {
    const admin = await signIn('admin');
    const created = await invite(admin.cookie, 'New.Person@Example.com', 'viewer');
    expect(created.token).toMatch(/^inv_[A-Za-z0-9_-]{43}$/);
    expect(created.link).toBe(`http://shipyard.example.test/invite/${created.token}`);
    expect(created.email).toBe('new.person@example.com');

    // Only the hash is stored.
    const row = await db.invite.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.tokenHash).toBe(hashInviteToken(created.token));
    const text = (await db.$queryRawUnsafe<{ t: string }[]>('select row_to_json(x)::text as t from "invite" x'))
      .map((r) => r.t)
      .join('\n');
    expect(text).not.toContain(created.token);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);

    const peek = await request(app).get(`/api/invites/${created.token}`);
    expect(peek.status).toBe(200);
    expect(peek.body).toEqual({ email: 'new.person@example.com', role: 'viewer', expired: false });

    const short = await request(app)
      .post(`/api/invites/${created.token}/accept`)
      .send({ displayName: 'New', password: 'too short' });
    expect(short.status).toBe(400);

    const accepted = await request(app)
      .post(`/api/invites/${created.token}/accept`)
      .send({ displayName: 'New Person', password: PASSWORD });
    expect(accepted.status).toBe(200);
    const { otpauthUri } = accepted.body as { otpauthUri: string };
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const secret = new URL(otpauthUri).searchParams.get('secret') ?? '';

    // Not consumed yet, and the new user cannot sign in without TOTP.
    expect((await db.invite.findUniqueOrThrow({ where: { id: created.id } })).acceptedAt).toBeNull();
    const early = await request(app).post('/api/auth/login').send({ email: 'new.person@example.com', password: PASSWORD });
    expect(early.status).toBe(401);

    const wrong = await request(app)
      .post(`/api/invites/${created.token}/confirm-totp`)
      .send({ code: totpCode(secret, Date.now() + 10 * 60_000) });
    expect(wrong.status).toBe(401);

    const confirmed = await request(app)
      .post(`/api/invites/${created.token}/confirm-totp`)
      .send({ code: totpCode(secret, Date.now() - 30_000) });
    expect(confirmed.status).toBe(200);

    const users = await db.user.findMany({ where: { email: 'new.person@example.com' } });
    expect(users).toHaveLength(1);
    expect(users[0]?.role).toBe('viewer');
    expect(users[0]?.totpEnabledAt).not.toBeNull();
    expect((await db.invite.findUniqueOrThrow({ where: { id: created.id } })).acceptedAt).not.toBeNull();
    expect(await db.user.count()).toBe(2);

    // Consumed: the link no longer works.
    expect((await request(app).get(`/api/invites/${created.token}`)).status).toBe(404);
    const again = await request(app)
      .post(`/api/invites/${created.token}/accept`)
      .send({ displayName: 'Again', password: PASSWORD });
    expect(again.status).toBe(404);

    // Password + TOTP sign-in works.
    const browser = request.agent(app);
    const step1 = await browser.post('/api/auth/login').send({ email: 'new.person@example.com', password: PASSWORD });
    expect(step1.status).toBe(200);
    const step2 = await browser.post('/api/auth/totp').send({ code: totpCode(secret) });
    expect(step2.status).toBe(200);
    const me = await browser.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect((me.body as { role: string }).role).toBe('viewer');

    const actions = (await db.auditEvent.findMany({ select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['invite.created', 'invite.accepted_pending_totp', 'invite.accepted']),
    );
    expect(unaudited).toEqual([]);
  });

  it('an unconfirmed accept can restart, and still yields exactly one user', async () => {
    const admin = await signIn('deployer');
    const created = await invite(admin.cookie, 'restart@example.com', 'deployer');
    const first = await request(app)
      .post(`/api/invites/${created.token}/accept`)
      .send({ displayName: 'First', password: PASSWORD });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/invites/${created.token}/accept`)
      .send({ displayName: 'Second', password: PASSWORD });
    expect(second.status).toBe(200);
    const secret = new URL((second.body as { otpauthUri: string }).otpauthUri).searchParams.get('secret') ?? '';
    const ok = await request(app).post(`/api/invites/${created.token}/confirm-totp`).send({ code: totpCode(secret) });
    expect(ok.status).toBe(200);
    const users = await db.user.findMany({ where: { email: 'restart@example.com' } });
    expect(users).toHaveLength(1);
    expect(users[0]?.displayName).toBe('Second');
    expect(users[0]?.role).toBe('deployer');
  });

  it('refuses an expired invite', async () => {
    const admin = await signIn('admin');
    const created = await invite(admin.cookie, 'late@example.com', 'viewer');
    await db.invite.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const peek = await request(app).get(`/api/invites/${created.token}`);
    expect(peek.status).toBe(200);
    expect((peek.body as { expired: boolean }).expired).toBe(true);
    const res = await request(app)
      .post(`/api/invites/${created.token}/accept`)
      .send({ displayName: 'Late', password: PASSWORD });
    expect(res.status).toBe(409);
    expect(err(res).message).toMatch(/expired/);
    expect(await db.user.count({ where: { email: 'late@example.com' } })).toBe(0);
    // Not in the pending list either.
    const list = await request(app).get('/api/invites').set('Cookie', admin.cookie);
    expect(list.body).toEqual([]);
  });

  it('refuses a revoked invite, and an unknown one', async () => {
    const admin = await signIn('admin');
    const created = await invite(admin.cookie, 'gone@example.com', 'viewer');
    const list = await request(app).get('/api/invites').set('Cookie', admin.cookie);
    expect((list.body as { id: string }[]).map((i) => i.id)).toEqual([created.id]);
    const revoked = await request(app).delete(`/api/invites/${created.id}`).set('Cookie', admin.cookie);
    expect(revoked.status).toBe(200);
    expect((await request(app).get(`/api/invites/${created.token}`)).status).toBe(404);
    const res = await request(app)
      .post(`/api/invites/${created.token}/accept`)
      .send({ displayName: 'Gone', password: PASSWORD });
    expect(res.status).toBe(404);
    expect(await db.user.count({ where: { email: 'gone@example.com' } })).toBe(0);
    expect((await request(app).get(`/api/invites/inv_${'x'.repeat(43)}`)).status).toBe(404);
    expect((await request(app).get('/api/invites/nonsense')).status).toBe(404);
  });

  it('a newer invite to the same address supersedes the older one', async () => {
    const admin = await signIn('admin');
    const older = await invite(admin.cookie, 'twice@example.com', 'viewer');
    const newer = await invite(admin.cookie, 'twice@example.com', 'deployer');
    expect((await request(app).get(`/api/invites/${older.token}`)).status).toBe(404);
    expect((await request(app).get(`/api/invites/${newer.token}`)).status).toBe(200);
  });

  it('a replacement invite cannot be confirmed with the superseded invite\'s TOTP secret, and the role never leaks across', async () => {
    const admin = await signIn('admin');
    const first = await invite(admin.cookie, 'escalate@example.com', 'deployer');
    const accepted = await request(app)
      .post(`/api/invites/${first.token}/accept`)
      .send({ displayName: 'Escalate', password: PASSWORD });
    expect(accepted.status).toBe(200);
    const secret = new URL((accepted.body as { otpauthUri: string }).otpauthUri).searchParams.get('secret') ?? '';

    // Re-invite the same address at a lower role. The pending account from the first accept is
    // gone, so it has no working login and cannot be revived by anything, including the old secret.
    const second = await invite(admin.cookie, 'escalate@example.com', 'viewer');
    expect(await db.user.count({ where: { email: 'escalate@example.com' } })).toBe(0);

    const wrongInvite = await request(app)
      .post(`/api/invites/${first.token}/confirm-totp`)
      .send({ code: totpCode(secret) });
    expect(wrongInvite.status).toBe(404); // the first invite is revoked/invalid now

    const stolenSecret = await request(app)
      .post(`/api/invites/${second.token}/confirm-totp`)
      .send({ code: totpCode(secret) });
    expect(stolenSecret.status).toBe(409);
    expect(err(stolenSecret).message).toMatch(/not been accepted yet/);
    expect(await db.user.count({ where: { email: 'escalate@example.com' } })).toBe(0);

    // Accepting and confirming the replacement invite properly yields the new, lower role.
    const secondAccept = await request(app)
      .post(`/api/invites/${second.token}/accept`)
      .send({ displayName: 'Escalate', password: PASSWORD });
    expect(secondAccept.status).toBe(200);
    const secondSecret = new URL((secondAccept.body as { otpauthUri: string }).otpauthUri).searchParams.get('secret') ?? '';
    const confirmed = await request(app)
      .post(`/api/invites/${second.token}/confirm-totp`)
      .send({ code: totpCode(secondSecret) });
    expect(confirmed.status).toBe(200);
    const users = await db.user.findMany({ where: { email: 'escalate@example.com' } });
    expect(users).toHaveLength(1);
    expect(users[0]?.role).toBe('viewer');
  });

  it('the reverse direction: a re-invite to a higher role is never left at the lower one', async () => {
    const admin = await signIn('admin');
    const first = await invite(admin.cookie, 'promote@example.com', 'viewer');
    await request(app).post(`/api/invites/${first.token}/accept`).send({ displayName: 'Promote', password: PASSWORD });

    const second = await invite(admin.cookie, 'promote@example.com', 'deployer');
    const secondAccept = await request(app)
      .post(`/api/invites/${second.token}/accept`)
      .send({ displayName: 'Promote', password: PASSWORD });
    expect(secondAccept.status).toBe(200);
    const secret = new URL((secondAccept.body as { otpauthUri: string }).otpauthUri).searchParams.get('secret') ?? '';
    const confirmed = await request(app)
      .post(`/api/invites/${second.token}/confirm-totp`)
      .send({ code: totpCode(secret) });
    expect(confirmed.status).toBe(200);
    const users = await db.user.findMany({ where: { email: 'promote@example.com' } });
    expect(users).toHaveLength(1);
    expect(users[0]?.role).toBe('deployer');
  });

  it('concurrent first-accepts of one invite yield exactly one user, the loser refused not 500', async () => {
    const admin = await signIn('admin');
    const created = await invite(admin.cookie, 'racer@example.com', 'deployer');
    const [a, b] = await Promise.all([
      request(app).post(`/api/invites/${created.token}/accept`).send({ displayName: 'A', password: PASSWORD }),
      request(app).post(`/api/invites/${created.token}/accept`).send({ displayName: 'B', password: PASSWORD }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await db.user.count({ where: { email: 'racer@example.com' } })).toBe(1);
  });

  it('refuses an invite for an address that already has an account', async () => {
    const admin = await signIn('admin');
    const existing = await db.user.findUniqueOrThrow({ where: { id: admin.userId } });
    const res = await request(app).post('/api/invites').set('Cookie', admin.cookie).send({ email: existing.email, role: 'viewer' });
    expect(res.status).toBe(409);
  });

  it('only deployer or viewer roles may be invited', async () => {
    const admin = await signIn('admin');
    const res = await request(app).post('/api/invites').set('Cookie', admin.cookie).send({ email: 'x@example.com', role: 'admin' });
    expect(res.status).toBe(400);
  });

  it('a viewer cannot list users, invite, or list invites', async () => {
    const viewer = await signIn('viewer');
    const users = await request(app).get('/api/users').set('Cookie', viewer.cookie);
    expect(users.status).toBe(403);
    const inv = await request(app).post('/api/invites').set('Cookie', viewer.cookie).send({ email: 'v@example.com', role: 'viewer' });
    expect(inv.status).toBe(403);
    expect((await request(app).get('/api/invites').set('Cookie', viewer.cookie)).status).toBe(403);
    expect(await db.invite.count()).toBe(0);
    // Signed out entirely.
    expect((await request(app).get('/api/users')).status).toBe(401);
  });

  it('rate-limits the public invite routes per address', async () => {
    app = createApp({ db, logger: pino({ enabled: false }), config });
    // The default limit is 30 per window; exhaust it.
    let last = 0;
    for (let i = 0; i < 31; i += 1) last = (await request(app).get(`/api/invites/inv_${'y'.repeat(43)}`)).status;
    expect(last).toBe(429);
  });
});

describe('users', () => {
  it('lists users with role, TOTP and D3 Auth link', async () => {
    const admin = await signIn('admin');
    await db.identity.create({ data: { userId: admin.userId, issuer: 'https://auth.example.test', subject: 's1' } });
    const res = await request(app).get('/api/users').set('Cookie', admin.cookie);
    expect(res.status).toBe(200);
    const [row] = res.body as { id: string; role: string; totpEnrolled: boolean; d3authLinked: boolean; disabled: boolean }[];
    expect(row).toMatchObject({ id: admin.userId, role: 'admin', totpEnrolled: false, d3authLinked: true, disabled: false });
  });

  it('the last active admin cannot be demoted or disabled', async () => {
    const admin = await signIn('admin');
    const demote = await request(app).patch(`/api/users/${admin.userId}`).set('Cookie', admin.cookie).send({ role: 'viewer' });
    expect(demote.status).toBe(409);
    expect(err(demote).message).toMatch(/last active admin/);
    const disable = await request(app).patch(`/api/users/${admin.userId}`).set('Cookie', admin.cookie).send({ disabled: true });
    expect(disable.status).toBe(409);
    expect((await db.user.findUniqueOrThrow({ where: { id: admin.userId } })).role).toBe('admin');
  });

  it('an admin can change another user, but not themself; a deployer cannot change anyone', async () => {
    const a = await signIn('admin');
    const b = await signIn('admin');
    const d = await signIn('deployer');

    const self = await request(app).patch(`/api/users/${a.userId}`).set('Cookie', a.cookie).send({ role: 'viewer' });
    expect(self.status).toBe(409);

    const demote = await request(app).patch(`/api/users/${b.userId}`).set('Cookie', a.cookie).send({ role: 'deployer' });
    expect(demote.status).toBe(200);
    expect((demote.body as { role: string }).role).toBe('deployer');

    const disable = await request(app).patch(`/api/users/${d.userId}`).set('Cookie', a.cookie).send({ disabled: true });
    expect(disable.status).toBe(200);
    // The disabled user's session is gone.
    expect((await request(app).get('/api/auth/me').set('Cookie', d.cookie)).status).toBe(401);

    const byDeployer = await request(app).patch(`/api/users/${a.userId}`).set('Cookie', b.cookie).send({ role: 'viewer' });
    expect(byDeployer.status).toBe(403);

    const audits = await db.auditEvent.count({ where: { action: 'user.updated' } });
    expect(audits).toBe(2);
    expect(unaudited).toEqual([]);
  });

  it('two admins demoting each other at once leave exactly one admin', async () => {
    const a = await signIn('admin');
    const b = await signIn('admin');
    const [r1, r2] = await Promise.all([
      request(app).patch(`/api/users/${b.userId}`).set('Cookie', a.cookie).send({ role: 'viewer' }),
      request(app).patch(`/api/users/${a.userId}`).set('Cookie', b.cookie).send({ role: 'viewer' }),
    ]);
    // Exactly one succeeds; the other is refused — either by the last-admin check (409, if it
    // raced in ahead of the role change) or by requireRole re-reading its now-demoted actor (403,
    // if it lost the race entirely). Either way, never both 200.
    const statuses = [r1.status, r2.status];
    const successes = statuses.filter((s) => s === 200);
    const refusals = statuses.filter((s) => s !== 200);
    expect(successes).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    expect([403, 409]).toContain(refusals[0]);
    const admins = await db.user.count({ where: { role: 'admin', disabledAt: null } });
    expect(admins).toBe(1);
  });
});

describe('out-of-band stats', () => {
  it('counts adopt_live drift resolutions per calendar month', async () => {
    const viewer = await signIn('viewer');
    const agent = await db.agent.create({ data: { publicKey: 'k', fingerprint: `fp-${randomUUID()}` } });
    const appRow = await db.app.create({
      data: { name: 'web', agentId: agent.id, manifestYaml: 'name: web\n', manifestSha256: '0'.repeat(64) },
    });
    const now = new Date();
    const monthsAgo = (n: number, day = 15) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day, 12));
    const drift = (resolvedAt: Date | null, resolution: 'adopt_live' | 'redeploy_recorded' | null) =>
      db.driftEvent.create({
        data: {
          appId: appRow.id,
          observed: {},
          recorded: {},
          resolvedAt,
          resolution,
        },
      });
    await drift(monthsAgo(0, 1), 'adopt_live');
    await drift(monthsAgo(0, 2), 'adopt_live');
    await drift(monthsAgo(0, 3), 'redeploy_recorded');
    await drift(monthsAgo(2), 'adopt_live');
    await drift(monthsAgo(8), 'adopt_live'); // outside six months
    await drift(null, null);

    const res = await request(app).get('/api/stats/out-of-band?months=6').set('Cookie', viewer.cookie);
    expect(res.status).toBe(200);
    const months = (res.body as { months: { month: string; count: number }[] }).months;
    expect(months).toHaveLength(6);
    const key = (d: Date) => d.toISOString().slice(0, 7);
    expect(months[5]).toEqual({ month: key(monthsAgo(0)), count: 2 });
    expect(months[3]).toEqual({ month: key(monthsAgo(2)), count: 1 });
    expect(months.reduce((n, m) => n + m.count, 0)).toBe(3);
    expect((await request(app).get('/api/stats/out-of-band')).status).toBe(401);
  });
});
