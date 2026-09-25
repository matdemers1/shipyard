import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { Router, type Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, SIGNATURE_WINDOW_MS, signingString } from '@shipyard/schema';
import { verifyAgentRequest } from '../../src/agent/verify.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl });

interface Key {
  privateKey: KeyObject;
  raw: Buffer;
  b64: string;
  fingerprint: string;
}

function makeKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  return { privateKey, raw, b64: raw.toString('base64'), fingerprint: fingerprintOf(raw) };
}

interface SignOpts {
  method: string;
  path: string;
  body?: string;
  now?: number;
  nonce?: string;
  /** Sign with this key, while claiming `key`'s fingerprint. */
  signer?: Key;
}

function signed(key: Key, o: SignOpts): Record<string, string> {
  const timestamp = String(o.now ?? Date.now());
  const nonce = o.nonce ?? randomBytes(16).toString('base64url');
  const data = signingString({
    method: o.method,
    path: o.path,
    timestamp,
    nonce,
    body: Buffer.from(o.body ?? '', 'utf8'),
  });
  const sig = sign(null, Buffer.from(data, 'utf8'), (o.signer ?? key).privateKey);
  return {
    'x-shipyard-key': key.fingerprint,
    'x-shipyard-timestamp': timestamp,
    'x-shipyard-nonce': nonce,
    'x-shipyard-signature': sig.toString('base64'),
  };
}

function buildApp(): Express {
  const logger = pino({ enabled: false });
  const deps = { db, logger, config, bus: new Bus() };
  const testRouter = Router();
  const echo = (req: import('express').Request, res: import('express').Response): void => {
    res.status(200).json({ agent: req.agent, actor: req.actor });
  };
  testRouter.all('/agent', verifyAgentRequest(deps), echo);
  testRouter.all('/agent-other', verifyAgentRequest(deps), echo);
  testRouter.all('/agent-unconfirmed', verifyAgentRequest(deps, { allowUnconfirmed: true }), echo);
  testRouter.all('/agent-enrol', verifyAgentRequest(deps, { enrolment: true, allowUnconfirmed: true }), echo);
  return createApp({ db, logger, config, testRouter });
}

async function enrol(key: Key, confirmed = true): Promise<string> {
  const agent = await db.agent.create({
    data: {
      publicKey: key.b64,
      fingerprint: key.fingerprint,
      ...(confirmed ? { confirmedAt: new Date() } : {}),
    },
  });
  return agent.id;
}

function post(app: Express, path: string, headers: Record<string, string>, body: string) {
  return request(app).post(path).set(headers).set('content-type', 'application/json').send(body);
}

interface Echo {
  agent?: { id: string | null; fingerprint: string; publicKeyB64: string; confirmed: boolean };
  actor?: { type: string; id?: string; label: string };
  error?: { code: string; message: string };
}
const b = (r: { body: unknown }): Echo => r.body as Echo;

const PATH = '/api/_test/agent';
const BODY = JSON.stringify({ waitSeconds: 25 });

beforeEach(async () => {
  await db.$executeRawUnsafe('truncate table "agent_nonce", "agent" cascade');
});

afterAll(async () => {
  await db.$disconnect();
});

describe('verifyAgentRequest', () => {
  it('passes a valid signed request and sets req.agent and req.actor', async () => {
    const key = makeKey();
    const id = await enrol(key);
    const app = buildApp();

    const res = await post(app, PATH, signed(key, { method: 'POST', path: PATH, body: BODY }), BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      agent: { id, fingerprint: key.fingerprint, publicKeyB64: key.b64, confirmed: true },
      actor: { type: 'agent', id, label: `agent ${key.fingerprint.slice(0, 15)}` },
    });
    expect(await db.agentNonce.count({ where: { fingerprint: key.fingerprint } })).toBe(1);
  });

  it('passes a signed GET with no body and a query string', async () => {
    const key = makeKey();
    await enrol(key);
    const path = `${PATH}?wait=25`;
    const res = await request(buildApp()).get(path).set(signed(key, { method: 'GET', path }));
    expect(res.status).toBe(200);
  });

  it('rejects a tampered body', async () => {
    const key = makeKey();
    await enrol(key);
    const headers = signed(key, { method: 'POST', path: PATH, body: BODY });
    const res = await post(buildApp(), PATH, headers, JSON.stringify({ waitSeconds: 0 }));
    expect(res.status).toBe(401);
    expect(b(res).error?.code).toBe('unauthenticated');
    // Junk never reaches the nonce table.
    expect(await db.agentNonce.count()).toBe(0);
  });

  it('rejects a body re-encoded with the same meaning but different bytes', async () => {
    const key = makeKey();
    await enrol(key);
    const headers = signed(key, { method: 'POST', path: PATH, body: BODY });
    const res = await post(buildApp(), PATH, headers, '{ "waitSeconds": 25 }');
    expect(res.status).toBe(401);
  });

  it('rejects a tampered path', async () => {
    const key = makeKey();
    await enrol(key);
    const headers = signed(key, { method: 'POST', path: PATH, body: BODY });
    const res = await post(buildApp(), '/api/_test/agent-other', headers, BODY);
    expect(res.status).toBe(401);
  });

  it('rejects a tampered query string', async () => {
    const key = makeKey();
    await enrol(key);
    const headers = signed(key, { method: 'GET', path: `${PATH}?wait=25` });
    const res = await request(buildApp()).get(`${PATH}?wait=0`).set(headers);
    expect(res.status).toBe(401);
  });

  it('rejects a tampered method', async () => {
    const key = makeKey();
    await enrol(key);
    const headers = signed(key, { method: 'PUT', path: PATH, body: BODY });
    const res = await post(buildApp(), PATH, headers, BODY);
    expect(res.status).toBe(401);
  });

  it('rejects a signature made with a different key', async () => {
    const key = makeKey();
    await enrol(key);
    const headers = signed(key, { method: 'POST', path: PATH, body: BODY, signer: makeKey() });
    const res = await post(buildApp(), PATH, headers, BODY);
    expect(res.status).toBe(401);
  });

  it('rejects a timestamp six minutes old and six minutes ahead', async () => {
    const key = makeKey();
    await enrol(key);
    const app = buildApp();
    for (const offset of [-6 * 60 * 1000, 6 * 60 * 1000]) {
      const headers = signed(key, { method: 'POST', path: PATH, body: BODY, now: Date.now() + offset });
      const res = await post(app, PATH, headers, BODY);
      expect(res.status, `offset ${offset}`).toBe(401);
      expect(b(res).error?.message).toMatch(/five minutes/);
    }
    // Inside the window is fine.
    const ok = signed(key, { method: 'POST', path: PATH, body: BODY, now: Date.now() - SIGNATURE_WINDOW_MS + 30_000 });
    expect((await post(app, PATH, ok, BODY)).status).toBe(200);
  });

  it('rejects a replayed request', async () => {
    const key = makeKey();
    await enrol(key);
    const app = buildApp();
    const headers = signed(key, { method: 'POST', path: PATH, body: BODY });
    expect((await post(app, PATH, headers, BODY)).status).toBe(200);
    const replay = await post(app, PATH, headers, BODY);
    expect(replay.status).toBe(401);
    expect(b(replay).error?.message).toMatch(/nonce/);
  });

  it('rejects an unknown fingerprint', async () => {
    const key = makeKey();
    const res = await post(buildApp(), PATH, signed(key, { method: 'POST', path: PATH, body: BODY }), BODY);
    expect(res.status).toBe(401);
    expect(b(res).error?.code).toBe('unauthenticated');
  });

  it('rejects missing and malformed headers', async () => {
    const key = makeKey();
    await enrol(key);
    const app = buildApp();
    expect((await post(app, PATH, {}, BODY)).status).toBe(401);
    const good = signed(key, { method: 'POST', path: PATH, body: BODY });
    for (const [name, value] of [
      ['x-shipyard-nonce', 'short'],
      ['x-shipyard-timestamp', 'yesterday'],
      ['x-shipyard-signature', 'not base64!'],
      ['x-shipyard-signature', Buffer.alloc(10).toString('base64')],
    ] as const) {
      const res = await post(app, PATH, { ...good, [name]: value }, BODY);
      expect(res.status, `${name}=${value}`).toBe(401);
    }
  });

  it('refuses an unconfirmed agent with 403 not_enrolled, unless the route allows it', async () => {
    const key = makeKey();
    const id = await enrol(key, false);
    const app = buildApp();

    const res = await post(app, PATH, signed(key, { method: 'POST', path: PATH, body: BODY }), BODY);
    expect(res.status).toBe(403);
    expect(b(res).error?.code).toBe('not_enrolled');

    const path = '/api/_test/agent-unconfirmed';
    const ok = await post(app, path, signed(key, { method: 'POST', path, body: BODY }), BODY);
    expect(ok.status).toBe(200);
    expect(b(ok).agent).toEqual({ id, fingerprint: key.fingerprint, publicKeyB64: key.b64, confirmed: false });
  });

  describe('enrolment mode', () => {
    const path = '/api/_test/agent-enrol';

    it('accepts the key from the body when its fingerprint matches the header', async () => {
      const key = makeKey();
      const body = JSON.stringify({ publicKey: key.b64, agentVersion: '0.1.0' });
      const res = await post(buildApp(), path, signed(key, { method: 'POST', path, body }), body);
      expect(res.status).toBe(200);
      expect(b(res).agent).toEqual({ id: null, fingerprint: key.fingerprint, publicKeyB64: key.b64, confirmed: false });
      expect(b(res).actor).toEqual({ type: 'agent', label: `agent ${key.fingerprint.slice(0, 15)}` });
    });

    it('rejects a body key whose fingerprint does not match the header', async () => {
      const key = makeKey();
      const other = makeKey();
      // Signed by `other`, offering `other`'s key, but claiming `key`'s fingerprint.
      const body = JSON.stringify({ publicKey: other.b64, agentVersion: '0.1.0' });
      const res = await post(buildApp(), path, signed(key, { method: 'POST', path, body, signer: other }), body);
      expect(res.status).toBe(401);
    });

    it('rejects a matching body key when the signature is not by that key', async () => {
      const key = makeKey();
      const body = JSON.stringify({ publicKey: key.b64, agentVersion: '0.1.0' });
      const res = await post(buildApp(), path, signed(key, { method: 'POST', path, body, signer: makeKey() }), body);
      expect(res.status).toBe(401);
    });

    it('rejects a missing or malformed body key', async () => {
      const key = makeKey();
      const app = buildApp();
      for (const body of [JSON.stringify({ agentVersion: '0.1.0' }), JSON.stringify({ publicKey: 'abc' })]) {
        const res = await post(app, path, signed(key, { method: 'POST', path, body }), body);
        expect(res.status).toBe(401);
      }
    });

    it('uses the enrolled key, not the body, once the agent row exists', async () => {
      const key = makeKey();
      const id = await enrol(key, false);
      const other = makeKey();
      const body = JSON.stringify({ publicKey: other.b64, agentVersion: '0.1.0' });
      const app = buildApp();
      const forged = await post(app, path, signed(key, { method: 'POST', path, body, signer: other }), body);
      expect(forged.status).toBe(401);
      const real = await post(app, path, signed(key, { method: 'POST', path, body }), body);
      expect(real.status).toBe(200);
      expect(b(real).agent?.id).toBe(id);
    });
  });
});
