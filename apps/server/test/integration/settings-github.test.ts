import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { GitHubSettings } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession, hashPassword } from '../../src/auth/index.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { forgetGitHubToken, GITHUB_SETTING_KEY, resolveGitHubToken } from '../../src/github/token.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * Settings → GitHub (SHP-T-3.13), with GitHub's `/rate_limit` faked. What has to hold: admin-only
 * and console-only; the token is sealed at rest and never leaves the server (not in a response,
 * the audit or the log); a save is what the server's GitHub callers use next, without a restart;
 * the screen reports GitHub's rate limit and whether it counted the server as authenticated; a
 * rejected token says so; server.env wins.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const TOKEN = 'github_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RESET = 1_790_000_000;

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

/** GitHub's `/rate_limit`: 5000 with the right token, 401 with another, 60 anonymous. */
const seen: (string | null)[] = [];
const fakeGitHub: typeof fetch = (_input, init) => {
  const auth = new Headers(init?.headers).get('authorization');
  seen.push(auth);
  if (auth !== null && auth !== `Bearer ${TOKEN}`) {
    return Promise.resolve(new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }));
  }
  const core = auth === null ? { limit: 60, remaining: 0, reset: RESET } : { limit: 5000, remaining: 4990, reset: RESET };
  return Promise.resolve(new Response(JSON.stringify({ resources: { core } }), { status: 200 }));
};

const unaudited: string[] = [];

function configWith(overrides: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: databaseUrl ?? '', PUBLIC_URL: 'http://shipyard.example.test', SESSION_SECRET: 'test-session-secret', ...overrides });
}

function appFor(config: Config): Express {
  return createApp({
    db,
    logger,
    config,
    githubFetch: fakeGitHub,
    onUnauditedMutation: (info) => unaudited.push(`${info.method} ${info.path}`),
  });
}

async function person(role: 'admin' | 'operator' | 'deployer' | 'viewer'): Promise<{ id: string; cookie: string }> {
  const user = await db.user.create({
    data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role, passwordHash: await hashPassword('a long enough password') },
  });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { id: user.id, cookie: `${SESSION_COOKIE}=${session.token}` };
}

let config: Config;
let app: Express;
let admin: Awaited<ReturnType<typeof person>>;

beforeEach(async () => {
  await db.$executeRawUnsafe('truncate table "setting", "audit_event", "identity", "session", "api_token_app", "api_token", "user" cascade');
  forgetGitHubToken(db);
  unaudited.length = 0;
  logLines.length = 0;
  seen.length = 0;
  config = configWith();
  app = appFor(config);
  admin = await person('admin');
});

afterAll(async () => {
  await db.$disconnect();
});

const get = (cookie: string) => request(app).get('/api/settings/github').set('Cookie', cookie);
const put = (cookie: string, body: unknown) => request(app).put('/api/settings/github').set('Cookie', cookie).send(body as object);
const del = (cookie: string) => request(app).delete('/api/settings/github').set('Cookie', cookie);
const test = (cookie: string, body: unknown = {}) => request(app).post('/api/settings/github/test').set('Cookie', cookie).send(body as object);

async function everythingStored(): Promise<string> {
  const rows = await db.$queryRawUnsafe<{ t: string }[]>(
    `select row_to_json(x)::text as t from "setting" x union all select row_to_json(a)::text from "audit_event" a`,
  );
  return rows.map((r) => r.t).join('\n');
}

describe('Settings → GitHub', () => {
  it('starts anonymous and says so with the rate limit GitHub reports', async () => {
    const res = await get(admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      source: 'none',
      tokenSet: false,
      canStoreSecret: true,
      problem: null,
      updatedAt: null,
      rateLimit: { authenticated: false, limit: 60, remaining: 0, resetAt: new Date(RESET * 1000).toISOString() },
      rateLimitProblem: null,
    } satisfies GitHubSettings);
  });

  it('is admin-only and console-only', async () => {
    for (const role of ['deployer', 'operator', 'viewer'] as const) {
      const p = await person(role);
      expect((await get(p.cookie)).status).toBe(403);
      expect((await put(p.cookie, { token: TOKEN })).status).toBe(403);
      expect((await del(p.cookie)).status).toBe(403);
      expect((await test(p.cookie)).status).toBe(403);
    }
    expect((await request(app).get('/api/settings/github')).status).toBe(401);
    const { token, hash, prefix } = generateToken();
    await db.apiToken.create({ data: { userId: admin.id, label: 'repo', tokenHash: hash, prefix } });
    expect((await request(app).get('/api/settings/github').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect(await db.setting.count()).toBe(0);
  });

  it('saves the token sealed, uses it at once, and never shows or logs it', async () => {
    const saved = await put(admin.cookie, { token: TOKEN });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ source: 'settings', tokenSet: true, rateLimit: { authenticated: true, limit: 5000 } });
    expect(JSON.stringify(saved.body)).not.toContain(TOKEN);
    expect(await everythingStored()).not.toContain(TOKEN);
    expect(logLines.join('')).not.toContain(TOKEN);
    expect((await resolveGitHubToken({ db, config })).token).toBe(TOKEN);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'settings.github.updated' } });
    expect(audit.after).toEqual({ tokenSet: true });
    expect(unaudited).toEqual([]);
  });

  it('tests a token before saving it, and says when GitHub rejects it', async () => {
    const good = await test(admin.cookie, { token: TOKEN });
    expect(good.body).toMatchObject({ ok: true, status: 200, rateLimit: { authenticated: true } });
    const badToken = await test(admin.cookie, { token: 'github_pat_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    expect(badToken.body).toEqual({ ok: false, status: 401, detail: 'GitHub rejected the token (401): it is mistyped, expired or revoked.' });
    expect(await db.setting.count()).toBe(0);
  });

  it('refuses something that is not a token', async () => {
    const res = await put(admin.cookie, { token: 'not a token' });
    expect(res.status).toBe(400);
  });

  it('clears the token and goes back to anonymous', async () => {
    await put(admin.cookie, { token: TOKEN });
    const cleared = await del(admin.cookie);
    expect(cleared.body).toMatchObject({ source: 'none', tokenSet: false, rateLimit: { authenticated: false } });
    expect(await db.setting.findUnique({ where: { key: GITHUB_SETTING_KEY } })).toBeNull();
    expect((await resolveGitHubToken({ db, config })).token).toBeNull();
  });

  it('lets server.env win: shown read-only, every write refused', async () => {
    config = configWith({ GITHUB_TOKEN_SERVER: TOKEN });
    app = appFor(config);
    expect((await get(admin.cookie)).body).toMatchObject({ source: 'env', tokenSet: true, rateLimit: { authenticated: true } });
    expect((await put(admin.cookie, { token: TOKEN })).status).toBe(409);
    expect((await del(admin.cookie)).status).toBe(409);
  });
});
