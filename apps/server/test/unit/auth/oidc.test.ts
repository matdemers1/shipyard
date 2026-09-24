import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { PendingSignIns, createOidcClient } from '../../../src/auth/oidc.js';
import { loadConfig } from '../../../src/config.js';

describe('createOidcClient', () => {
  it('returns null without throwing when the issuer is unreachable', async () => {
    const warnings: unknown[] = [];
    const logger = pino({ level: 'warn' }, { write: (line: string) => warnings.push(JSON.parse(line)) });
    const config = loadConfig({
      DATABASE_URL: 'postgresql://x/y',
      PUBLIC_URL: 'http://localhost:3300',
      D3AUTH_ISSUER: 'http://127.0.0.1:9/',
      D3AUTH_CLIENT_ID: 'shipyard',
      D3AUTH_CLIENT_SECRET: 'secret',
    });
    await expect(createOidcClient(config, logger)).resolves.toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('returns null when OIDC is not configured', async () => {
    await expect(createOidcClient(loadConfig({ DATABASE_URL: 'postgresql://x/y' }))).resolves.toBeNull();
  });
});

describe('PendingSignIns', () => {
  it('is single use and refuses unknown or expired transactions', () => {
    const pending = new PendingSignIns<{ expiresAt: number }>();
    const tx = pending.put({ expiresAt: Date.now() + 60_000 });
    expect(() => pending.take(tx)).not.toThrow();
    expect(() => pending.take(tx)).toThrow(/No sign-in/);
    expect(() => pending.take('unknown')).toThrow(/No sign-in/);
    const old = pending.put({ expiresAt: Date.now() + 60_000 });
    expect(() => pending.take(old, Date.now() + 120_000)).toThrow(/too long/);
  });
});
