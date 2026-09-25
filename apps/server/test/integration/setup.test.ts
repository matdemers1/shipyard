import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { generateTotpSecret, hashPassword, totpCode, verifyPassword } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { BOOTSTRAP_LOCK_KEY } from '../../src/cli/bootstrap-admin.js';
import { SETUP_TICKET_TTL_MS } from '../../src/setup/index.js';

/**
 * First-run setup in the console (SHP-REQ-109, SHP-T-6.7): open only while no account exists, and
 * the zero-users check is atomic with the insert, so two concurrent claims yield one account.
 */

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

const PASSWORD = 'correct horse battery staple';
let clock = Date.now();
let app: Express;

function buildApp(): Express {
  return createApp({ db, logger: pino({ enabled: false }), config, setup: { now: () => clock } });
}

interface Started {
  ticket: string;
  otpauthUri: string;
  secret: string;
  expiresAt: string;
}

async function start(agent: ReturnType<typeof request.agent>, email = 'admin@example.com'): Promise<Started> {
  const res = await agent
    .post('/api/setup/start')
    .send({ email, displayName: 'The Admin', password: PASSWORD });
  expect(res.status, res.text).toBe(200);
  return res.body as Started;
}

function expectRefusal(res: request.Response, status: number, code: string): void {
  expect(res.status, res.text).toBe(status);
  const body = res.body as { error?: Record<string, unknown> };
  expect(Object.keys(body.error ?? {}).sort()).toEqual(['code', 'fix', 'gate', 'message']);
  expect(body.error?.['code']).toBe(code);
}

/** A code for `secret` that is certainly wrong now. */
function wrongCode(secret: string): string {
  const right = totpCode(secret, clock);
  const near = new Set([right, totpCode(secret, clock - 30_000), totpCode(secret, clock + 30_000)]);
  for (let n = 0; n < 1_000_000; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!near.has(candidate)) return candidate;
  }
  throw new Error('unreachable');
}

async function seedUser(): Promise<void> {
  await db.user.create({
    data: {
      email: 'existing@example.com',
      displayName: 'Existing',
      role: 'admin',
      passwordHash: await hashPassword(PASSWORD),
      totpSecret: generateTotpSecret(),
      totpEnabledAt: new Date(),
    },
  });
}

beforeEach(async () => {
  await db.$executeRawUnsafe('truncate table "audit_event" cascade');
  await db.$executeRawUnsafe('truncate table "user" cascade');
  clock = Date.now();
  app = buildApp();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/setup', () => {
  it('is available with zero users, unauthenticated and uncached', async () => {
    const res = await request(app).get('/api/setup');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is unavailable once any user exists', async () => {
    await seedUser();
    const res = await request(app).get('/api/setup');
    expect(res.body).toEqual({ available: false });
  });
});

describe('POST /api/setup/start', () => {
  it('returns an authenticator to enrol and writes no user', async () => {
    const started = await start(request.agent(app));
    expect(started.ticket).toMatch(/^stp_/);
    expect(started.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
    expect(started.otpauthUri).toContain(`secret=${started.secret}`);
    expect(started).not.toHaveProperty('passwordHash');
    expect(await db.user.count()).toBe(0);
  });

  it('refuses with conflict once a user exists', async () => {
    await seedUser();
    const res = await request(app)
      .post('/api/setup/start')
      .send({ email: 'intruder@example.com', displayName: 'Intruder', password: PASSWORD });
    expectRefusal(res, 409, 'conflict');
    expect((res.body as { error: { message: string } }).error.message).toBe('Shipyard already has an account; sign in.');
    expect(await db.user.count()).toBe(1);
  });

  it('refuses a password shorter than 12 characters', async () => {
    const res = await request(app)
      .post('/api/setup/start')
      .send({ email: 'admin@example.com', displayName: 'The Admin', password: 'short' });
    expectRefusal(res, 400, 'invalid_request');
  });
});

describe('POST /api/setup/complete', () => {
  it('creates exactly one admin with TOTP enrolled, audits it, and signs them in', async () => {
    const agent = request.agent(app);
    const started = await start(agent, 'Admin@Example.com');
    const code = totpCode(started.secret, clock);
    const res = await agent.post('/api/setup/complete').send({ ticket: started.ticket, code });
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ email: 'admin@example.com', displayName: 'The Admin', role: 'admin' });
    expect(String(res.headers['set-cookie'])).toContain('shipyard_session=');

    const users = await db.user.findMany();
    expect(users).toHaveLength(1);
    const user = users[0];
    expect(user?.role).toBe('admin');
    expect(user?.totpSecret).toBe(started.secret);
    expect(user?.totpEnabledAt).not.toBeNull();
    expect(await verifyPassword(user?.passwordHash ?? '', PASSWORD)).toBe(true);

    // The session cookie is a real one.
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: 'admin@example.com', role: 'admin' });

    // Audited, with the new user as the actor, and nothing secret anywhere in the trail.
    const completed = await db.auditEvent.findFirst({ where: { action: 'auth.setup.completed' } });
    expect(completed?.actorType).toBe('user');
    expect(completed?.actorUserId).toBe(user?.id);
    expect(completed?.entityId).toBe(user?.id);
    const trail = JSON.stringify(await db.auditEvent.findMany());
    expect(trail).not.toContain(started.secret);
    expect(trail).not.toContain(PASSWORD);
    expect(trail).not.toContain(user?.passwordHash ?? 'x');
    expect(trail).not.toContain(started.ticket);
    expect(trail).not.toContain(`"${code}"`);

    // Setup is closed now, and the ticket is spent.
    expect((await agent.get('/api/setup')).body).toEqual({ available: false });
    const again = await agent.post('/api/setup/complete').send({ ticket: started.ticket, code });
    expectRefusal(again, 409, 'conflict');
  });

  it('refuses a wrong code and creates no user', async () => {
    const agent = request.agent(app);
    const started = await start(agent);
    const res = await agent.post('/api/setup/complete').send({ ticket: started.ticket, code: wrongCode(started.secret) });
    expectRefusal(res, 401, 'unauthenticated');
    expect(await db.user.count()).toBe(0);
    const failed = await db.auditEvent.findFirst({ where: { action: 'auth.setup.failed' } });
    expect(failed?.after).toMatchObject({ reason: 'bad_totp' });

    // The ticket survives one wrong code; the right code still finishes.
    const ok = await agent
      .post('/api/setup/complete')
      .send({ ticket: started.ticket, code: totpCode(started.secret, clock) });
    expect(ok.status).toBe(201);
  });

  it('drops a ticket after five wrong codes', async () => {
    const agent = request.agent(app);
    const started = await start(agent);
    for (let i = 0; i < 5; i += 1) {
      const res = await agent.post('/api/setup/complete').send({ ticket: started.ticket, code: wrongCode(started.secret) });
      expectRefusal(res, 401, 'unauthenticated');
    }
    const res = await agent
      .post('/api/setup/complete')
      .send({ ticket: started.ticket, code: totpCode(started.secret, clock) });
    expectRefusal(res, 400, 'invalid_request');
    expect(await db.user.count()).toBe(0);
  });

  it('refuses a forged ticket and an expired one', async () => {
    const agent = request.agent(app);
    const started = await start(agent);
    const code = totpCode(started.secret, clock);

    const forged = `stp_${'A'.repeat(43)}`;
    expectRefusal(await agent.post('/api/setup/complete').send({ ticket: forged, code }), 400, 'invalid_request');
    const tampered = `${started.ticket.slice(0, -1)}${started.ticket.endsWith('A') ? 'B' : 'A'}`;
    expectRefusal(await agent.post('/api/setup/complete').send({ ticket: tampered, code }), 400, 'invalid_request');

    clock += SETUP_TICKET_TTL_MS + 1;
    const late = await agent
      .post('/api/setup/complete')
      .send({ ticket: started.ticket, code: totpCode(started.secret, clock) });
    expectRefusal(late, 400, 'invalid_request');
    expect(await db.user.count()).toBe(0);
  });

  it('lets exactly one of two concurrent claims win; the other is refused with conflict', async () => {
    const a = await start(request.agent(app), 'race-a@example.com');
    const b = await start(request.agent(app), 'race-b@example.com');
    const [ra, rb] = await Promise.all([
      request(app).post('/api/setup/complete').send({ ticket: a.ticket, code: totpCode(a.secret, clock) }),
      request(app).post('/api/setup/complete').send({ ticket: b.ticket, code: totpCode(b.secret, clock) }),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expectRefusal(loser, 409, 'conflict');
    expect(await db.user.count()).toBe(1);
  });

  it('refuses a claim once a user was created after its start', async () => {
    const started = await start(request.agent(app));
    await seedUser();
    const res = await request(app)
      .post('/api/setup/complete')
      .send({ ticket: started.ticket, code: totpCode(started.secret, clock) });
    expectRefusal(res, 409, 'conflict');
    expect(await db.user.count()).toBe(1);
  });
  it('re-counts users inside the locked transaction: a user committed while a claim waits wins', async () => {
    const started = await start(request.agent(app));
    const passwordHash = await hashPassword(PASSWORD);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    // Another claimant (bootstrap-admin, say) holds the lock and is about to insert.
    const holder = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`;
        signalLocked();
        await gate;
        await tx.user.create({
          data: { email: 'cli@example.com', displayName: 'CLI', role: 'admin', passwordHash, totpEnabledAt: new Date() },
        });
      },
      { timeout: 20_000 },
    );
    await locked;
    // The claim passes the early check (zero users) and then blocks on the lock.
    const claim = request(app)
      .post('/api/setup/complete')
      .send({ ticket: started.ticket, code: totpCode(started.secret, clock) })
      .then((r) => r);
    for (let i = 0; i < 200; i += 1) {
      const rows = await db.$queryRaw<{ n: bigint }[]>`select count(*) as n from pg_locks where locktype = 'advisory' and not granted`;
      if (Number(rows[0]?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await holder;
    const res = await claim;
    expectRefusal(res, 409, 'conflict');
    const users = await db.user.findMany();
    expect(users.map((u) => u.email)).toEqual(['cli@example.com']);
  });
});

describe('throttling', () => {
  it('pauses an address after too many starts', async () => {
    app = createApp({
      db,
      logger: pino({ enabled: false }),
      config,
      setup: { now: () => clock, limits: { maxFailures: 2, windowMs: 60_000, coolOffMs: 60_000 } },
    });
    await start(request.agent(app));
    await start(request.agent(app));
    const res = await request(app)
      .post('/api/setup/start')
      .send({ email: 'admin@example.com', displayName: 'The Admin', password: PASSWORD });
    expectRefusal(res, 429, 'too_many_attempts');
  });
});
