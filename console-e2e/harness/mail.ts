import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from '@playwright/test';
import { BASE_URL, storageStateFor } from './env.js';

/**
 * Settings → Alert email (SHP-T-6.9) needs a mail relay to post to. This is one, on loopback (plain
 * http is allowed only for localhost), speaking the D3 Auth mail-relay Worker's contract:
 * `POST {to, subject, text}` with `Authorization: Bearer <secret>`, 401 without the right secret.
 * It records what it received and delivers nothing.
 */
export interface FakeRelay {
  url: string;
  token: string;
  received: { authorization: string | undefined; body: { to?: unknown; subject?: unknown; text?: unknown } }[];
  close: () => Promise<void>;
}

export async function startFakeRelay(token: string): Promise<FakeRelay> {
  const received: FakeRelay['received'] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      let body: FakeRelay['received'][number]['body'] = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        // recorded as empty
      }
      received.push({ authorization: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/send`;
  return {
    url,
    token,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Clears the alert email setting through the API as the admin. */
export async function clearMailSetting(): Promise<void> {
  const api = await request.newContext({ baseURL: BASE_URL, storageState: storageStateFor('admin') });
  try {
    const res = await api.delete('/api/settings/mail');
    if (!res.ok()) throw new Error(`clearing the alert email setting failed: HTTP ${String(res.status())} ${await res.text()}`);
  } finally {
    await api.dispose();
  }
}
