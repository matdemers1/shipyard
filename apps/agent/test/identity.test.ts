import { createPublicKey, verify } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, SignatureHeaders, signingString } from '@shipyard/schema';
import { InsecureKeyFileError, keyPath, loadOrCreateIdentity, signHeaders, type AgentIdentity } from '../src/identity.js';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifies(identity: AgentIdentity, data: string, sig: Buffer): boolean {
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, identity.publicKeyRaw]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(data, 'utf8'), key, sig);
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'shipyard-agent-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadOrCreateIdentity', () => {
  it('creates a PKCS8 PEM key with mode 0600 and reloads the same key', async () => {
    const first = await loadOrCreateIdentity(root);
    const path = keyPath(root);
    expect(path).toBe(join(root, 'agent', 'agent.key'));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);

    expect(first.publicKeyRaw).toHaveLength(32);
    expect(first.publicKeyB64).toBe(first.publicKeyRaw.toString('base64'));
    expect(first.fingerprint).toBe(fingerprintOf(first.publicKeyRaw));

    const second = await loadOrCreateIdentity(root);
    expect(second.publicKeyB64).toBe(first.publicKeyB64);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(verifies(first, 'hello', second.sign('hello'))).toBe(true);
  });

  it('refuses a key file readable by group or others, naming chmod 600', async () => {
    await loadOrCreateIdentity(root);
    const path = keyPath(root);
    for (const mode of [0o640, 0o604, 0o644]) {
      await chmod(path, mode);
      const err: unknown = await loadOrCreateIdentity(root).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InsecureKeyFileError);
      expect((err as InsecureKeyFileError).fix).toBe(`chmod 600 ${path}`);
    }
    // Refusing never rewrites the key.
    expect(await readdir(join(root, 'agent'))).toEqual(['agent.key']);
  });
});

describe('signHeaders', () => {
  it('returns the four headers, signed over the shared signing string', async () => {
    const identity = await loadOrCreateIdentity(root);
    const body = Buffer.from('{"waitSeconds":25}');
    const headers = signHeaders(identity, { method: 'post', path: '/api/agent/poll', body, now: 1_700_000_000_000 });

    expect(SignatureHeaders.parse(headers)).toEqual(headers);
    expect(headers['x-shipyard-key']).toBe(identity.fingerprint);
    expect(headers['x-shipyard-timestamp']).toBe('1700000000000');
    expect(headers['x-shipyard-nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const data = signingString({
      method: 'POST',
      path: '/api/agent/poll',
      timestamp: headers['x-shipyard-timestamp'],
      nonce: headers['x-shipyard-nonce'],
      body,
    });
    expect(verifies(identity, data, Buffer.from(headers['x-shipyard-signature'], 'base64'))).toBe(true);
  });

  it('uses a fresh nonce per request', async () => {
    const identity = await loadOrCreateIdentity(root);
    const a = signHeaders(identity, { method: 'GET', path: '/x', body: new Uint8Array(0) });
    const b = signHeaders(identity, { method: 'GET', path: '/x', body: new Uint8Array(0) });
    expect(a['x-shipyard-nonce']).not.toBe(b['x-shipyard-nonce']);
  });
});
