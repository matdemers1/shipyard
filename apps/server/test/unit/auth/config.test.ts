import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';

const base = { DATABASE_URL: 'postgresql://x/y' };

describe('OIDC config', () => {
  it('treats blank values (as .env.example ships them) as unset', () => {
    const config = loadConfig({ ...base, D3AUTH_ISSUER: '', D3AUTH_CLIENT_ID: '', D3AUTH_CLIENT_SECRET: '', SESSION_SECRET: '', PUBLIC_URL: '' });
    expect(config.D3AUTH_ISSUER).toBeUndefined();
    expect(config.SESSION_SECRET).toBeUndefined();
    expect(config.PUBLIC_URL).toBeUndefined();
    expect(config.oidcConfigured).toBe(false);
  });

  it('is configured with an issuer, a client ID and a public URL', () => {
    const config = loadConfig({
      ...base,
      PUBLIC_URL: 'https://shipyard.example',
      D3AUTH_ISSUER: 'https://auth.example',
      D3AUTH_CLIENT_ID: 'shipyard',
      D3AUTH_CLIENT_SECRET: 's',
    });
    expect(config.oidcConfigured).toBe(true);
    expect(loadConfig({ ...base, D3AUTH_ISSUER: 'https://auth.example', D3AUTH_CLIENT_ID: 'shipyard' }).oidcConfigured).toBe(false);
  });
});
