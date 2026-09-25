import { randomUUID } from 'node:crypto';
import { Router, type Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import {
  OidcError,
  PendingSignIns,
  SESSION_COOKIE,
  hashPassword,
  generateTotpSecret,
  hashSessionToken,
  totpCode,
  type CompletedSignIn,
  type OidcClient,
} from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * A valid TOTP code for `secret` from a step not used yet in this test run. The replay guard
 * (correctly) refuses a second sign-in with the same step's code, so two sign-ins by one user in
 * the same 30 s would otherwise fail or pass depending on where the clock falls. Offsets stay
 * inside the ±1-step window the server accepts.
 */
const usedTotpSteps = new Map<string, number>();
function freshTotp(secret: string): string {
  const n = usedTotpSteps.get(secret) ?? 0;
  usedTotpSteps.set(secret, n + 1);
  const offsets = [0, 30_000, -30_000];
  return totpCode(secret, Date.now() + (offsets[n % offsets.length] ?? 0));
}


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

const ISSUER = 'https://auth.example.test';
const PASSWORD = 'correct horse battery staple';

/**
 * Stands in for the SDK (tested upstream). It keeps the same tx/state bookkeeping as the real
 * wrapper, and returns whatever `(iss, sub, email)` the test queues for the next callback.
 */
class FakeOidc implements OidcClient {
  readonly issuer = ISSUER;
  next: { iss: string; sub: string; email?: string } = { iss: ISSUER, sub: 'unset' };
  private readonly pending = new PendingSignIns<{ state: string; expiresAt: number; linkToUserId?: string }>();

  beginSignIn(linkToUserId?: string): Promise<{ url: string; tx: string }> {
    const state = randomUUID();
    const tx = this.pending.put({
      state,
      expiresAt: Date.now() + 60_000,
      ...(linkToUserId !== undefined ? { linkToUserId } : {}),
    });
    return Promise.resolve({ url: `${ISSUER}/authorize?state=${state}`, tx });
  }

  completeSignIn(_callbackUrl: URL, tx: string, state: string): Promise<CompletedSignIn> {
    const started = this.pending.take(tx);
    if (started.state !== state) throw new OidcError('The sign-in state did not match.');
    return Promise.resolve({
      ...this.next,
      ...(started.linkToUserId !== undefined ? { linkToUserId: started.linkToUserId } : {}),
    });
  }
}

let oidc: FakeOidc;
let app: Express;

function buildApp(): Express {
  const testRouter = Router();
  testRouter.get('/audit-without-actor', async (req, res) => {
    try {
      await req.audit({ action: 'test.noactor', entityType: 'thing' });
      res.json({ threw: false });
    } catch (error) {
      res.json({ threw: true, message: error instanceof Error ? error.message : String(error) });
    }
  });
  return createApp({ db, logger: pino({ enabled: false }), config, oidc, testRouter });
}

interface Seeded {
  id: string;
  email: string;
  totpSecret: string;
}

async function seedUser(opts: { totp?: boolean; disabled?: boolean; email?: string } = {}): Promise<Seeded> {
  const totpSecret = generateTotpSecret();
  const email = opts.email ?? `op-${randomUUID()}@example.com`;
  const user = await db.user.create({
    data: {
      email,
      displayName: 'Operator',
      role: 'admin',
      passwordHash: await hashPassword(PASSWORD),
      ...(opts.totp === false ? {} : { totpSecret, totpEnabledAt: new Date() }),
      ...(opts.disabled === true ? { disabledAt: new Date() } : {}),
    },
  });
  return { id: user.id, email, totpSecret };
}

/** Password + TOTP on `agent`, leaving it signed in. Returns the code used. */
async function passwordLogin(agent: ReturnType<typeof request.agent>, user: Seeded): Promise<string> {
  const step1 = await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
  expect(step1.status).toBe(200);
  expect(step1.body).toEqual({ next: 'totp' });
  const code = freshTotp(user.totpSecret);
  const step2 = await agent.post('/api/auth/totp').send({ code });
  expect(step2.status).toBe(200);
  return code;
}

/** Runs start → callback on `agent` and returns the callback response. */
async function oidcRoundTrip(agent: ReturnType<typeof request.agent>): Promise<request.Response> {
  const start = await agent.get('/api/auth/oidc/start');
  expect(start.status).toBe(302);
  const location = new URL(start.headers['location'] as string);
  const state = location.searchParams.get('state') ?? '';
  return agent.get(`/api/auth/oidc/callback?code=abc&state=${encodeURIComponent(state)}`);
}

function expectRefusal(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  const body = res.body as { error?: Record<string, unknown> };
  expect(body.error, `no refusal body: ${res.status} ${String(res.headers['content-type'])} ${res.text}`).toBeDefined();
  expect(Object.keys(body.error ?? {}).sort()).toEqual(['code', 'fix', 'gate', 'message']);
  expect(body.error?.['code']).toBe(code);
}

beforeEach(async () => {
  await db.$executeRawUnsafe('truncate table "audit_event" cascade');
  await db.$executeRawUnsafe('truncate table "user" cascade');
  oidc = new FakeOidc();
  app = buildApp();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('dual login reaches the same account (SHP-REQ-001)', () => {
  it('password + TOTP, then link D3 Auth, then D3 Auth alone signs in as the same user', async () => {
    const user = await seedUser();

    // 1. Password + TOTP.
    const browser = request.agent(app);
    await passwordLogin(browser, user);
    const me1 = await browser.get('/api/auth/me');
    expect(me1.status).toBe(200);
    expect(me1.body).toMatchObject({ id: user.id, email: user.email, role: 'admin', identities: [] });

    // 2. Link while signed in.
    oidc.next = { iss: ISSUER, sub: 'sub-123', email: user.email };
    const linked = await oidcRoundTrip(browser);
    expect(linked.status).toBe(302);
    expect(linked.headers['location']).toBe('/');
    const identity = await db.identity.findUnique({ where: { issuer_subject: { issuer: ISSUER, subject: 'sub-123' } } });
    expect(identity?.userId).toBe(user.id);
    expect(identity?.emailAtLink).toBe(user.email);
    const me2 = await browser.get('/api/auth/me');
    expect(me2.body).toMatchObject({ id: user.id, identities: [{ issuer: ISSUER }] });

    // 3. A fresh browser with no cookies signs in with D3 Auth and is the same account.
    const fresh = request.agent(app);
    expectRefusal(await fresh.get('/api/auth/me'), 401, 'unauthenticated');
    const signedIn = await oidcRoundTrip(fresh);
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers['location']).toBe('/');
    const me3 = await fresh.get('/api/auth/me');
    expect(me3.status).toBe(200);
    expect((me3.body as { id: string }).id).toBe(user.id);

    const sessions = await db.session.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
    expect(sessions.map((s) => s.method)).toEqual(['password', 'oidc']);
  });

  it('refuses an unlinked (iss, sub) even when its email matches an account, and creates nothing', async () => {
    const user = await seedUser();
    oidc.next = { iss: ISSUER, sub: 'stranger', email: user.email };
    const res = await oidcRoundTrip(request.agent(app));
    expectRefusal(res, 401, 'unauthenticated');
    expect(await db.identity.count()).toBe(0);
    expect(await db.user.count()).toBe(1);
    expect(await db.session.count()).toBe(0);
  });

  it('refuses the same sub from a different issuer', async () => {
    const user = await seedUser();
    await db.identity.create({ data: { userId: user.id, issuer: ISSUER, subject: 'sub-123' } });
    oidc.next = { iss: 'https://evil.example.test', sub: 'sub-123', email: user.email };
    const res = await oidcRoundTrip(request.agent(app));
    expectRefusal(res, 401, 'unauthenticated');
    expect(await db.session.count()).toBe(0);
    expect(await db.identity.count()).toBe(1);
  });

  it('refuses to link an identity already linked to another account', async () => {
    const a = await seedUser();
    const b = await seedUser();
    await db.identity.create({ data: { userId: a.id, issuer: ISSUER, subject: 'sub-a' } });
    const browser = request.agent(app);
    await passwordLogin(browser, b);
    oidc.next = { iss: ISSUER, sub: 'sub-a' };
    expectRefusal(await oidcRoundTrip(browser), 409, 'conflict');
    const identity = await db.identity.findFirstOrThrow({ where: { subject: 'sub-a' } });
    expect(identity.userId).toBe(a.id);
  });

  it('refuses a callback with no transaction, or with a state that does not match', async () => {
    const browser = request.agent(app);
    expectRefusal(await browser.get('/api/auth/oidc/callback?code=x&state=y'), 400, 'invalid_request');

    await browser.get('/api/auth/oidc/start');
    expectRefusal(await browser.get('/api/auth/oidc/callback?code=x&state=wrong'), 401, 'unauthenticated');
  });

  it('answers a refusal on the OIDC routes when D3 Auth is unavailable, and password login still works', async () => {
    const user = await seedUser();
    const noOidc = createApp({ db, logger: pino({ enabled: false }), config, oidc: null });
    expectRefusal(await request(noOidc).get('/api/auth/oidc/start'), 400, 'invalid_request');
    const browser = request.agent(noOidc);
    await passwordLogin(browser, user);
    expect((await browser.get('/api/auth/me')).status).toBe(200);
  });
});

describe('password + TOTP refusals', () => {
  it('gives the same refusal for a wrong password and an unknown email', async () => {
    const user = await seedUser();
    const wrongPassword = await request(app).post('/api/auth/login').send({ email: user.email, password: 'nope' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: PASSWORD });
    expectRefusal(wrongPassword, 401, 'unauthenticated');
    expectRefusal(unknown, 401, 'unauthenticated');
    expect(wrongPassword.body).toEqual(unknown.body);
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a wrong TOTP code', async () => {
    const user = await seedUser();
    const browser = request.agent(app);
    await browser.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    const wrong = totpCode(user.totpSecret, Date.now() + 10 * 60_000);
    expectRefusal(await browser.post('/api/auth/totp').send({ code: wrong }), 401, 'unauthenticated');
    expect(await db.session.count()).toBe(0);
  });

  it('refuses a TOTP code that was already used', async () => {
    const user = await seedUser();
    const first = request.agent(app);
    const code = await passwordLogin(first, user);
    const second = request.agent(app);
    await second.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expectRefusal(await second.post('/api/auth/totp').send({ code }), 401, 'unauthenticated');
  });

  it('refuses the TOTP step without the password step cookie', async () => {
    const user = await seedUser();
    const res = await request(app).post('/api/auth/totp').send({ code: freshTotp(user.totpSecret) });
    expectRefusal(res, 401, 'unauthenticated');
    expect(await db.session.count()).toBe(0);
  });

  it('refuses password sign-in for an account with no TOTP enrolled, pointing at bootstrap-admin', async () => {
    const user = await seedUser({ totp: false });
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expectRefusal(res, 401, 'unauthenticated');
    expect((res.body as { error: { fix: string } }).error.fix).toContain('bootstrap-admin');
  });

  it('refuses a disabled account, by password and by D3 Auth', async () => {
    const user = await seedUser({ disabled: true });
    expectRefusal(
      await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }),
      401,
      'unauthenticated',
    );
    await db.identity.create({ data: { userId: user.id, issuer: ISSUER, subject: 'sub-d' } });
    oidc.next = { iss: ISSUER, sub: 'sub-d' };
    expectRefusal(await oidcRoundTrip(request.agent(app)), 401, 'unauthenticated');
    expect(await db.session.count()).toBe(0);
  });

  it('refuses a malformed body', async () => {
    expectRefusal(await request(app).post('/api/auth/login').send({ email: 'x' }), 400, 'invalid_request');
  });
});

describe('sessions', () => {
  it('sets an HttpOnly, SameSite=Lax session cookie and stores only its hash', async () => {
    const user = await seedUser();
    const browser = request.agent(app);
    await browser.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    const res = await browser.post('/api/auth/totp').send({ code: freshTotp(user.totpSecret) });
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '';
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\//);
    const token = decodeURIComponent(session.split(';')[0]?.split('=')[1] ?? '');
    const row = await db.session.findUniqueOrThrow({ where: { tokenHash: hashSessionToken(token) } });
    expect(row.tokenHash).not.toContain(token);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(12 * 60 * 60 * 1000);
  });

  it('logout deletes the session, and the old cookie no longer works', async () => {
    const user = await seedUser();
    const browser = request.agent(app);
    await passwordLogin(browser, user);
    expect(await db.session.count()).toBe(1);
    const out = await browser.post('/api/auth/logout');
    expect(out.status).toBe(200);
    expect(await db.session.count()).toBe(0);
    expectRefusal(await browser.get('/api/auth/me'), 401, 'unauthenticated');
  });

  it('an expired session is refused by requireUser', async () => {
    const user = await seedUser();
    const token = 'expired-token-value';
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(token),
        method: 'password',
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const res = await request(app).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=${token}`);
    expectRefusal(res, 401, 'unauthenticated');
  });
});

describe('audit', () => {
  it('records login success, failure, link and logout with the right actors', async () => {
    const user = await seedUser();
    await request(app).post('/api/auth/login').send({ email: user.email, password: 'nope' });
    const browser = request.agent(app);
    await passwordLogin(browser, user);
    oidc.next = { iss: ISSUER, sub: 'sub-audit' };
    await oidcRoundTrip(browser);
    await browser.post('/api/auth/logout');

    const rows = await db.auditEvent.findMany({ orderBy: { at: 'asc' } });
    const by = (action: string) => rows.filter((r) => r.action === action);

    const failed = by('auth.login.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ actorType: 'system', actorLabel: 'anonymous', actorUserId: null, entityId: user.id });

    const succeeded = by('auth.login.succeeded');
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]).toMatchObject({ actorType: 'user', actorUserId: user.id, actorLabel: user.email, entityType: 'session' });

    const linked = by('auth.identity.linked');
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ actorType: 'user', actorUserId: user.id, entityType: 'identity' });

    const logout = by('auth.logout');
    expect(logout).toHaveLength(1);
    expect(logout[0]).toMatchObject({ actorType: 'user', actorUserId: user.id, entityType: 'session' });

    // No secret ever lands in the trail.
    const all = JSON.stringify(rows);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('nope');
    expect(all).not.toContain(user.totpSecret);
  });

  it('req.audit with no actor throws rather than attributing to anonymous', async () => {
    const res = await request(app).get('/api/_test/audit-without-actor');
    expect(res.body).toMatchObject({ threw: true });
    expect(await db.auditEvent.count({ where: { action: 'test.noactor' } })).toBe(0);
  });
});
