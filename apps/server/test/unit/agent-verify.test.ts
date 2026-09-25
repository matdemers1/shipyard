import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { Request, Response } from 'express';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { fingerprintOf, signingString } from '@shipyard/schema';
import { verifyAgentRequest } from '../../src/agent/verify.js';
import type { ServiceDeps } from '../../src/deps.js';
import { Bus } from '../../src/events.js';

function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  return { privateKey, raw, b64: raw.toString('base64'), fingerprint: fingerprintOf(raw) };
}

function fakeDeps(agent: { id: string; publicKey: string; confirmedAt: Date | null } | null) {
  const findUnique = vi.fn(() => Promise.resolve(agent));
  const executeRaw = vi.fn(() => Promise.resolve(1));
  const db = { agent: { findUnique }, $executeRaw: executeRaw, agentNonce: { deleteMany: vi.fn(() => Promise.resolve({ count: 0 })) } };
  const deps = { db, logger: pino({ enabled: false }), config: {}, bus: new Bus() } as unknown as ServiceDeps;
  return { deps, findUnique, executeRaw };
}

async function invoke(deps: ServiceDeps, headers: Record<string, string>, body = '') {
  const req = {
    method: 'POST',
    originalUrl: '/api/agent/poll',
    headers,
    body: body === '' ? undefined : (JSON.parse(body) as unknown),
    rawBody: Buffer.from(body),
  } as unknown as Request;
  let status: number | undefined;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  const next = vi.fn();
  await verifyAgentRequest(deps)(req, res, next);
  return { status, nextCalled: next.mock.calls.length > 0, req };
}

function headersFor(key: ReturnType<typeof makeKey>, body: string, now = Date.now(), signer = key) {
  const timestamp = String(now);
  const nonce = randomBytes(16).toString('base64url');
  const data = signingString({ method: 'POST', path: '/api/agent/poll', timestamp, nonce, body: Buffer.from(body) });
  return {
    'x-shipyard-key': key.fingerprint,
    'x-shipyard-timestamp': timestamp,
    'x-shipyard-nonce': nonce,
    'x-shipyard-signature': sign(null, Buffer.from(data), signer.privateKey).toString('base64'),
  };
}

describe('verifyAgentRequest ordering', () => {
  it('rejects missing headers without touching the database', async () => {
    const { deps, findUnique, executeRaw } = fakeDeps(null);
    const r = await invoke(deps, {});
    expect(r.status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('rejects a stale timestamp without touching the database', async () => {
    const key = makeKey();
    const { deps, findUnique, executeRaw } = fakeDeps(null);
    const r = await invoke(deps, headersFor(key, '{}', Date.now() - 6 * 60 * 1000), '{}');
    expect(r.status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('rejects a bad signature before recording the nonce', async () => {
    const key = makeKey();
    const { deps, findUnique, executeRaw } = fakeDeps({ id: 'a1', publicKey: key.b64, confirmedAt: new Date() });
    const r = await invoke(deps, headersFor(key, '{}', Date.now(), makeKey()), '{}');
    expect(r.status).toBe(401);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('records the nonce and calls next for a good signature', async () => {
    const key = makeKey();
    const { deps, executeRaw } = fakeDeps({ id: 'a1', publicKey: key.b64, confirmedAt: new Date() });
    const r = await invoke(deps, headersFor(key, '{}'), '{}');
    expect(r.status).toBeUndefined();
    expect(r.nextCalled).toBe(true);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(r.req.agent).toEqual({ id: 'a1', fingerprint: key.fingerprint, publicKeyB64: key.b64, confirmed: true });
  });

  it('treats a nonce that inserts nothing as a replay', async () => {
    const key = makeKey();
    const { deps, executeRaw } = fakeDeps({ id: 'a1', publicKey: key.b64, confirmedAt: new Date() });
    executeRaw.mockResolvedValueOnce(0);
    const r = await invoke(deps, headersFor(key, '{}'), '{}');
    expect(r.status).toBe(401);
    expect(r.nextCalled).toBe(false);
  });
});
