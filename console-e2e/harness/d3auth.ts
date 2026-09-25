import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from '@playwright/test';
import { BASE_URL, storageStateFor } from './env.js';

/**
 * Settings → Sign in with D3 Auth (SHP-T-6.8) needs an issuer that answers OpenID discovery. This is
 * one, on loopback (plain http is allowed only for localhost): it serves a discovery document and
 * nothing else, so the server can build a real client against it. No one ever signs in through it.
 */
export interface FakeIssuer {
  issuer: string;
  close: () => Promise<void>;
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  let issuer = '';
  const server: Server = createServer((req, res) => {
    if (req.url !== '/.well-known/openid-configuration') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    issuer,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Clears the D3 Auth setting through the API as the admin — the only way to swap the server's live
 * client back to "none" (a TRUNCATE would leave the in-memory client as it was).
 */
export async function clearD3AuthSetting(): Promise<void> {
  const api = await request.newContext({ baseURL: BASE_URL, storageState: storageStateFor('admin') });
  try {
    const res = await api.delete('/api/settings/d3auth');
    if (!res.ok()) throw new Error(`clearing the D3 Auth setting failed: HTTP ${String(res.status())} ${await res.text()}`);
  } finally {
    await api.dispose();
  }
}
