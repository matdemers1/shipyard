import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import { fingerprintOf, signingString, type HostContainer, type HostInventory, type PollResponse } from '@shipyard/schema';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import type { Db, Prisma } from '../../src/db.js';

/**
 * Shared fixtures for the lifecycle action and log integration tests (SHP-T-15.4): a signing agent,
 * users and tokens, a host snapshot, and an SSE reader. Not a test file itself.
 */

export interface Key {
  privateKey: KeyObject;
  b64: string;
  fingerprint: string;
}

export function makeKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  return { privateKey, b64: raw.toString('base64'), fingerprint: fingerprintOf(raw) };
}

export function signedHeaders(key: Key, path: string, body: string): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const data = signingString({ method: 'POST', path, timestamp, nonce, body: Buffer.from(body, 'utf8') });
  return {
    'x-shipyard-key': key.fingerprint,
    'x-shipyard-timestamp': timestamp,
    'x-shipyard-nonce': nonce,
    'x-shipyard-signature': sign(null, Buffer.from(data, 'utf8'), key.privateKey).toString('base64'),
    'content-type': 'application/json',
  };
}

/** A signed agent POST. */
export async function agentPost(app: Express, key: Key, path: string, body: unknown): Promise<request.Response> {
  const text = JSON.stringify(body);
  return request(app).post(path).set(signedHeaders(key, path, text)).send(text);
}

/** One poll, advertising `capabilities` (none when undefined). */
export async function poll(app: Express, key: Key, capabilities?: ('build' | 'actions' | 'logs' | 'stack-updates' | 'maintenance')[], waitSeconds = 0): Promise<PollResponse> {
  const res = await agentPost(app, key, '/api/agent/poll', { waitSeconds, ...(capabilities === undefined ? {} : { capabilities }) });
  expect(res.status).toBe(200);
  return res.body as PollResponse;
}

export async function enrol(db: Db, key: Key): Promise<string> {
  const row = await db.agent.create({ data: { publicKey: key.b64, fingerprint: key.fingerprint, confirmedAt: new Date() } });
  return row.id;
}

export type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

export async function signIn(db: Db, role: Role): Promise<{ userId: string; email: string; cookie: string }> {
  const email = `${role}-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, email, cookie: `${SESSION_COOKIE}=${session.token}` };
}

export async function issueToken(app: Express, cookie: string, apps: string[], canReadLogs?: boolean): Promise<{ id: string; token: string }> {
  const res = await request(app)
    .post('/api/tokens')
    .set('Cookie', cookie)
    .send({ label: 'claude', apps, ...(canReadLogs === undefined ? {} : { canReadLogs }) });
  expect(res.status).toBe(201);
  return res.body as { id: string; token: string };
}

/** An app row as the agent's report writes it (only the report does so in src; tests seed directly). */
export async function seedApp(db: Db, name: string, agentId: string): Promise<string> {
  const row = await db.app.create({
    data: {
      name,
      agentId,
      manifestYaml: `name: ${name}\n`,
      manifestSha256: '0'.repeat(64),
      reportedAt: new Date(),
      services: { web: { image: `ghcr.io/matdemers1/${name}` } },
    },
  });
  return row.id;
}

export async function seedStack(db: Db, name: string, agentId: string): Promise<void> {
  await db.stack.create({
    data: { name, agentId, manifestJson: '{}', manifestSha256: '0'.repeat(64), composeProject: name, reportedAt: new Date() },
  });
}

export function hex64(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

export function container(name: string, extra: Partial<HostContainer> = {}): HostContainer {
  return {
    id: hex64(name),
    name,
    image: `${name}:latest`,
    imageId: `sha256:${hex64(`${name}-image`)}`,
    digest: null,
    state: 'running',
    health: 'none',
    restartCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    startedAt: '2026-10-01T00:00:01.000Z',
    compose: null,
    tier: 'observed',
    app: null,
    ports: [],
    mounts: [],
    stats: null,
    ...extra,
  };
}

export async function seedSnapshot(db: Db, agentId: string, containers: HostContainer[]): Promise<void> {
  const inventory: HostInventory = {
    sampledAt: '2026-10-22T12:00:00.000Z',
    containers,
    volumes: [],
    images: [],
    networks: [],
    builderCache: { bytes: 0, reclaimableBytes: 0 },
    disk: { dataRoot: { path: '/DATA', freeBytes: 10, totalBytes: 100 }, dockerRoot: null },
  };
  const now = new Date();
  await db.hostSnapshot.create({
    data: { agentId, inventory: JSON.parse(JSON.stringify(inventory)) as Prisma.InputJsonValue, sampledAt: now, reportedAt: now },
  });
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/** An SSE client over fetch against a listening server: the parsed events so far, and a way to wait for more. */
export async function openStream(server: Server, path: string, headers: Record<string, string>, controller: AbortController) {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    headers: { ...headers, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const events: SseEvent[] = [];
  const state = { ended: false };
  let buffer = '';
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    if (reader === undefined) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data !== '') events.push({ event, data: JSON.parse(data) as unknown });
          cut = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted */
    }
    state.ended = true;
  })();
  async function waitFor(pred: (e: SseEvent[]) => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!pred(events)) {
      if (Date.now() - start > ms) throw new Error(`timed out; events: ${JSON.stringify(events.map((e) => e.event))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return { res, events, waitFor, pump, isEnded: () => state.ended };
}

/** Waits until `pred` holds, polling every 10 ms. */
export async function until(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
