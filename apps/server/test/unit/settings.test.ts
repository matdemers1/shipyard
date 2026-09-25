import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { OidcClient, OidcParams } from '../../src/auth/oidc.js';
import { OidcSettings, envOwnsD3Auth } from '../../src/auth/oidc-settings.js';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db.js';
import { SettingsCryptoError, decryptSecret, deriveSettingsKey, encryptSecret } from '../../src/settings/crypto.js';
import { testDiscovery } from '../../src/settings/discovery.js';
import { d3authManifest } from '../../src/settings/manifest.js';

/** Settings → D3 Auth (SHP-REQ-110, SHP-T-6.8): the pieces that need no database. */

const logger = pino({ enabled: false });

describe('settings secret encryption', () => {
  const key = deriveSettingsKey('a-session-secret');

  it('round-trips, and the stored form is neither the plaintext nor deterministic', () => {
    const a = encryptSecret('client-secret-value', key);
    const b = encryptSecret('client-secret-value', key);
    expect(a).toMatch(/^v1:[A-Za-z0-9+/]+=*$/);
    expect(a).not.toContain('client-secret-value');
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe('client-secret-value');
  });

  it('refuses another key, a tampered value and an unknown format', () => {
    const sealed = encryptSecret('x', key);
    expect(() => decryptSecret(sealed, deriveSettingsKey('another-secret'))).toThrow(SettingsCryptoError);
    const raw = Buffer.from(sealed.slice(3), 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => decryptSecret(`v1:${raw.toString('base64')}`, key)).toThrow(SettingsCryptoError);
    expect(() => decryptSecret('plaintext', key)).toThrow(/unknown format/);
    expect(() => decryptSecret('v1:AAAA', key)).toThrow(/truncated/);
  });

  it('derives a 32-byte key that depends on SESSION_SECRET', () => {
    expect(key).toHaveLength(32);
    expect(deriveSettingsKey('a-session-secret').equals(key)).toBe(true);
    expect(deriveSettingsKey('b').equals(key)).toBe(false);
  });
});

describe('d3authManifest', () => {
  it('is docs/d3auth/shipyard.d3auth.json for the D3 Cloud host', () => {
    const doc: unknown = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../docs/d3auth/shipyard.d3auth.json'), 'utf8'));
    expect(d3authManifest('https://shipyard.d3cloud.io')).toEqual(doc);
  });

  it('builds the URIs from PUBLIC_URL', () => {
    const m = d3authManifest('http://127.0.0.1:3466', 'my-shipyard');
    expect(m['client_id']).toBe('my-shipyard');
    expect(m['redirect_uris']).toEqual(['http://127.0.0.1:3466/api/auth/oidc/callback']);
    expect(m['post_logout_redirect_uris']).toEqual(['http://127.0.0.1:3466/']);
  });
});

function reply(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return vi.fn(() =>
    Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })),
  );
}

const ISSUER = 'https://auth.example.com';
const DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oidc/auth`,
  token_endpoint: `${ISSUER}/oidc/token`,
  jwks_uri: `${ISSUER}/oidc/jwks`,
};

describe('testDiscovery', () => {
  it('reports a good discovery document, fetched from the well-known path without following redirects', async () => {
    const fetchImpl = reply(200, DOC);
    const result = await testDiscovery(`${ISSUER}/`, { fetchImpl });
    expect(result).toMatchObject({ ok: true, issuerMatches: true, jwksUri: DOC.jwks_uri, error: null });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0] ?? [];
    expect(url).toBe(`${ISSUER}/.well-known/openid-configuration`);
    expect(init?.redirect).toBe('manual');
  });

  it('names an issuer mismatch', async () => {
    const result = await testDiscovery(ISSUER, { fetchImpl: reply(200, { ...DOC, issuer: 'https://other.example.com' }) });
    expect(result).toMatchObject({ ok: false, issuerMatches: false, discoveredIssuer: 'https://other.example.com' });
    expect(result.error).toContain('https://other.example.com');
  });

  it.each([
    [404, DOC, /not found \(HTTP 404\)/],
    [302, '', /redirect/],
    [200, 'not json', /not with a JSON/],
    [200, { ...DOC, jwks_uri: undefined }, /signing keys/],
  ])('reports HTTP %s with a sentence', async (status, body, message) => {
    const result = await testDiscovery(ISSUER, { fetchImpl: reply(status, body) });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(message);
  });

  it('reports a connection failure and a timeout', async () => {
    const refused = vi.fn(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })));
    expect((await testDiscovery(ISSUER, { fetchImpl: refused as unknown as typeof fetch })).error).toBe(
      'Could not connect to the issuer (ECONNREFUSED).',
    );
    const slow = vi.fn(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    expect((await testDiscovery(ISSUER, { fetchImpl: slow as unknown as typeof fetch, timeoutMs: 2000 })).error).toMatch(/2 seconds/);
  });

  it('never fetches a disallowed issuer (plain http off-machine, another scheme)', async () => {
    const fetchImpl = reply(200, DOC);
    for (const issuer of ['http://auth.example.com', 'file:///etc/passwd', 'https://user:pw@auth.example.com']) {
      expect((await testDiscovery(issuer, { fetchImpl })).ok).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

const stubClient = (issuer: string): OidcClient => ({
  issuer,
  beginSignIn: () => Promise.resolve({ url: `${issuer}/auth`, tx: 'tx' }),
  completeSignIn: () => Promise.reject(new Error('unused')),
});

function fakeDb(row: { value: unknown; updatedAt: Date } | null | Error): Db {
  return {
    setting: {
      findUnique: () => (row instanceof Error ? Promise.reject(row) : Promise.resolve(row)),
    },
  } as unknown as Db;
}

const BASE = { DATABASE_URL: 'postgresql://x/y', PUBLIC_URL: 'https://shipyard.example.com', SESSION_SECRET: 'the-secret' };

describe('OidcSettings', () => {
  it('env wins whenever any D3AUTH_* variable is set', async () => {
    const config = loadConfig({ ...BASE, D3AUTH_ISSUER: ISSUER, D3AUTH_CLIENT_ID: 'shipyard', D3AUTH_CLIENT_SECRET: 's' });
    expect(envOwnsD3Auth(config)).toBe(true);
    const seen: OidcParams[] = [];
    const settings = new OidcSettings({
      db: fakeDb(new Error('the database is not read when env owns it')),
      logger,
      config,
      build: (p) => {
        seen.push(p);
        return Promise.resolve(stubClient(p.issuer));
      },
    });
    await settings.load();
    expect(settings.current()?.issuer).toBe(ISSUER);
    expect(settings.state()).toMatchObject({ source: 'env', clientSecretSet: true, reachable: true, problem: null });
    expect(seen).toEqual([{ issuer: ISSUER, clientId: 'shipyard', clientSecret: 's', publicUrl: BASE.PUBLIC_URL }]);
    expect(envOwnsD3Auth(loadConfig({ ...BASE, D3AUTH_CLIENT_SECRET: 's' }))).toBe(true);
    expect(envOwnsD3Auth(loadConfig(BASE))).toBe(false);
  });

  it('builds from the stored setting, decrypting the secret for the client only', async () => {
    const config = loadConfig(BASE);
    const sealed = encryptSecret('plain-secret', deriveSettingsKey('the-secret'));
    const seen: OidcParams[] = [];
    const settings = new OidcSettings({
      db: fakeDb({ value: { issuer: ISSUER, clientId: 'shipyard', clientSecret: sealed }, updatedAt: new Date(0) }),
      logger,
      config,
      build: (p) => {
        seen.push(p);
        return Promise.resolve(stubClient(p.issuer));
      },
    });
    await settings.load();
    expect(seen[0]?.clientSecret).toBe('plain-secret');
    expect(settings.state()).toMatchObject({ source: 'settings', clientSecretSet: true, reachable: true });
    expect(JSON.stringify(settings.state())).not.toContain('plain-secret');
  });

  it('is unavailable, not broken, when the secret cannot be read or discovery fails', async () => {
    const sealed = encryptSecret('plain-secret', deriveSettingsKey('an-old-secret'));
    const build = vi.fn((p: OidcParams) => Promise.resolve(stubClient(p.issuer)));
    const unreadable = new OidcSettings({
      db: fakeDb({ value: { issuer: ISSUER, clientId: 'shipyard', clientSecret: sealed }, updatedAt: new Date(0) }),
      logger,
      config: loadConfig(BASE),
      build,
    });
    await unreadable.load();
    expect(unreadable.current()).toBeNull();
    expect(unreadable.state().problem).toMatch(/SESSION_SECRET has changed/);
    expect(build).not.toHaveBeenCalled();

    const noSessionSecret = new OidcSettings({
      db: fakeDb({ value: { issuer: ISSUER, clientId: 'shipyard', clientSecret: sealed }, updatedAt: new Date(0) }),
      logger,
      config: loadConfig({ ...BASE, SESSION_SECRET: '' }),
      build,
    });
    await noSessionSecret.load();
    expect(noSessionSecret.state().problem).toMatch(/SESSION_SECRET is unset/);

    const down = new OidcSettings({
      db: fakeDb({ value: { issuer: ISSUER, clientId: 'shipyard', clientSecret: null }, updatedAt: new Date(0) }),
      logger,
      config: loadConfig(BASE),
      build: () => Promise.resolve(null),
    });
    await down.load();
    expect(down.current()).toBeNull();
    expect(down.state()).toMatchObject({ source: 'settings', reachable: false });

    const noDb = new OidcSettings({ db: fakeDb(new Error('relation "setting" does not exist')), logger, config: loadConfig(BASE) });
    await expect(noDb.load()).resolves.toBeUndefined();
    expect(noDb.current()).toBeNull();
  });

  it('lets the later of two overlapping loads win', async () => {
    let release: (c: OidcClient | null) => void = () => undefined;
    const builds = [
      new Promise<OidcClient | null>((resolve) => {
        release = resolve;
      }),
      Promise.resolve(stubClient('https://second.example.com')),
    ];
    let n = 0;
    const settings = new OidcSettings({
      db: fakeDb({ value: { issuer: ISSUER, clientId: 'shipyard', clientSecret: null }, updatedAt: new Date(0) }),
      logger,
      config: loadConfig(BASE),
      build: () => builds[n++] ?? Promise.resolve(null),
    });
    const first = settings.load();
    await settings.load();
    release(stubClient('https://first.example.com'));
    await first;
    expect(settings.current()?.issuer).toBe('https://second.example.com');
  });
});
