// SHP-T-11.2 and SHP-T-11.3, the D3 App contract's account lifecycle: an invite accepted from the app
// (account, authenticator, native session, the invite spent) and an account deleted from it, through
// the grace period to the purge on a test clock — the user removed, their tokens revoked, the name
// kept for the deploys and approvals that point at it (SHP-ADR-004).
import { randomBytes, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { generateTotpSecret, hashPassword, totpCode } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { DELETION_GRACE_MS, purgeDeletedAccounts, tombstoneEmail } from '../../src/users/deletion.js';
import { hashInviteToken } from '../../src/users/index.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) throw new Error('DATABASE_URL must be set for integration tests');

const PASSWORD = 'correct horse battery staple';
const PROBLEM = 'https://d3cloud.io/problems/';
const DEVICE = { name: "Matt's iPhone", platform: 'ios' };
const HOST = 'shipyard.example.test';
const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, PUBLIC_URL: `https://${HOST}`, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

let app: Express;
// Each sign-in and each deletion spends a step; walk through the window rather than reuse one.
const used = new Map<string, number>();
const code = (secret: string): string => {
  const n = used.get(secret) ?? 0;
  used.set(secret, n + 1);
  return totpCode(secret, Date.now() + ([0, 30_000, -30_000][n % 3] ?? 0));
};
const wrongCode = (secret: string) => String((Number(totpCode(secret, Date.now())) + 3) % 1_000_000).padStart(6, '0');

async function person(role: 'admin' | 'deployer' | 'viewer' = 'deployer') {
  const secret = generateTotpSecret();
  const email = `lifecycle-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, displayName: 'Lifecycle', role, passwordHash: await hashPassword(PASSWORD), totpSecret: secret, totpEnabledAt: new Date() } });
  return { id: user.id, email, secret };
}
async function signIn(who: { email: string; secret: string }): Promise<string> {
  const first = await request(app).post('/api/auth/native/signin').send({ email: who.email, password: PASSWORD, device: DEVICE });
  const second = await request(app).post('/api/auth/native/signin').send({ challenge: (first.body as { challenge: string }).challenge, totp: code(who.secret) });
  expect(second.status).toBe(200);
  return (second.body as { accessToken: string }).accessToken;
}
async function inviteFor(role: 'deployer' | 'viewer' = 'viewer'): Promise<{ token: string; email: string; id: string }> {
  const admin = await person('admin');
  const token = `inv_${randomBytes(32).toString('base64url')}`;
  const email = `invitee-${randomUUID()}@example.com`;
  const row = await db.invite.create({ data: { email, role, tokenHash: hashInviteToken(token), invitedById: admin.id, expiresAt: new Date(Date.now() + 3_600_000) } });
  return { token, email, id: row.id };
}
const deleteAccount = (bearer: string, body: Record<string, unknown>) =>
  request(app).post('/api/auth/native/delete-account').set('Authorization', `Bearer ${bearer}`).send(body);

beforeAll(() => {
  app = createApp({ db, logger, config, oidc: null });
});

afterAll(async () => {
  await db.$disconnect();
});

it('names both endpoints in the manifest', async () => {
  const res = await request(app).get('/.well-known/d3-app.json');
  expect((res.body as { endpoints: Record<string, string> }).endpoints).toMatchObject({
    inviteAccept: `https://${HOST}/api/auth/native/invite`,
    deleteAccount: `https://${HOST}/api/auth/native/delete-account`,
  });
});

describe('accepting an invite from the app (SHP-T-11.2)', () => {
  it('answers an unknown token invite_invalid', async () => {
    const res = await request(app).post('/api/auth/native/invite').send({ token: `inv_${randomBytes(32).toString('base64url')}`, displayName: 'Nobody', password: PASSWORD, device: DEVICE });
    expect(res.status).toBe(410);
    expect((res.body as { type: string }).type).toBe(`${PROBLEM}invite_invalid`);
  });

  it('makes the account, enrols an authenticator, signs in on the device, and the invite is then spent', async () => {
    const invite = await inviteFor('deployer');
    const weak = await request(app).post('/api/auth/native/invite').send({ token: invite.token, displayName: 'Ada', password: 'short', device: DEVICE });
    expect(weak.status).toBe(422);
    expect(weak.body).toMatchObject({ type: `${PROBLEM}weak_password`, detail: 'Use at least 12 characters.' });

    const first = await request(app).post('/api/auth/native/invite').send({ token: invite.token, displayName: 'Ada', password: PASSWORD, device: DEVICE });
    expect(first.status).toBe(200);
    const { challenge, enrolment } = first.body as { challenge: string; enrolment: { secret: string; otpauthUri: string; digits: number; period: number } };
    expect(enrolment).toMatchObject({ digits: 6, period: 30 });
    expect(enrolment.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    // The account exists already; the invite is not spent until a code proves the authenticator.
    expect(await db.user.findFirstOrThrow({ where: { email: invite.email } })).toMatchObject({ displayName: 'Ada', role: 'deployer', totpEnabledAt: null });
    expect((await db.invite.findUniqueOrThrow({ where: { id: invite.id } })).acceptedAt).toBeNull();

    const wrong = await request(app).post('/api/auth/native/invite').send({ challenge, enrolTotp: wrongCode(enrolment.secret) });
    expect(wrong.status).toBe(401);
    expect((wrong.body as { type: string }).type).toBe(`${PROBLEM}invalid_code`);

    const second = await request(app).post('/api/auth/native/invite').send({ challenge, enrolTotp: totpCode(enrolment.secret, Date.now()) });
    expect(second.status).toBe(200);
    const tokens = second.body as { accessToken: string; session: { id: string } };
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokens.accessToken}`)).status).toBe(200);
    expect(await db.session.findUniqueOrThrow({ where: { id: tokens.session.id } })).toMatchObject({ native: true, deviceName: DEVICE.name });
    expect((await db.invite.findUniqueOrThrow({ where: { id: invite.id } })).acceptedAt).not.toBeNull();

    const again = await request(app).post('/api/auth/native/invite').send({ token: invite.token, displayName: 'Again', password: PASSWORD, device: DEVICE });
    expect(again.status).toBe(410);
  });
});

describe('deleting an account from the app (SHP-T-11.3)', () => {
  it('refuses a wrong code, a mismatched confirmation, an API token and anybody not signed in', async () => {
    const who = await person();
    const bearer = await signIn(who);
    const wrong = await deleteAccount(bearer, { confirmation: HOST, totp: wrongCode(who.secret) });
    expect(wrong.status).toBe(401);
    expect((wrong.body as { type: string }).type).toBe(`${PROBLEM}invalid_code`);
    const mismatch = await deleteAccount(bearer, { confirmation: 'example.com', totp: code(who.secret) });
    expect(mismatch.status).toBe(422);
    expect((mismatch.body as { detail: string }).detail).toContain(HOST);
    expect((await request(app).post('/api/auth/native/delete-account').send({ confirmation: HOST, totp: '000000' })).status).toBe(401);
    expect((await db.user.findUniqueOrThrow({ where: { id: who.id } })).disabledAt).toBeNull();
  });

  it('refuses the last admin, and lets an admin go once there is another', async () => {
    // Every other admin out of the way for a moment, so "the last" is this one; restored after.
    const others = await db.user.findMany({ where: { role: 'admin', disabledAt: null }, select: { id: true } });
    await db.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { disabledAt: new Date() } });
    try {
      const admin = await person('admin');
      const bearer = await signIn(admin);
      const last = await deleteAccount(bearer, { confirmation: HOST, totp: code(admin.secret) });
      expect(last.status).toBe(409);
      expect((last.body as { type: string }).type).toBe(`${PROBLEM}last_owner`);
      // With the first still an admin, a second one may go.
      const second = await person('admin');
      const secondBearer = await signIn(second);
      expect((await deleteAccount(secondBearer, { confirmation: HOST, totp: code(second.secret) })).status).toBe(202);
    } finally {
      await db.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { disabledAt: null } });
    }
  });

  it('schedules it a day or more out, ends every session and token at once, and purges it after the grace period', async () => {
    const who = await person();
    const bearer = await signIn(who);
    const token = await db.apiToken.create({ data: { userId: who.id, label: 'lifecycle', tokenHash: `lifecycle-${randomUUID()}`, prefix: 'shp_x' } });
    const res = await deleteAccount(bearer, { confirmation: HOST.toUpperCase(), totp: code(who.secret) });
    expect(res.status).toBe(202);
    const { graceUntil } = res.body as { graceUntil: string };
    expect(Date.parse(graceUntil)).toBeGreaterThanOrEqual(Date.now() + 24 * 3_600_000 - 60_000);
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${bearer}`)).status).toBe(401);
    expect(await db.session.count({ where: { userId: who.id } })).toBe(0);
    expect((await db.apiToken.findUniqueOrThrow({ where: { id: token.id } })).revokedAt).not.toBeNull();
    expect((await request(app).post('/api/auth/native/signin').send({ email: who.email, password: PASSWORD })).status).toBe(401);

    await purgeDeletedAccounts({ db, logger }, new Date(Date.now() + DELETION_GRACE_MS - 60_000));
    expect((await db.user.findUniqueOrThrow({ where: { id: who.id } })).email).toBe(who.email);

    await purgeDeletedAccounts({ db, logger }, new Date(Date.now() + DELETION_GRACE_MS + 60_000));
    const after = await db.user.findUniqueOrThrow({ where: { id: who.id } });
    expect(after).toMatchObject({ email: tombstoneEmail(who.id), passwordHash: null, totpSecret: null, displayName: 'Lifecycle' });
    expect(after.deletedAt).not.toBeNull();
    expect(await db.auditEvent.count({ where: { entityId: who.id, action: 'user.purged' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { entityId: who.id, action: 'user.deletion_requested' } })).toBe(1);
  });

  it('is cancelled when an admin re-enables the account inside the grace period', async () => {
    const who = await person();
    const bearer = await signIn(who);
    expect((await deleteAccount(bearer, { confirmation: HOST, totp: code(who.secret) })).status).toBe(202);
    await db.user.update({ where: { id: who.id }, data: { disabledAt: null, deleteAfter: null } });
    await purgeDeletedAccounts({ db, logger }, new Date(Date.now() + DELETION_GRACE_MS + 60_000));
    expect(await db.user.findUniqueOrThrow({ where: { id: who.id } })).toMatchObject({ email: who.email, deletedAt: null });
  });
});
