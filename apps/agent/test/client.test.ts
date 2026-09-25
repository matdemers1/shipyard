import { createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signingString } from '@shipyard/schema';
import { AgentRequestError, createAgentClient, type FetchLike } from '../src/client.js';
import { loadOrCreateIdentity, type AgentIdentity } from '../src/identity.js';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

let root: string;
let identity: AgentIdentity;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'shipyard-client-'));
  identity = await loadOrCreateIdentity(root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

function recorder(status: number, responseBody: string): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = (input, init) => {
    const body = init.body;
    calls.push({
      url: input,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: body instanceof Uint8Array ? body : new Uint8Array(0),
    });
    return Promise.resolve(new Response(responseBody, { status, headers: { 'content-type': 'application/json' } }));
  };
  return { fetch, calls };
}

function signatureVerifies(c: Captured, path: string): boolean {
  const data = signingString({
    method: c.method,
    path,
    timestamp: c.headers['x-shipyard-timestamp'] ?? '',
    nonce: c.headers['x-shipyard-nonce'] ?? '',
    body: c.body,
  });
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, identity.publicKeyRaw]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(data, 'utf8'), key, Buffer.from(c.headers['x-shipyard-signature'] ?? '', 'base64'));
}

describe('createAgentClient', () => {
  it('signs exactly the bytes it sends, and returns the parsed JSON', async () => {
    const { fetch, calls } = recorder(200, '{"target":null}');
    const client = createAgentClient({ serverUrl: 'https://shipyard.example', identity, fetch, timeoutMs: 1000 });

    const body = { waitSeconds: 25, note: 'ünïcode ✓' };
    await expect(client.request('post', '/api/agent/poll?x=1', body)).resolves.toEqual({ target: null });

    expect(calls).toHaveLength(1);
    const c = calls[0];
    if (c === undefined) throw new Error('no call');
    expect(c.url).toBe('https://shipyard.example/api/agent/poll?x=1');
    expect(c.method).toBe('POST');
    expect(c.headers['content-type']).toBe('application/json');
    expect(Buffer.from(c.body).toString('utf8')).toBe(JSON.stringify(body));
    expect(c.headers['x-shipyard-key']).toBe(identity.fingerprint);
    expect(signatureVerifies(c, '/api/agent/poll?x=1')).toBe(true);

    // Any other bytes do not verify under the same headers.
    expect(signatureVerifies({ ...c, body: Buffer.from(JSON.stringify({ waitSeconds: 0 })) }, '/api/agent/poll?x=1')).toBe(false);
  });

  it('signs an empty body for a bodiless request', async () => {
    const { fetch, calls } = recorder(200, '{}');
    const client = createAgentClient({ serverUrl: 'https://shipyard.example', identity, fetch, timeoutMs: 1000 });
    await client.request('GET', '/api/agent/ping');
    const c = calls[0];
    if (c === undefined) throw new Error('no call');
    expect(c.body).toHaveLength(0);
    expect(signatureVerifies(c, '/api/agent/ping')).toBe(true);
  });

  it('throws a typed error carrying the refusal when the server refuses', async () => {
    const refusal = { code: 'not_enrolled', gate: 'none', message: 'not confirmed', fix: 'Confirm it.' };
    const { fetch } = recorder(403, JSON.stringify({ error: refusal }));
    const client = createAgentClient({ serverUrl: 'https://shipyard.example', identity, fetch, timeoutMs: 1000 });

    const err: unknown = await client.request('POST', '/api/agent/report', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRequestError);
    expect((err as AgentRequestError).status).toBe(403);
    expect((err as AgentRequestError).refusal).toEqual(refusal);
  });

  it('throws with a null refusal when the error body is not an envelope', async () => {
    const { fetch } = recorder(502, 'bad gateway');
    const client = createAgentClient({ serverUrl: 'https://shipyard.example', identity, fetch, timeoutMs: 1000 });
    const err: unknown = await client.request('POST', '/api/agent/poll', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRequestError);
    expect((err as AgentRequestError).refusal).toBeNull();
  });
});

describe('the agent opens no port (SHP-REQ-033)', () => {
  it('has no listener anywhere in its source', async () => {
    const dir = join(import.meta.dirname, '../src');
    const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = await readFile(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/\bcreateServer\b|\.listen\(|node:net|node:http'|node:https'|node:dgram|express/);
    }
  });
});
