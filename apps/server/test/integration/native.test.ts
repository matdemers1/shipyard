// SHP-P-10, the D3 App contract: the manifest; native sessions in JSON — password, then the code —
// reached with a Bearer token only; refresh rotation where a rotated token presented again ends the
// session; the sessions list naming the phone and revoking it; approve, deny and rollback behind a
// step-up from the last ten minutes; D3 Auth tokens verified for this audience and mapped by
// (iss, sub); and every refusal a native client sees as problem+json.
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setKeysForTesting } from '../../src/auth/d3auth-bearer.js';
import { generateTotpSecret, hashPassword, totpCode, type OidcClient } from '../../src/auth/index.js';
import { generateToken } from '../../src/tokens/tokens.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) throw new Error('DATABASE_URL must be set for integration tests');

const ORIGIN = 'http://127.0.0.1:4100';
const ISSUER = 'https://auth.example.test';
const PASSWORD = 'correct horse battery staple';
const DEVICE = { name: "Matt's iPhone", platform: 'ios' };
const PROBLEM = 'https://d3cloud.io/problems/';

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, PUBLIC_URL: ORIGIN, SESSION_SECRET: 'test-session-secret' });
const oidc: OidcClient = {
  issuer: ISSUER,
  beginSignIn: () => Promise.reject(new Error('unused')),
  completeSignIn: () => Promise.reject(new Error('unused')),
};

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let app: Express;
let key: SigningKey;
let user: { id: string; email: string; secret: string };
const usedSteps = new Map<string, number>();
const code = (secret: string): string => {
  // A step not used yet: the replay guard refuses a second use of one step's code.
  const n = usedSteps.get(secret) ?? 0;
  usedSteps.set(secret, n + 1);
  return totpCode(secret, Date.now() + ([0, 30_000, -30_000][n % 3] ?? 0));
};

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  session: { id: string };
}

const problemOf = (res: request.Response): Record<string, unknown> => {
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = JSON.parse(res.text) as Record<string, unknown>;
  expect(body['status']).toBe(res.status);
  return body;
};
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function signIn(who: { email: string; secret: string } = user): Promise<Tokens> {
  const first = await request(app).post('/api/auth/native/signin').send({ email: who.email, password: PASSWORD, device: DEVICE });
  expect(first.status).toBe(202);
  const second = await request(app).post('/api/auth/native/signin').send({ challenge: (first.body as { challenge: string }).challenge, totp: code(who.secret) });
  expect(second.status).toBe(200);
  return second.body as Tokens;
}

async function seedUser(role: 'admin' | 'viewer' = 'admin') {
  const secret = generateTotpSecret();
  const email = `native-${randomUUID()}@example.com`;
  const row = await db.user.create({
    data: { email, displayName: 'Native', role, passwordHash: await hashPassword(PASSWORD), totpSecret: secret, totpEnabledAt: new Date() },
  });
  return { id: row.id, email, secret };
}

beforeAll(async () => {
  app = createApp({ db, logger: pino({ enabled: false }), config, oidc });
  user = await seedUser();
  const pair = await generateKeyPair('ES256');
  key = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  setKeysForTesting(() => keys);
});

afterAll(async () => {
  setKeysForTesting(null);
  await db.$disconnect();
});

describe('the manifest (SHP-T-10.1)', () => {
  it('names the native endpoints on this origin and offers D3 Auth while it is configured', async () => {
    const res = await request(app).get('/.well-known/d3-app.json');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      product: 'shipyard',
      contract: 1,
      signIn: { methods: ['password', 'totp', 'd3auth'], d3auth: { issuer: ISSUER, resource: ORIGIN } },
      endpoints: {
        nativeSignIn: `${ORIGIN}/api/auth/native/signin`,
        nativeRefresh: `${ORIGIN}/api/auth/native/refresh`,
        nativeRevoke: `${ORIGIN}/api/auth/native/revoke`,
        me: `${ORIGIN}/api/auth/me`,
        link: `${ORIGIN}/api/auth/native/link`,
      },
    });
  });
});

describe('native sessions (SHP-T-10.2)', () => {
  it('password then code gives a named session that the API, and only a Bearer token, opens', async () => {
    const tokens = await signIn();
    expect(tokens.expiresIn).toBeLessThanOrEqual(900);
    const me = await request(app).get('/api/auth/me').set(bearer(tokens.accessToken));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ accountId: user.id, email: user.email, roles: ['admin'] });
    expect((await request(app).get('/api/deploys').set(bearer(tokens.accessToken))).status).toBe(200);
    // As a cookie it is nothing: the two kinds never cross.
    expect((await request(app).get('/api/auth/me').set('Cookie', `shipyard_session=${tokens.accessToken}`)).status).toBe(401);
    const row = await db.session.findUniqueOrThrow({ where: { id: tokens.session.id } });
    expect(row).toMatchObject({ native: true, deviceName: DEVICE.name, devicePlatform: 'ios' });
  });

  it('refusals are registered problems', async () => {
    const wrong = await request(app).post('/api/auth/native/signin').send({ email: user.email, password: 'nope' });
    expect(problemOf(wrong)['type']).toBe(`${PROBLEM}invalid_credentials`);
    const first = await request(app).post('/api/auth/native/signin').send({ email: user.email, password: PASSWORD });
    const right = code(user.secret);
    const bad = String((Number(right) + 1) % 1_000_000).padStart(6, '0');
    const second = await request(app).post('/api/auth/native/signin').send({ challenge: (first.body as { challenge: string }).challenge, totp: bad });
    expect(problemOf(second)['type']).toBe(`${PROBLEM}invalid_code`);
    const unauthenticated = await request(app).get('/api/auth/me').set('Accept', 'application/json, application/problem+json');
    expect(problemOf(unauthenticated)['type']).toBe(`${PROBLEM}session_revoked`);
    const unknown = await request(app).get('/api/auth/me').set(bearer('not-a-session'));
    expect(problemOf(unknown)['type']).toBe(`${PROBLEM}session_revoked`);
  });

  it('refresh rotates; a rotated token presented again ends the session', async () => {
    const tokens = await signIn(await seedUser());
    const rotated = await request(app).post('/api/auth/native/refresh').send({ refreshToken: tokens.refreshToken });
    expect(rotated.status).toBe(200);
    const next = rotated.body as Tokens;
    expect((await request(app).get('/api/auth/me').set(bearer(tokens.accessToken))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(bearer(next.accessToken))).status).toBe(200);
    const replay = await request(app).post('/api/auth/native/refresh').send({ refreshToken: tokens.refreshToken });
    expect(problemOf(replay)['type']).toBe(`${PROBLEM}refresh_reused`);
    const after = await request(app).post('/api/auth/native/refresh').send({ refreshToken: next.refreshToken });
    expect(problemOf(after)['type']).toBe(`${PROBLEM}session_revoked`);
  });

  it('revoke ends the session and its refresh token', async () => {
    const tokens = await signIn(await seedUser());
    expect((await request(app).post('/api/auth/native/revoke').set(bearer(tokens.accessToken))).status).toBe(204);
    const again = await request(app).post('/api/auth/native/refresh').send({ refreshToken: tokens.refreshToken });
    expect(problemOf(again)['type']).toBe(`${PROBLEM}session_revoked`);
  });
});

describe('the sessions list (SHP-T-10.4)', () => {
  it('names the phone, and revoking it signs the app out at its next refresh', async () => {
    const me = await seedUser();
    const phone = await signIn(me);
    const other = await signIn(me);
    const listed = await request(app).get('/api/auth/sessions').set(bearer(other.accessToken));
    expect(listed.status).toBe(200);
    const rows = listed.body as { id: string; deviceName: string | null; native: boolean; current: boolean }[];
    expect(rows.find((r) => r.id === phone.session.id)).toMatchObject({ deviceName: DEVICE.name, native: true, current: false });
    expect(rows.find((r) => r.id === other.session.id)?.current).toBe(true);

    const revoked = await request(app).post(`/api/auth/sessions/${phone.session.id}/revoke`).set(bearer(other.accessToken));
    expect(revoked.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(bearer(phone.accessToken))).status).toBe(401);
    const refresh = await request(app).post('/api/auth/native/refresh').send({ refreshToken: phone.refreshToken });
    expect(problemOf(refresh)['type']).toBe(`${PROBLEM}session_revoked`);
  });

  it('another person’s session cannot be revoked', async () => {
    const someoneElse = await seedUser();
    const theirs = await signIn(someoneElse);
    const mine = await signIn(await seedUser());
    const res = await request(app).post(`/api/auth/sessions/${theirs.session.id}/revoke`).set(bearer(mine.accessToken));
    expect(res.status).toBe(404);
    expect((await request(app).get('/api/auth/me').set(bearer(theirs.accessToken))).status).toBe(200);
  });
});

describe('approve, deny and rollback behind a fresh step-up (SHP-T-10.3)', () => {
  it('a native session must step up first; then it reaches the approval itself', async () => {
    const who = await seedUser();
    const tokens = await signIn(who);
    const deployId = randomUUID();
    for (const path of [`/api/deploys/${deployId}/approve`, `/api/deploys/${deployId}/deny`]) {
      const stale = await request(app).post(path).set(bearer(tokens.accessToken)).send({});
      expect(problemOf(stale)).toMatchObject({ type: `${PROBLEM}step_up_required`, status: 403, maxAgeSeconds: 600 });
    }
    const rollback = await request(app)
      .post('/api/deploys')
      .set(bearer(tokens.accessToken))
      .send({ kind: 'rollback', app: 'web', toDeployId: randomUUID() });
    expect(problemOf(rollback)['type']).toBe(`${PROBLEM}step_up_required`);

    const wrong = await request(app).post('/api/auth/step-up').set(bearer(tokens.accessToken)).send({ code: '000000' });
    expect(wrong.status).toBe(401);
    const stepped = await request(app).post('/api/auth/step-up').set(bearer(tokens.accessToken)).send({ code: code(who.secret) });
    expect(stepped.status).toBe(200);
    expect((stepped.body as { ok: boolean }).ok).toBe(true);

    // Past the gate: the deploy does not exist, which is the service's answer, not the gate's.
    const approve = await request(app).post(`/api/deploys/${deployId}/approve`).set(bearer(tokens.accessToken)).send({});
    expect(problemOf(approve)['code']).toBe('not_found');
  });

  it('a step-up older than ten minutes no longer counts', async () => {
    const tokens = await signIn(await seedUser());
    await db.session.update({ where: { id: tokens.session.id }, data: { stepUpAt: new Date(Date.now() - 11 * 60 * 1000) } });
    const res = await request(app).post(`/api/deploys/${randomUUID()}/approve`).set(bearer(tokens.accessToken)).send({});
    expect(problemOf(res)['type']).toBe(`${PROBLEM}step_up_required`);
  });

  it('an shp_ API token still cannot approve, and keeps its own error envelope', async () => {
    const { token, hash, prefix } = generateToken();
    await db.apiToken.create({ data: { userId: user.id, label: 'ci', tokenHash: hash, prefix } });
    // Never asked to step up — a token has no session to step up — and still the envelope, not a
    // problem. That a token cannot approve a real pending deploy is approvals.test.ts's to prove.
    const res = await request(app).post(`/api/deploys/${randomUUID()}/approve`).set(bearer(token)).send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect((res.body as { error: { code: string } }).error.code).not.toBe('step_up_required');
  });
});

describe('D3 Auth tokens (SHP-T-10.2)', () => {
  const jwt = (opts: { sub?: string; aud?: string } = {}) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setSubject(opts.sub ?? 'd3-person-1')
      .setAudience(opts.aud ?? ORIGIN)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key);

  it('unlinked is identity_not_linked; link proves the account once; then the token opens the API', async () => {
    const user = await seedUser();
    const token = await jwt();
    const unlinked = await request(app).get('/api/auth/me').set(bearer(token));
    expect(problemOf(unlinked)['type']).toBe(`${PROBLEM}identity_not_linked`);

    const wrongCode = await request(app).post('/api/auth/native/link').set(bearer(token)).send({ email: user.email, password: PASSWORD, totp: '000000' });
    expect(problemOf(wrongCode)['type']).toBe(`${PROBLEM}invalid_code`);
    const linked = await request(app).post('/api/auth/native/link').set(bearer(token)).send({ email: user.email, password: PASSWORD, totp: code(user.secret) });
    expect(linked.status).toBe(200);
    expect(linked.body).toEqual({ linked: true, accountId: user.id });

    const me = await request(app).get('/api/auth/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect((me.body as { accountId: string }).accountId).toBe(user.id);
    // Governed by D3 Auth: never listed among the sessions Shipyard issued.
    const listed = (await request(app).get('/api/auth/sessions').set(bearer(token))).body as { native: boolean; deviceName: string | null }[];
    expect(listed.every((row) => row.deviceName !== null || !row.native)).toBe(true);
  });

  it('a token for another audience is refused, never identity_not_linked', async () => {
    const res = await request(app).get('/api/auth/me').set(bearer(await jwt({ aud: 'https://bindery.example.test' })));
    expect(problemOf(res)['type']).toBe(`${PROBLEM}session_revoked`);
  });
});
