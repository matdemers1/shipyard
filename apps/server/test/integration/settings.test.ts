import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { D3AuthSettings, D3AuthTestResult } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { OidcSettings, SESSION_COOKIE, createSession, generateTotpSecret, hashPassword, totpCode } from '../../src/auth/index.js';
import { D3AUTH_SETTING_KEY, parseStoredD3Auth } from '../../src/auth/oidc-settings.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { decryptSecret, deriveSettingsKey } from '../../src/settings/crypto.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * Settings → Sign in with D3 Auth (SHP-REQ-110, SHP-T-6.8), against the real OIDC SDK and a local
 * fake issuer that serves discovery documents. What has to hold: admin-only; the secret is
 * encrypted at rest and never leaves the server; a save swaps the live client without a restart;
 * clearing turns the button off; server.env wins; every change is audited without the secret; and
 * password sign-in keeps working whatever is saved (SHP-REQ-001).
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const logger = pino({ enabled: false });
const SESSION_SECRET = 'test-session-secret';
const PUBLIC_URL = 'http://shipyard.example.test';
const SECRET = 'd3auth-client-secret-plaintext-value';
const PASSWORD = 'a long enough password';

// ── A fake issuer: /good serves a valid discovery document, /mismatch names another issuer ──

let issuerServer: Server;
let base = '';
const goodIssuer = (): string => `${base}/good`;
const mismatchIssuer = (): string => `${base}/mismatch`;
/** A port nothing listens on: connection refused at once. */
const DEAD_ISSUER = 'http://127.0.0.1:9';

beforeAll(async () => {
  issuerServer = createServer((req, res) => {
    const match = /^\/(good|mismatch)\/\.well-known\/openid-configuration$/.exec(req.url ?? '');
    if (match === null) {
      res.writeHead(404).end();
      return;
    }
    const issuer = `${base}/${match[1] ?? ''}`;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        issuer: match[1] === 'good' ? issuer : 'https://someone-else.example.test',
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      }),
    );
  });
  await new Promise<void>((resolve) => issuerServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((issuerServer.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => issuerServer.close(() => { resolve(); }));
  await db.$disconnect();
});

// ── Apps and people ────────────────────────────────────────────────────

const unaudited: string[] = [];

function configWith(overrides: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: databaseUrl ?? '', PUBLIC_URL, SESSION_SECRET, ...overrides });
}

async function appFor(config: Config): Promise<{ app: Express; oidc: OidcSettings }> {
  const oidc = new OidcSettings({ db, logger, config });
  await oidc.load();
  const app = createApp({
    db,
    logger,
    config,
    oidcSettings: oidc,
    onUnauditedMutation: (info) => unaudited.push(`${info.method} ${info.path}`),
  });
  return { app, oidc };
}

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

async function person(role: Role): Promise<{ id: string; email: string; cookie: string; totpSecret: string }> {
  const totpSecret = generateTotpSecret();
  const email = `${role}-${randomUUID()}@example.com`;
  const user = await db.user.create({
    data: { email, displayName: role, role, passwordHash: await hashPassword(PASSWORD), totpSecret, totpEnabledAt: new Date() },
  });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { id: user.id, email, cookie: `${SESSION_COOKIE}=${session.token}`, totpSecret };
}

async function tokenFor(userId: string): Promise<string> {
  const { token, hash, prefix } = generateToken();
  await db.apiToken.create({ data: { userId, label: 'repo', tokenHash: hash, prefix } });
  return token;
}

function errorCode(res: request.Response): string | undefined {
  return (res.body as { error?: { code?: string } }).error?.code;
}

let app: Express;
let admin: Awaited<ReturnType<typeof person>>;

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "setting", "audit_event", "identity", "session", "api_token_app", "api_token", "user" cascade',
  );
  unaudited.length = 0;
  ({ app } = await appFor(configWith()));
  admin = await person('admin');
});

const get = (cookie: string) => request(app).get('/api/settings/d3auth').set('Cookie', cookie);
const put = (cookie: string, body: unknown) => request(app).put('/api/settings/d3auth').set('Cookie', cookie).send(body as object);

async function methods(): Promise<{ password: boolean; d3auth: boolean }> {
  const res = await request(app).get('/api/auth/methods');
  return res.body as { password: boolean; d3auth: boolean };
}

/** Everything in the database that could hold the secret, as text. */
async function everythingStored(): Promise<string> {
  const rows = await db.$queryRawUnsafe<{ t: string }[]>(
    `select row_to_json(x)::text as t from "setting" x union all select row_to_json(a)::text from "audit_event" a`,
  );
  return rows.map((r) => r.t).join('\n');
}

// ── The tests ──────────────────────────────────────────────────────────

describe('GET /api/settings/d3auth', () => {
  it('starts unconfigured, with the redirect URI and a manifest built from PUBLIC_URL', async () => {
    const res = await get(admin.cookie);
    expect(res.status).toBe(200);
    const body = res.body as D3AuthSettings;
    expect(body).toMatchObject({
      source: 'none',
      issuer: null,
      clientId: null,
      clientSecretSet: false,
      redirectUri: `${PUBLIC_URL}/api/auth/oidc/callback`,
      available: false,
      reachable: null,
      canStoreSecret: true,
      problem: null,
      updatedAt: null,
    });
    expect(body.manifest?.['redirect_uris']).toEqual([`${PUBLIC_URL}/api/auth/oidc/callback`]);
    expect(body.manifest?.['post_logout_redirect_uris']).toEqual([`${PUBLIC_URL}/`]);
  });

  it('is admin-only: a deployer, an operator and a viewer get 403, nobody 401, and even an admin token 403', async () => {
    for (const role of ['deployer', 'operator', 'viewer'] as const) {
      const p = await person(role);
      expect((await get(p.cookie)).status).toBe(403);
      expect((await put(p.cookie, { issuer: goodIssuer(), clientId: 'shipyard' })).status).toBe(403);
      expect((await request(app).delete('/api/settings/d3auth').set('Cookie', p.cookie)).status).toBe(403);
      expect((await request(app).post('/api/settings/d3auth/test').set('Cookie', p.cookie).send({})).status).toBe(403);
    }
    expect((await request(app).get('/api/settings/d3auth')).status).toBe(401);
    const token = await tokenFor(admin.id);
    const bearer = { Authorization: `Bearer ${token}` };
    expect((await request(app).get('/api/settings/d3auth').set(bearer)).status).toBe(403);
    const tokenPut = await request(app).put('/api/settings/d3auth').set(bearer).send({ issuer: goodIssuer(), clientId: 'x' });
    expect(tokenPut.status).toBe(403);
    expect(await db.setting.count()).toBe(0);
  });
});

describe('PUT /api/settings/d3auth', () => {
  it('saves, encrypts the secret, never returns it, and turns D3 Auth on without a restart', async () => {
    expect(await methods()).toEqual({ password: true, d3auth: false });

    const res = await put(admin.cookie, { issuer: goodIssuer(), clientId: 'shipyard', clientSecret: SECRET });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SECRET);
    expect(res.body).toMatchObject({
      source: 'settings',
      issuer: goodIssuer(),
      clientId: 'shipyard',
      clientSecretSet: true,
      available: true,
      reachable: true,
      problem: null,
    });
    expect(Object.keys(res.body as object)).not.toContain('clientSecret');

    // The same process now offers D3 Auth, and its start goes to the saved issuer.
    expect(await methods()).toEqual({ password: true, d3auth: true });
    const start = await request(app).get('/api/auth/oidc/start');
    expect(start.status).toBe(302);
    const location = new URL(start.headers['location'] as string);
    expect(`${location.origin}${location.pathname}`).toBe(`${goodIssuer()}/auth`);
    expect(location.searchParams.get('client_id')).toBe('shipyard');
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/api/auth/oidc/callback`);

    // At rest: ciphertext, which decrypts with the SESSION_SECRET-derived key.
    const row = await db.setting.findUniqueOrThrow({ where: { key: D3AUTH_SETTING_KEY } });
    const stored = parseStoredD3Auth(row.value);
    expect(stored?.clientSecret).toMatch(/^v1:/);
    expect(stored?.clientSecret).not.toContain(SECRET);
    expect(decryptSecret(stored?.clientSecret ?? '', deriveSettingsKey(SESSION_SECRET))).toBe(SECRET);
    expect(row.updatedById).toBe(admin.id);

    // Audited, with neither the plaintext nor the ciphertext.
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'settings.d3auth.updated' } });
    expect(audit.actorUserId).toBe(admin.id);
    expect(audit.after).toEqual({ issuer: goodIssuer(), clientId: 'shipyard', clientSecretSet: true, secretChanged: true });
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(SECRET);
    expect(auditText).not.toContain(stored?.clientSecret ?? 'never');
    expect(await everythingStored()).not.toContain(SECRET);

    // And a later read still does not carry it.
    const read = await get(admin.cookie);
    expect(read.text).not.toContain(SECRET);
    expect(read.text).not.toContain(stored?.clientSecret ?? 'never');
    expect(unaudited).toEqual([]);
  });

  it('keeps the stored secret when none is sent, clears it on request, and refuses a kept secret for a new issuer', async () => {
    await put(admin.cookie, { issuer: goodIssuer(), clientId: 'shipyard', clientSecret: SECRET });
    const sealed = parseStoredD3Auth((await db.setting.findUniqueOrThrow({ where: { key: D3AUTH_SETTING_KEY } })).value)?.clientSecret;

    const kept = await put(admin.cookie, { issuer: goodIssuer(), clientId: 'shipyard-2' });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ clientId: 'shipyard-2', clientSecretSet: true });
    const after = parseStoredD3Auth((await db.setting.findUniqueOrThrow({ where: { key: D3AUTH_SETTING_KEY } })).value);
    expect(after?.clientSecret).toBe(sealed);
    const keptAudit = await db.auditEvent.findFirstOrThrow({ where: { action: 'settings.d3auth.updated' }, orderBy: { at: 'desc' } });
    expect(keptAudit.after).toMatchObject({ clientId: 'shipyard-2', secretChanged: false });

    // The secret goes only to the issuer that issued it.
    const moved = await put(admin.cookie, { issuer: DEAD_ISSUER, clientId: 'shipyard' });
    expect(moved.status).toBe(400);
    expect(errorCode(moved)).toBe('invalid_request');

    const cleared = await put(admin.cookie, { issuer: goodIssuer(), clientId: 'shipyard', clearSecret: true });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ clientSecretSet: false, available: true });

    const both = await put(admin.cookie, { issuer: goodIssuer(), clientId: 'shipyard', clientSecret: 'x', clearSecret: true });
    expect(both.status).toBe(400);
  });

  it('refuses a non-https issuer, an unknown field, and a body with no client ID', async () => {
    for (const body of [
      { issuer: 'http://auth.example.test', clientId: 'shipyard' },
      { issuer: 'file:///etc/passwd', clientId: 'shipyard' },
      { issuer: goodIssuer(), clientId: 'shipyard', command: 'id' },
      { issuer: goodIssuer() },
    ]) {
      const res = await put(admin.cookie, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await db.setting.count()).toBe(0);
  });

  it('stores an unreachable issuer but leaves D3 Auth off — and password sign-in works throughout', async () => {
    const res = await put(admin.cookie, { issuer: DEAD_ISSUER, clientId: 'shipyard', clientSecret: SECRET });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'settings', available: false, reachable: false });
    expect((res.body as D3AuthSettings).problem).toMatch(/did not answer/);
    expect(await methods()).toEqual({ password: true, d3auth: false });
    expect(errorCode(await request(app).get('/api/auth/oidc/start'))).toBe('invalid_request');

    const browser = request.agent(app);
    const step1 = await browser.post('/api/auth/login').send({ email: admin.email, password: PASSWORD });
    expect(step1.status).toBe(200);
    const step2 = await browser.post('/api/auth/totp').send({ code: totpCode(admin.totpSecret) });
    expect(step2.status).toBe(200);
    expect((await browser.get('/api/auth/me')).status).toBe(200);
  });

  it('refuses to store a secret when SESSION_SECRET is unset, but stores a public client', async () => {
    ({ app } = await appFor(configWith({ SESSION_SECRET: '' })));
    expect((await get(admin.cookie)).body).toMatchObject({ canStoreSecret: false });
    const withSecret = await put(admin.cookie, { issuer: goodIssuer(), clientId: 'shipyard', clientSecret: SECRET });
    expect(withSecret.status).toBe(409);
    expect((withSecret.body as { error: { message: string } }).error.message).toMatch(/SESSION_SECRET/);
    expect(await db.setting.count()).toBe(0);
    const publicClient = await put(admin.cookie, { issuer: goodIssuer(), clientId: 'shipyard' });
    expect(publicClient.status).toBe(200);
    expect(publicClient.body).toMatchObject({ clientSecretSet: false, available: true });
  });

  it('refuses when PUBLIC_URL is unset: there would be no redirect URI', async () => {
    ({ app } = await appFor(configWith({ PUBLIC_URL: '' })));
    const res = await put(admin.cookie, { issuer: goodIssuer(), clientId: 'shipyard' });
    expect(res.status).toBe(409);
    expect((await get(admin.cookie)).body).toMatchObject({ redirectUri: null, manifest: null });
  });

  it('loads a saved setting at boot: a new process offers D3 Auth from the database', async () => {
    await put(admin.cookie, { issuer: goodIssuer(), clientId: 'shipyard', clientSecret: SECRET });
    ({ app } = await appFor(configWith()));
    expect(await methods()).toEqual({ password: true, d3auth: true });
    expect((await get(admin.cookie)).body).toMatchObject({ source: 'settings', clientSecretSet: true, available: true });
  });
});

describe('DELETE /api/settings/d3auth', () => {
  it('clears the setting and turns the D3 Auth button off, audited without the secret', async () => {
    await put(admin.cookie, { issuer: goodIssuer(), clientId: 'shipyard', clientSecret: SECRET });
    expect(await methods()).toEqual({ password: true, d3auth: true });

    const res = await request(app).delete('/api/settings/d3auth').set('Cookie', admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'none', available: false, clientSecretSet: false });
    expect(await methods()).toEqual({ password: true, d3auth: false });
    expect(errorCode(await request(app).get('/api/auth/oidc/start'))).toBe('invalid_request');
    expect(await db.setting.count()).toBe(0);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'settings.d3auth.cleared' } });
    expect(audit.before).toEqual({ issuer: goodIssuer(), clientId: 'shipyard', clientSecretSet: true });
    expect(JSON.stringify(audit)).not.toContain(SECRET);

    // Clearing nothing is fine, and writes no audit row.
    expect((await request(app).delete('/api/settings/d3auth').set('Cookie', admin.cookie)).status).toBe(200);
    expect(await db.auditEvent.count({ where: { action: 'settings.d3auth.cleared' } })).toBe(1);
    expect(unaudited).toEqual([]);
  });
});

describe('server.env wins', () => {
  it('shows D3AUTH_* read-only and refuses every write with 409', async () => {
    let oidc: OidcSettings;
    ({ app, oidc } = await appFor(
      configWith({ D3AUTH_ISSUER: goodIssuer(), D3AUTH_CLIENT_ID: 'from-env', D3AUTH_CLIENT_SECRET: SECRET }),
    ));
    expect(oidc.current()).not.toBeNull();

    const read = await get(admin.cookie);
    expect(read.body).toMatchObject({ source: 'env', issuer: goodIssuer(), clientId: 'from-env', clientSecretSet: true, available: true });
    expect(read.text).not.toContain(SECRET);

    const write = await put(admin.cookie, { issuer: goodIssuer(), clientId: 'shipyard', clientSecret: 'other' });
    expect(write.status).toBe(409);
    expect((write.body as { error: { message: string; fix: string } }).error.fix).toMatch(/server\.env/);
    expect((await request(app).delete('/api/settings/d3auth').set('Cookie', admin.cookie)).status).toBe(409);
    expect(await db.setting.count()).toBe(0);
    expect(await methods()).toEqual({ password: true, d3auth: true });
  });

  it('ignores a stored setting while env owns D3 Auth', async () => {
    await put(admin.cookie, { issuer: goodIssuer(), clientId: 'from-settings' });
    ({ app } = await appFor(configWith({ D3AUTH_ISSUER: DEAD_ISSUER, D3AUTH_CLIENT_ID: 'from-env' })));
    expect((await get(admin.cookie)).body).toMatchObject({ source: 'env', clientId: 'from-env', available: false, reachable: false });
    expect(await methods()).toEqual({ password: true, d3auth: false });
  });
});

describe('POST /api/settings/d3auth/test', () => {
  const test = (body: unknown) => request(app).post('/api/settings/d3auth/test').set('Cookie', admin.cookie).send(body as object);

  it('reports a good issuer, a mismatched one and an unreachable one', async () => {
    const good = await test({ issuer: goodIssuer() });
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ ok: true, issuerMatches: true, jwksUri: `${goodIssuer()}/jwks`, error: null } satisfies Partial<D3AuthTestResult>);

    const mismatch = await test({ issuer: mismatchIssuer() });
    expect(mismatch.body).toMatchObject({ ok: false, issuerMatches: false, discoveredIssuer: 'https://someone-else.example.test' });

    const dead = await test({ issuer: DEAD_ISSUER });
    expect(dead.status).toBe(200);
    expect(dead.body).toMatchObject({ ok: false });
    expect((dead.body as D3AuthTestResult).error).toMatch(/Could not connect/);

    const missing = await test({ issuer: `${base}/nothing-here` });
    expect((missing.body as D3AuthTestResult).error).toMatch(/HTTP 404/);
    // A test changes nothing, so writes nothing.
    expect(await db.auditEvent.count()).toBe(0);
    expect(unaudited).toEqual([]);
  });

  it('tests the saved issuer when none is given, and refuses when there is none or it is not allowed', async () => {
    expect((await test({})).status).toBe(400);
    await put(admin.cookie, { issuer: goodIssuer(), clientId: 'shipyard' });
    expect((await test({})).body).toMatchObject({ ok: true, issuer: goodIssuer() });
    expect((await test({ issuer: 'http://169.254.169.254' })).status).toBe(400);
    expect((await test({ issuer: 'gopher://127.0.0.1' })).status).toBe(400);
  });
});
