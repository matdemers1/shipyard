import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MailSettings, MailTestResult } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession, hashPassword } from '../../src/auth/index.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { checkHeartbeat } from '../../src/jobs/heartbeat.js';
import { runBackupJob } from '../../src/jobs/backup.js';
import { createMailer } from '../../src/mail/index.js';
import { MAIL_SETTING_KEY, liveRelay, parseStoredMail } from '../../src/mail/settings.js';
import { decryptSecret, deriveSettingsKey } from '../../src/settings/crypto.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * Settings → Alert email (SHP-REQ-093, SHP-T-6.9), against a local fake mail relay that speaks the
 * D3 Auth mail-relay Worker's contract: `POST {to, subject, text}` with `Authorization: Bearer`,
 * 401 without the right secret, 400 for a bad address. What has to hold: admin-only and
 * console-only; the token is encrypted at rest and never leaves the server (not in a response, the
 * audit or the log); a save applies to the heartbeat and backup alerts without a restart; the test
 * send reports the relay's answer; turning it off stops alerts; server.env wins.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const SESSION_SECRET = 'test-session-secret';
const PUBLIC_URL = 'http://shipyard.example.test';
const TOKEN = 'relay-bearer-token-plaintext-value';

// Everything the server logs, so a test can assert the token is never in it.
const logLines: string[] = [];
const logger = pino(
  { level: 'trace' },
  new Writable({
    write(chunk: Buffer, _enc, done) {
      logLines.push(chunk.toString('utf8'));
      done();
    },
  }),
);

// ── A fake mail relay ──────────────────────────────────────────────────

interface Received {
  path: string;
  authorization: string | undefined;
  body: { to?: unknown; subject?: unknown; text?: unknown };
}

let relayServer: Server;
let relayBase = '';
const received: Received[] = [];
const relayUrl = (): string => `${relayBase}/send`;

beforeAll(async () => {
  relayServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (req.url === '/hang') return; // never answers: the test send's timeout must end it
      if (req.url === '/redirect') {
        res.writeHead(307, { location: `${relayBase}/send` }).end();
        return;
      }
      const body = JSON.parse(raw || '{}') as Received['body'];
      received.push({ path: req.url ?? '', authorization: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (typeof body.to !== 'string' || !body.to.includes('@')) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_address' }));
        return;
      }
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
  relayBase = `http://127.0.0.1:${String((relayServer.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  relayServer.closeAllConnections();
  await new Promise<void>((resolve) => relayServer.close(() => { resolve(); }));
  await db.$disconnect();
});

// ── Apps and people ────────────────────────────────────────────────────

const unaudited: string[] = [];

function configWith(overrides: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: databaseUrl ?? '', PUBLIC_URL, SESSION_SECRET, ...overrides });
}

function appFor(config: Config): Express {
  return createApp({
    db,
    logger,
    config,
    mailTestTimeoutMs: 300,
    onUnauditedMutation: (info) => unaudited.push(`${info.method} ${info.path}`),
  });
}

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

async function person(role: Role): Promise<{ id: string; email: string; cookie: string }> {
  const email = `${role}-${randomUUID()}@example.com`;
  const user = await db.user.create({
    data: { email, displayName: role, role, passwordHash: await hashPassword('a long enough password') },
  });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { id: user.id, email, cookie: `${SESSION_COOKIE}=${session.token}` };
}

async function tokenFor(userId: string): Promise<string> {
  const { token, hash, prefix } = generateToken();
  await db.apiToken.create({ data: { userId, label: 'repo', tokenHash: hash, prefix } });
  return token;
}

let config: Config;
let app: Express;
let admin: Awaited<ReturnType<typeof person>>;

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "setting", "audit_event", "agent", "identity", "session", "api_token_app", "api_token", "user" cascade',
  );
  unaudited.length = 0;
  received.length = 0;
  logLines.length = 0;
  config = configWith();
  app = appFor(config);
  admin = await person('admin');
});

const get = (cookie: string) => request(app).get('/api/settings/mail').set('Cookie', cookie);
const put = (cookie: string, body: unknown) => request(app).put('/api/settings/mail').set('Cookie', cookie).send(body as object);
const del = (cookie: string) => request(app).delete('/api/settings/mail').set('Cookie', cookie);
const test = (cookie: string) => request(app).post('/api/settings/mail/test').set('Cookie', cookie).send({});

function errorCode(res: request.Response): string | undefined {
  return (res.body as { error?: { code?: string } }).error?.code;
}

/** Everything in the database that could hold the token, as text. */
async function everythingStored(): Promise<string> {
  const rows = await db.$queryRawUnsafe<{ t: string }[]>(
    `select row_to_json(x)::text as t from "setting" x union all select row_to_json(a)::text from "audit_event" a`,
  );
  return rows.map((r) => r.t).join('\n');
}

// ── The tests ──────────────────────────────────────────────────────────

describe('GET /api/settings/mail', () => {
  it('starts off', async () => {
    const res = await get(admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      source: 'none',
      relayUrl: null,
      tokenSet: false,
      alertTo: null,
      active: false,
      canStoreSecret: true,
      problem: null,
      updatedAt: null,
    } satisfies MailSettings);
  });

  it('is admin-only and console-only: other roles 403, nobody 401, an admin token 403', async () => {
    for (const role of ['deployer', 'operator', 'viewer'] as const) {
      const p = await person(role);
      expect((await get(p.cookie)).status).toBe(403);
      expect((await put(p.cookie, { relayUrl: relayUrl(), token: TOKEN, alertTo: 'ops@example.com' })).status).toBe(403);
      expect((await del(p.cookie)).status).toBe(403);
      expect((await test(p.cookie)).status).toBe(403);
    }
    expect((await request(app).get('/api/settings/mail')).status).toBe(401);
    const bearer = await tokenFor(admin.id);
    const viaToken = await request(app).get('/api/settings/mail').set('Authorization', `Bearer ${bearer}`);
    expect(viaToken.status).toBe(403);
    expect(await db.setting.count()).toBe(0);
  });
});

describe('PUT /api/settings/mail', () => {
  it('saves the relay with the token sealed, never returns it, and audits without it', async () => {
    const res = await put(admin.cookie, { relayUrl: relayUrl(), token: TOKEN, alertTo: 'ops@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'settings', relayUrl: relayUrl(), tokenSet: true, alertTo: 'ops@example.com', active: true });
    expect(res.text).not.toContain(TOKEN);
    expect((await get(admin.cookie)).text).not.toContain(TOKEN);

    const row = await db.setting.findUniqueOrThrow({ where: { key: MAIL_SETTING_KEY } });
    const stored = parseStoredMail(row.value);
    expect(stored?.token).toMatch(/^v1:/);
    expect(decryptSecret(stored?.token ?? '', deriveSettingsKey(SESSION_SECRET))).toBe(TOKEN);
    expect(row.updatedById).toBe(admin.id);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'settings.mail.updated' } });
    expect(audit.after).toEqual({ relayUrl: relayUrl(), alertTo: 'ops@example.com', tokenSet: true, tokenChanged: true });
    expect(await everythingStored()).not.toContain(TOKEN);
    expect(logLines.join('')).not.toContain(TOKEN);
    expect(unaudited).toEqual([]);
  });

  it('keeps the stored token when omitted, but not for another relay', async () => {
    await put(admin.cookie, { relayUrl: relayUrl(), token: TOKEN, alertTo: 'ops@example.com' });
    const keep = await put(admin.cookie, { relayUrl: relayUrl(), alertTo: 'oncall@example.com' });
    expect(keep.status).toBe(200);
    expect(keep.body).toMatchObject({ alertTo: 'oncall@example.com', tokenSet: true, active: true });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'settings.mail.updated' }, orderBy: { at: 'desc' } });
    expect(audit.after).toMatchObject({ tokenChanged: false });

    const moved = await put(admin.cookie, { relayUrl: `${relayBase}/elsewhere`, alertTo: 'ops@example.com' });
    expect(moved.status).toBe(400);
    expect((moved.body as { error: { message: string } }).error.message).toMatch(/relay URL changed/);
  });

  it('refuses a first save without a token, a bad URL, a bad recipient and no SESSION_SECRET', async () => {
    expect((await put(admin.cookie, { relayUrl: relayUrl(), alertTo: 'ops@example.com' })).status).toBe(400);
    expect((await put(admin.cookie, { relayUrl: 'http://relay.example.com/send', token: TOKEN, alertTo: 'ops@example.com' })).status).toBe(400);
    expect((await put(admin.cookie, { relayUrl: relayUrl(), token: TOKEN, alertTo: 'nobody' })).status).toBe(400);
    app = appFor(loadConfig({ DATABASE_URL: databaseUrl, PUBLIC_URL }));
    const noSecret = await put(admin.cookie, { relayUrl: relayUrl(), token: TOKEN, alertTo: 'ops@example.com' });
    expect(noSecret.status).toBe(409);
    expect((await get(admin.cookie)).body).toMatchObject({ canStoreSecret: false });
    expect(await db.setting.count()).toBe(0);
  });
});

describe('POST /api/settings/mail/test', () => {
  it('sends one message through the relay with the bearer token and reports its answer', async () => {
    await put(admin.cookie, { relayUrl: relayUrl(), token: TOKEN, alertTo: 'ops@example.com' });
    const res = await test(admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, status: 202, detail: '{"ok":true}' } satisfies MailTestResult);

    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(received[0]?.body).toEqual({ to: 'ops@example.com', subject: 'Shipyard test alert', text: expect.any(String) as string });
    const text = String(received[0]?.body.text);
    expect(text).toContain(PUBLIC_URL);
    expect(text).toContain(admin.email);

    // A second press is not suppressed as a repeat.
    expect((await test(admin.cookie)).body).toMatchObject({ sent: true });
    expect(received).toHaveLength(2);

    const audits = await db.auditEvent.findMany({ where: { action: 'settings.mail.tested' } });
    expect(audits).toHaveLength(2);
    expect(audits[0]?.after).toMatchObject({ sent: true, status: 202, relayUrl: relayUrl(), alertTo: 'ops@example.com' });
    expect(await everythingStored()).not.toContain(TOKEN);
    expect(logLines.join('')).not.toContain(TOKEN);
    expect(unaudited).toEqual([]);
  });

  it("reports the relay's refusal, and a relay that does not answer or redirects", async () => {
    // A token the relay does not know: 401, said as such.
    await put(admin.cookie, { relayUrl: relayUrl(), token: 'not-the-right-one', alertTo: 'ops@example.com' });
    const refused = await test(admin.cookie);
    expect(refused.body).toEqual({ sent: false, status: 401, detail: '{"error":"unauthorized"}' });

    await put(admin.cookie, { relayUrl: `${relayBase}/hang`, token: TOKEN, alertTo: 'ops@example.com' });
    const hung = await test(admin.cookie);
    expect(hung.body).toMatchObject({ sent: false });
    expect((hung.body as MailTestResult).status).toBeUndefined();
    expect((hung.body as MailTestResult).detail).toMatch(/did not answer/);

    await put(admin.cookie, { relayUrl: `${relayBase}/redirect`, token: TOKEN, alertTo: 'ops@example.com' });
    expect((await test(admin.cookie)).body).toMatchObject({ sent: false, status: 307 });
    // The redirect was not followed: the bearer token went nowhere else.
    expect(received.filter((r) => r.authorization === `Bearer ${TOKEN}`)).toHaveLength(0);
  });

  it('refuses with 409 when nothing is configured', async () => {
    const res = await test(admin.cookie);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('conflict');
    expect(received).toHaveLength(0);
  });
});

describe('the alerts use the saved relay without a restart', () => {
  async function staleAgent(): Promise<void> {
    await db.agent.create({
      data: {
        publicKey: 'k',
        fingerprint: `fp-${randomUUID()}`,
        confirmedAt: new Date(),
        lastHeartbeatAt: new Date(Date.now() - 30 * 60_000),
      },
    });
  }

  it('the heartbeat job emails through what was saved after it started, and stops once turned off', async () => {
    // Built once, as at boot, before anything is saved.
    const mailer = createMailer(config, logger, { relay: liveRelay({ db, config, logger }) });
    const deps = { db, logger, config, bus: new Bus() };
    await staleAgent();

    await checkHeartbeat(deps, mailer, { alerted: false });
    expect(received).toHaveLength(0);

    await put(admin.cookie, { relayUrl: relayUrl(), token: TOKEN, alertTo: 'ops@example.com' });
    await db.auditEvent.deleteMany({ where: { action: 'system.alert' } });
    await checkHeartbeat(deps, mailer, { alerted: false });
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(received[0]?.body).toMatchObject({ to: 'ops@example.com' });
    expect(String(received[0]?.body.subject)).toMatch(/^\[Shipyard\] The agent has not been heard from/);

    expect((await del(admin.cookie)).status).toBe(200);
    await db.auditEvent.deleteMany({ where: { action: 'system.alert' } });
    await checkHeartbeat(deps, mailer, { alerted: false });
    expect(received).toHaveLength(1);
    expect(logLines.join('')).not.toContain(TOKEN);
  });

  it('a failed nightly backup emails through the saved relay', async () => {
    const mailer = createMailer(config, logger, { relay: liveRelay({ db, config, logger }) });
    await put(admin.cookie, { relayUrl: relayUrl(), token: TOKEN, alertTo: 'ops@example.com' });
    // pg_dump cannot even be found: the backup fails before it touches the disk.
    const outcome = await runBackupJob({ db, logger, config }, mailer, { run: () => Promise.reject(new Error('pg_dump: not found')) });
    expect(outcome.ok).toBe(false);
    expect(received.map((r) => [r.body.to, r.body.subject])).toEqual([['ops@example.com', '[Shipyard] Nightly database backup failed']]);
  });
});

describe('DELETE /api/settings/mail', () => {
  it('turns it off, audited without the token; clearing nothing writes no audit row', async () => {
    await put(admin.cookie, { relayUrl: relayUrl(), token: TOKEN, alertTo: 'ops@example.com' });
    const res = await del(admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'none', active: false });
    expect(await db.setting.count()).toBe(0);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'settings.mail.cleared' } });
    expect(audit.before).toEqual({ relayUrl: relayUrl(), alertTo: 'ops@example.com', tokenSet: true });

    expect((await del(admin.cookie)).status).toBe(200);
    expect(await db.auditEvent.count({ where: { action: 'settings.mail.cleared' } })).toBe(1);
    expect(unaudited).toEqual([]);
  });
});

describe('server.env wins', () => {
  const ENV = { MAIL_RELAY_TOKEN: TOKEN, ALERT_TO: 'env@example.com' };

  it('shows the env relay read-only, refuses every write with 409, and tests through it', async () => {
    config = configWith({ MAIL_RELAY_URL: relayUrl(), ...ENV });
    app = appFor(config);
    const read = await get(admin.cookie);
    expect(read.body).toMatchObject({ source: 'env', relayUrl: relayUrl(), tokenSet: true, alertTo: 'env@example.com', active: true });
    expect(read.text).not.toContain(TOKEN);

    const write = await put(admin.cookie, { relayUrl: relayUrl(), token: 'other', alertTo: 'ops@example.com' });
    expect(write.status).toBe(409);
    expect((write.body as { error: { fix: string } }).error.fix).toMatch(/server\.env/);
    expect((await del(admin.cookie)).status).toBe(409);
    expect(await db.setting.count()).toBe(0);

    expect((await test(admin.cookie)).body).toMatchObject({ sent: true, status: 202 });
    expect(received[0]?.body).toMatchObject({ to: 'env@example.com' });
  });

  it('ignores a stored setting while env owns alert email', async () => {
    await put(admin.cookie, { relayUrl: relayUrl(), token: 'saved-token', alertTo: 'saved@example.com' });
    config = configWith({ MAIL_RELAY_URL: relayUrl(), ...ENV });
    const mailer = createMailer(config, logger, { relay: liveRelay({ db, config, logger }) });
    await mailer.send({ kind: 'drill-failed', subject: 's', body: 'b' });
    expect(received.map((r) => [r.body.to, r.authorization])).toEqual([['env@example.com', `Bearer ${TOKEN}`]]);
  });
});
