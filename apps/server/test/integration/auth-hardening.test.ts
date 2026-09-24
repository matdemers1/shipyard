import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { auditContext } from '../../src/audit.js';
import {
  MFA_COOKIE,
  authRouter,
  authenticate,
  generateTotpSecret,
  hashPassword,
  totpCode,
  type AuthDeps,
} from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { errorHandler } from '../../src/errors.js';

// SHP-REQ-107 (single-use MFA ticket) and SHP-REQ-108 (failed-attempt throttling).

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
const logger = pino({ enabled: false });
const PASSWORD = 'correct horse battery staple';
const MIN = 60 * 1000;

interface Seeded {
  id: string;
  email: string;
  totpSecret: string;
}

async function seedUser(): Promise<Seeded> {
  const totpSecret = generateTotpSecret();
  const email = `op-${randomUUID()}@example.com`;
  const user = await db.user.create({
    data: {
      email,
      displayName: 'Operator',
      role: 'admin',
      passwordHash: await hashPassword(PASSWORD),
      totpSecret,
      totpEnabledAt: new Date(),
    },
  });
  return { id: user.id, email, totpSecret };
}

function expectRefusal(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  const body = res.body as { error: Record<string, unknown> };
  expect(Object.keys(body.error).sort()).toEqual(['code', 'fix', 'gate', 'message']);
  expect(body.error['code']).toBe(code);
}

function mfaCookieFrom(res: request.Response): string {
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const mfa = cookies.find((c) => c.startsWith(`${MFA_COOKIE}=`));
  if (mfa === undefined) throw new Error('no mfa cookie set');
  return mfa.split(';')[0] ?? '';
}

/**
 * The auth router exactly as `createApp` mounts it, but with small throttle limits and a fake
 * clock. `trust proxy` is set to loopback here, in the test app only, so a test can present
 * distinct source addresses through X-Forwarded-For; the router itself reads `req.ip`, as it does
 * in production.
 */
function throttledApp(clock: { now: number }): Express {
  const deps: AuthDeps = {
    db,
    logger,
    config,
    oidc: null,
    throttle: {
      account: { maxFailures: 3, windowMs: 10 * MIN, coolOffMs: 15 * MIN },
      ip: { maxFailures: 5, windowMs: 10 * MIN, coolOffMs: 15 * MIN },
      now: () => clock.now,
    },
  };
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use(auditContext(db, logger));
  app.use(authenticate(deps));
  app.use('/api/auth', authRouter(deps));
  app.use(errorHandler(logger));
  return app;
}

beforeEach(async () => {
  await db.$executeRawUnsafe('truncate table "audit_event" cascade');
  await db.$executeRawUnsafe('truncate table "user" cascade');
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the MFA ticket is single-use (SHP-REQ-107)', () => {
  it('refuses a replayed shipyard_mfa cookie after a successful sign-in, and makes no second session', async () => {
    const app = createApp({ db, logger, config, oidc: null });
    const user = await seedUser();

    const step1 = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(step1.status).toBe(200);
    const captured = mfaCookieFrom(step1);

    const now = Date.now();
    const step2 = await request(app).post('/api/auth/totp').set('Cookie', captured).send({ code: totpCode(user.totpSecret, now) });
    expect(step2.status).toBe(200);
    // The ticket cookie is cleared on success.
    const cleared = (step2.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(`${MFA_COOKIE}=`));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);

    // The replay: the same cookie, with the next step's (valid, unspent) code.
    const replay = await request(app)
      .post('/api/auth/totp')
      .set('Cookie', captured)
      .send({ code: totpCode(user.totpSecret, now + 30_000) });
    expectRefusal(replay, 401, 'unauthenticated');
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it('a second /login for the same user supersedes the first ticket', async () => {
    const app = createApp({ db, logger, config, oidc: null });
    const user = await seedUser();
    const first = mfaCookieFrom(await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }));
    const second = mfaCookieFrom(await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }));

    const code = totpCode(user.totpSecret);
    expectRefusal(await request(app).post('/api/auth/totp').set('Cookie', first).send({ code }), 401, 'unauthenticated');
    expect(await db.session.count()).toBe(0);

    const ok = await request(app).post('/api/auth/totp').set('Cookie', second).send({ code });
    expect(ok.status).toBe(200);
    expect(await db.session.count()).toBe(1);
  });
});

describe('failed sign-in attempts are throttled (SHP-REQ-108)', () => {
  it('with the production defaults, five wrong passwords pause the account', async () => {
    const app = createApp({ db, logger, config, oidc: null });
    const user = await seedUser();
    for (let i = 0; i < 5; i += 1) {
      expectRefusal(await request(app).post('/api/auth/login').send({ email: user.email, password: 'nope' }), 401, 'unauthenticated');
    }
    expectRefusal(await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }), 429, 'too_many_attempts');
  });

  it('refuses even the correct password for a throttled account until the cool-off ends', async () => {
    const clock = { now: Date.now() };
    const app = throttledApp(clock);
    const user = await seedUser();

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/api/auth/login').send({ email: user.email, password: `wrong-${i}` });
      expectRefusal(res, 401, 'unauthenticated');
    }
    // Case-insensitive: the account key is the lowercased email.
    const throttled = await request(app).post('/api/auth/login').send({ email: user.email.toUpperCase(), password: PASSWORD });
    expectRefusal(throttled, 429, 'too_many_attempts');
    expect(throttled.headers['set-cookie']).toBeUndefined();

    clock.now += 14 * MIN;
    expectRefusal(await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }), 429, 'too_many_attempts');

    clock.now += 2 * MIN;
    const ok = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ next: 'totp' });

    // The throttled refusal is audited with an anonymous actor and no plain-text email.
    const rows = await db.auditEvent.findMany({ where: { action: 'auth.login.throttled' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actorType: 'system', actorLabel: 'anonymous' });
    expect(JSON.stringify(rows)).not.toContain(user.email);
    expect(JSON.stringify(rows).toLowerCase()).not.toContain(user.email.toLowerCase());
  });

  it('refuses TOTP attempts once wrong codes pass the threshold, even with a fresh ticket', async () => {
    const clock = { now: Date.now() };
    const app = throttledApp(clock);
    const user = await seedUser();
    const agent = request.agent(app);

    await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    const wrong = totpCode(user.totpSecret, Date.now() + 10 * MIN);
    for (let i = 0; i < 3; i += 1) {
      expectRefusal(await agent.post('/api/auth/totp').send({ code: wrong }), 401, 'unauthenticated');
    }
    // The next TOTP attempt is refused with the throttle, even with the right code.
    expectRefusal(await agent.post('/api/auth/totp').send({ code: totpCode(user.totpSecret) }), 429, 'too_many_attempts');
    // And a fresh /login cannot farm a new budget: the account is paused.
    expectRefusal(await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD }), 429, 'too_many_attempts');
    expect(await db.session.count()).toBe(0);

    clock.now += 16 * MIN;
    await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    const ok = await agent.post('/api/auth/totp').send({ code: totpCode(user.totpSecret) });
    expect(ok.status).toBe(200);
    expect(await db.session.count()).toBe(1);
  });

  it('throttles one source address across many emails, and leaves other addresses alone', async () => {
    const clock = { now: Date.now() };
    const app = throttledApp(clock);
    const user = await seedUser();
    const attacker = '203.0.113.7';

    // Five failures from one address, each against a different (mostly unknown) email.
    const emails = [user.email, 'a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'];
    for (const email of emails) {
      const res = await request(app).post('/api/auth/login').set('X-Forwarded-For', attacker).send({ email, password: 'nope' });
      expectRefusal(res, 401, 'unauthenticated');
    }

    const fresh = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', attacker)
      .send({ email: 'fresh@example.com', password: 'nope' });
    expectRefusal(fresh, 429, 'too_many_attempts');
    // The TOTP step is paused for that address too.
    expectRefusal(await request(app).post('/api/auth/totp').set('X-Forwarded-For', attacker).send({ code: '000000' }), 429, 'too_many_attempts');

    // Another address signs in to the (unthrottled) account normally.
    const other = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.9')
      .send({ email: user.email, password: PASSWORD });
    expect(other.status).toBe(200);
  });

  it('gives an identical refusal for a known and an unknown email under throttle', async () => {
    const clock = { now: Date.now() };
    const app = throttledApp(clock);
    const user = await seedUser();
    const unknown = 'nobody@example.com';
    for (const email of [user.email, unknown]) {
      for (let i = 0; i < 3; i += 1) {
        await request(app).post('/api/auth/login').set('X-Forwarded-For', `192.0.2.${i + (email === unknown ? 10 : 1)}`).send({ email, password: 'nope' });
      }
    }
    const known = await request(app).post('/api/auth/login').set('X-Forwarded-For', '192.0.2.50').send({ email: user.email, password: PASSWORD });
    const stranger = await request(app).post('/api/auth/login').set('X-Forwarded-For', '192.0.2.51').send({ email: unknown, password: PASSWORD });
    expectRefusal(known, 429, 'too_many_attempts');
    expectRefusal(stranger, 429, 'too_many_attempts');
    expect(known.body).toEqual(stranger.body);
  });

  it('a completed sign-in resets the account counter', async () => {
    const clock = { now: Date.now() };
    const app = throttledApp(clock);
    const user = await seedUser();
    for (let i = 0; i < 2; i += 1) {
      await request(app).post('/api/auth/login').set('X-Forwarded-For', '192.0.2.1').send({ email: user.email, password: 'nope' });
    }
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('X-Forwarded-For', '192.0.2.2').send({ email: user.email, password: PASSWORD });
    expect((await agent.post('/api/auth/totp').set('X-Forwarded-For', '192.0.2.2').send({ code: totpCode(user.totpSecret) })).status).toBe(200);
    // Two more failures would have tripped it (2 + 2 > 3) had the counter not reset.
    for (let i = 0; i < 2; i += 1) {
      expectRefusal(
        await request(app).post('/api/auth/login').set('X-Forwarded-For', '192.0.2.3').send({ email: user.email, password: 'nope' }),
        401,
        'unauthenticated',
      );
    }
    const res = await request(app).post('/api/auth/login').set('X-Forwarded-For', '192.0.2.3').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(200);
  });
});
