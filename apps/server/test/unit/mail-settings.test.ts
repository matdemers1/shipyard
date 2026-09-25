import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import type { Db } from '../../src/db.js';
import { createMailer, postToRelay } from '../../src/mail/index.js';
import { MAIL_SETTING_KEY, envOwnsMail, liveRelay, resolveMail } from '../../src/mail/settings.js';
import { deriveSettingsKey, encryptSecret } from '../../src/settings/crypto.js';

/** Settings → Alert email (SHP-T-6.9, SHP-REQ-093): the live relay resolution and the relay POST. */

const logger = pino({ enabled: false });
const SESSION_SECRET = 'unit-session-secret';
const TOKEN = 'relay-token-plaintext';

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: 'postgresql://x/y', SESSION_SECRET, ...overrides });
}

/** A `db` whose `setting` table holds at most the one row given (or throws). */
function dbWith(row: { value: unknown; updatedAt?: Date } | null | Error): { db: Db; reads: () => number } {
  let reads = 0;
  const findUnique = vi.fn(({ where }: { where: { key: string } }) => {
    reads += 1;
    if (row instanceof Error) return Promise.reject(row);
    expect(where.key).toBe(MAIL_SETTING_KEY);
    return Promise.resolve(row === null ? null : { value: row.value, updatedAt: row.updatedAt ?? new Date('2026-09-25T12:00:00Z') });
  });
  return { db: { setting: { findUnique } } as unknown as Db, reads: () => reads };
}

const sealed = (token: string, secret = SESSION_SECRET) => encryptSecret(token, deriveSettingsKey(secret));

describe('resolveMail', () => {
  it('is off with nothing in server.env and nothing saved', async () => {
    const state = await resolveMail({ db: dbWith(null).db, config: config(), logger });
    expect(state).toMatchObject({ source: 'none', relay: null, problem: null });
  });

  it('uses the saved setting, decrypting the token', async () => {
    const { db } = dbWith({ value: { relayUrl: 'https://relay.example/send', token: sealed(TOKEN), alertTo: 'ops@example.com' } });
    const state = await resolveMail({ db, config: config(), logger });
    expect(state.source).toBe('settings');
    expect(state.tokenSet).toBe(true);
    expect(state.relay).toEqual({ url: 'https://relay.example/send', token: TOKEN, to: 'ops@example.com' });
  });

  it('server.env wins, whatever is saved — and never reads the table', async () => {
    const { db, reads } = dbWith({ value: { relayUrl: 'https://saved.example/send', token: sealed(TOKEN), alertTo: 'saved@example.com' } });
    const env = config({ MAIL_RELAY_URL: 'https://env.example/send', MAIL_RELAY_TOKEN: 'env-token', ALERT_TO: 'env@example.com' });
    expect(envOwnsMail(env)).toBe(true);
    const state = await resolveMail({ db, config: env, logger });
    expect(state.source).toBe('env');
    expect(state.relay).toEqual({ url: 'https://env.example/send', token: 'env-token', to: 'env@example.com' });
    expect(reads()).toBe(0);
  });

  it('a partial server.env still owns it, and says what is missing', async () => {
    const state = await resolveMail({ db: dbWith(null).db, config: config({ ALERT_TO: 'env@example.com' }), logger });
    expect(state).toMatchObject({ source: 'env', relay: null, alertTo: 'env@example.com', tokenSet: false });
    expect(state.problem).toMatch(/MAIL_RELAY_URL, MAIL_RELAY_TOKEN and ALERT_TO/);
  });

  it('a token sealed under another SESSION_SECRET is "not configured", never a crash', async () => {
    const { db } = dbWith({ value: { relayUrl: 'https://relay.example/send', token: sealed(TOKEN, 'old-secret'), alertTo: 'ops@example.com' } });
    const state = await resolveMail({ db, config: config(), logger });
    expect(state).toMatchObject({ source: 'settings', relay: null, tokenSet: true });
    expect(state.problem).toMatch(/SESSION_SECRET has changed/);
  });

  it('a stored token with SESSION_SECRET unset cannot be read', async () => {
    const { db } = dbWith({ value: { relayUrl: 'https://relay.example/send', token: sealed(TOKEN), alertTo: 'ops@example.com' } });
    const state = await resolveMail({ db, config: loadConfig({ DATABASE_URL: 'postgresql://x/y' }), logger });
    expect(state.relay).toBeNull();
    expect(state.problem).toMatch(/SESSION_SECRET is unset/);
  });

  it('a database that cannot be read is "not configured"', async () => {
    const state = await resolveMail({ db: dbWith(new Error('connection refused')).db, config: config(), logger });
    expect(state.relay).toBeNull();
    expect(state.problem).toMatch(/could not be read/);
  });

  it('a malformed row is ignored', async () => {
    const state = await resolveMail({ db: dbWith({ value: { nope: true } }).db, config: config(), logger });
    expect(state.source).toBe('none');
  });
});

describe('createMailer with a live relay source', () => {
  it('asks the source on every send, so a change applies to the next alert', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    let current: { url: string; token: string; to: string } | null = null;
    const mailer = createMailer(config(), logger, { fetch: fetchMock as unknown as typeof fetch, relay: () => Promise.resolve(current) });

    expect(await mailer.send({ kind: 'agent-stale', subject: 's', body: 'b' }, { repeat: true })).toEqual({
      sent: false,
      reason: 'no mail relay is configured',
    });
    current = { url: 'https://relay.example/send', token: TOKEN, to: 'ops@example.com' };
    expect((await mailer.send({ kind: 'agent-stale', subject: 's', body: 'b' }, { repeat: true })).sent).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://relay.example/send');
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toMatchObject({ to: 'ops@example.com', subject: '[Shipyard] s' });
  });

  it('a source that throws means "not configured", never a throw', async () => {
    const mailer = createMailer(config(), logger, { relay: () => Promise.reject(new Error('boom')) });
    expect((await mailer.send({ kind: 'backup-failed', subject: 's', body: 'b' })).reason).toBe('no mail relay is configured');
  });

  it('liveRelay reads the table per call', async () => {
    const { db, reads } = dbWith({ value: { relayUrl: 'https://relay.example/send', token: sealed(TOKEN), alertTo: 'ops@example.com' } });
    const source = liveRelay({ db, config: config(), logger });
    await source();
    await source();
    expect(reads()).toBe(2);
  });
});

describe('postToRelay', () => {
  const relay = { url: 'https://relay.example/send', token: TOKEN, to: 'ops@example.com' };

  it('follows no redirect and is bounded in time', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }));
    const answer = await postToRelay(relay, { subject: 's', text: 't' }, { fetch: fetchMock as unknown as typeof fetch });
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(answer).toEqual({ ok: false, status: 302 });
  });

  it("reports the relay's answer, truncated, with the token redacted", async () => {
    const body = `{"error":"unauthorized","echo":"${TOKEN}"}${'x'.repeat(1000)}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 401 }));
    const answer = await postToRelay(relay, { subject: 's', text: 't' }, { fetch: fetchMock as unknown as typeof fetch });
    expect(answer.status).toBe(401);
    expect(answer.detail).toContain('unauthorized');
    expect(answer.detail).not.toContain(TOKEN);
    expect(answer.detail?.length).toBeLessThanOrEqual(200);
  });

  it('says so when the relay does not answer in time', async () => {
    const hang = vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      }),
    );
    const answer = await postToRelay(relay, { subject: 's', text: 't' }, { fetch: hang as unknown as typeof fetch, timeoutMs: 20 });
    expect(answer.ok).toBe(false);
    expect(answer.status).toBeUndefined();
    expect(answer.detail).toMatch(/did not answer within/);
  });
});
