import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fingerprintOf,
  HostResponse,
  signingString,
  type AgentReport,
  type HostContainer,
  type HostInventory,
} from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { HOST_SAMPLE_WINDOW_MS } from '../../src/host/index.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * The host inventory on the server (SHP-T-14.5, SHP-ADR-009): the agent's report stores the latest
 * snapshot and a rolling window of samples; GET /api/host reads them for every signed-in role and
 * every token and writes nothing (SHP-REQ-181); an Observed container's state change is shown on
 * the next read (SHP-REQ-180) and never recorded as drift (SHP-REQ-182).
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

interface Key {
  privateKey: KeyObject;
  b64: string;
  fingerprint: string;
}

function makeKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  return { privateKey, b64: raw.toString('base64'), fingerprint: fingerprintOf(raw) };
}

function signed(key: Key, method: string, path: string, body: string): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('base64url');
  const data = signingString({ method, path, timestamp, nonce, body: Buffer.from(body, 'utf8') });
  return {
    'x-shipyard-key': key.fingerprint,
    'x-shipyard-timestamp': timestamp,
    'x-shipyard-nonce': nonce,
    'x-shipyard-signature': sign(null, Buffer.from(data, 'utf8'), key.privateKey).toString('base64'),
  };
}

const REPORT_PATH = '/api/agent/report';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const SHA = '1'.repeat(40);

function manifest(name: string): AgentReport['apps'][number]['manifest'] {
  return {
    name,
    repo: `matdemers1/${name}`,
    defaultBranch: 'main',
    workflow: 'ci.yml',
    compose: { files: [`/data/${name}/compose.yml`], project: name },
    services: { web: { image: `ghcr.io/matdemers1/${name}` } },
    health: { service: 'web', port: 8080, path: '/health' },
    soakSeconds: 60,
    approval: 'none',
    diskFloorGb: 5,
    retainImages: 3,
  };
}

function hex(seed: string, length: number): string {
  return Buffer.from(seed.repeat(64)).toString('hex').slice(0, length);
}

function container(name: string, extra: Partial<HostContainer> = {}): HostContainer {
  return {
    id: hex(name, 64),
    name,
    image: `${name}:latest`,
    imageId: `sha256:${hex(`${name}-image`, 64)}`,
    digest: DIGEST_A,
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
    stats: { cpuPercent: 1.5, memoryBytes: 64 * 1024 * 1024, memoryLimitBytes: null },
    ...extra,
  };
}

function inventory(containers: HostContainer[]): HostInventory {
  return {
    sampledAt: new Date().toISOString(),
    containers,
    volumes: [],
    images: [],
    networks: [],
    builderCache: { bytes: 0, reclaimableBytes: 0 },
    disk: { dataRoot: { path: '/DATA', freeBytes: 10, totalBytes: 100 }, dockerRoot: null },
  };
}

/** A report naming the shipped app `web` (running its recorded digest) and, optionally, a host. */
function report(host?: HostInventory, apps: AgentReport['apps'] = [{ manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_A } }]): AgentReport {
  return { agentVersion: '0.1.0', composeVersion: '5.0.1', engineApiVersion: '1.51', patExpiresAt: null, apps, ...(host === undefined ? {} : { host }) };
}

let key: Key;
let agentId: string;
let app: Express;

async function sendText(text: string, path = REPORT_PATH) {
  return request(app).post(path).set(signed(key, 'POST', path, text)).set('content-type', 'application/json').send(text);
}

async function send(body: unknown) {
  return sendText(JSON.stringify(body));
}

async function signIn(role: Role): Promise<string> {
  const user = await db.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return `${SESSION_COOKIE}=${session.token}`;
}

/** A token scoped to one app that has nothing to do with the host. */
async function scopedToken(appName: string): Promise<string> {
  const user = await db.user.create({ data: { email: `token-${randomUUID()}@example.com`, displayName: 'token', role: 'deployer' } });
  const { token, hash, prefix } = generateToken();
  const row = await db.apiToken.create({ data: { userId: user.id, label: 'scoped token', tokenHash: hash, prefix } });
  const target = await db.app.findUniqueOrThrow({ where: { name: appName }, select: { id: true } });
  await db.apiTokenApp.create({ data: { tokenId: row.id, appId: target.id } });
  return token;
}

async function readHost(cookie: string): Promise<HostResponse> {
  const res = await request(app).get('/api/host').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return HostResponse.parse(res.body);
}

/** A succeeded deploy of `appName` whose recorded web image is `digest`, so drift can be computed. */
async function seedSucceeded(appName: string, digest: string): Promise<void> {
  const row = await db.app.findUniqueOrThrow({ where: { name: appName } });
  const deploy = await db.deploy.create({ data: { requestedSha: SHA, requesterLabel: 'user matthew' } });
  await db.deployTarget.create({
    data: {
      deployId: deploy.id,
      appId: row.id,
      state: 'succeeded',
      endedAt: new Date(),
      images: { create: [{ service: 'web', repo: `ghcr.io/matdemers1/${appName}`, sha: SHA, digest }] },
    },
  });
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "host_sample", "host_snapshot", "drift_event", "target_image", "step", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "session", "user", "app", "agent" cascade',
  );
  key = makeKey();
  agentId = (await db.agent.create({ data: { publicKey: key.b64, fingerprint: key.fingerprint, confirmedAt: new Date() } })).id;
  app = createApp({ db, logger: pino({ enabled: false }), config, bus: new Bus() });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/host (SHP-T-14.5)', () => {
  it('is empty until an agent reports an inventory', async () => {
    const cookie = await signIn('viewer');
    await send(report());
    expect(await readHost(cookie)).toEqual({ hosts: [] });
  });

  it('returns the stored snapshot to every role and to a token scoped to an unrelated app', async () => {
    const inv = inventory([container('pg'), container('web-1', { tier: 'shipped', app: 'web', stats: null })]);
    const res = await send(report(inv, [
      { manifest: manifest('web'), manifestSha256: 'a'.repeat(64), running: { web: DIGEST_A } },
      { manifest: manifest('other'), manifestSha256: 'b'.repeat(64), running: { web: DIGEST_A } },
    ]));
    expect(res.status).toBe(200);

    for (const role of ['admin', 'operator', 'deployer', 'viewer'] as const) {
      const body = await readHost(await signIn(role));
      expect(body.hosts).toHaveLength(1);
      const host = body.hosts[0];
      expect(host?.agent).toEqual({ id: agentId, fingerprint: key.fingerprint });
      expect(host?.inventory).toEqual(inv);
      expect(Object.keys(host?.samples ?? {})).toEqual(['pg']);
    }

    const token = await scopedToken('other');
    const viaToken = await request(app).get('/api/host').set('Authorization', `Bearer ${token}`);
    expect(viaToken.status).toBe(200);
    expect(HostResponse.parse(viaToken.body).hosts[0]?.inventory).toEqual(inv);
  });

  it('refuses an unauthenticated read and an agent-signed one', async () => {
    await send(report(inventory([container('pg')])));
    const anonymous = await request(app).get('/api/host');
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { error: { code: string } }).error.code).toBe('unauthenticated');

    const agentSigned = await request(app).get('/api/host').set(signed(key, 'GET', '/api/host', ''));
    expect(agentSigned.status).toBe(401);
  });

  it('has no write path: POST, PUT, PATCH and DELETE are 404 and change nothing (SHP-REQ-181)', async () => {
    await send(report(inventory([container('pg')])));
    const cookie = await signIn('admin');
    const before = await db.hostSnapshot.findMany();
    const samplesBefore = await db.hostSample.count();
    const auditBefore = await db.auditEvent.count();

    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[method]('/api/host').set('Cookie', cookie).set('content-type', 'application/json').send('{}');
      expect(res.status).toBe(404);
      expect((res.body as { error: { code: string } }).error.code).toBe('not_found');
    }

    expect(await db.hostSnapshot.findMany()).toEqual(before);
    expect(await db.hostSample.count()).toBe(samplesBefore);
    expect(await db.auditEvent.count()).toBe(auditBefore);
  });

  it('a read writes nothing', async () => {
    await send(report(inventory([container('pg')])));
    const cookie = await signIn('viewer');
    const before = await db.hostSnapshot.findMany();
    const samplesBefore = await db.hostSample.findMany({ orderBy: { at: 'asc' } });
    await readHost(cookie);
    await readHost(cookie);
    expect(await db.hostSnapshot.findMany()).toEqual(before);
    expect(await db.hostSample.findMany({ orderBy: { at: 'asc' } })).toEqual(samplesBefore);
  });
});

describe('POST /api/agent/report stores the host inventory (SHP-T-14.5)', () => {
  it('a later report without host leaves the stored snapshot as it was', async () => {
    const inv = inventory([container('pg')]);
    await send(report(inv));
    const stored = await db.hostSnapshot.findUniqueOrThrow({ where: { agentId } });

    const res = await send(report());
    expect(res.status).toBe(200);
    const after = await db.hostSnapshot.findUniqueOrThrow({ where: { agentId } });
    expect(after.reportedAt.toISOString()).toBe(stored.reportedAt.toISOString());
    expect(after.inventory).toEqual(inv);
    // The heartbeat still moved: the report itself was taken.
    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agent.lastHeartbeatAt?.getTime()).toBeGreaterThanOrEqual(stored.reportedAt.getTime());

    const body = await readHost(await signIn('viewer'));
    expect(body.hosts[0]?.reportedAt).toBe(stored.reportedAt.toISOString());
  });

  it('accumulates samples per container, oldest first, and prunes those older than the window', async () => {
    const old = await db.hostSample.create({
      data: { agentId, containerName: 'pg', at: new Date(Date.now() - HOST_SAMPLE_WINDOW_MS - 60_000), cpuPercent: 99, memoryBytes: 1n },
    });
    const recent = await db.hostSample.create({
      data: { agentId, containerName: 'pg', at: new Date(Date.now() - 60 * 60 * 1000), cpuPercent: 0.5, memoryBytes: 2n },
    });

    await send(report(inventory([container('pg', { stats: { cpuPercent: 1.5, memoryBytes: 100, memoryLimitBytes: null } }), container('cache', { stats: null })])));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await send(report(inventory([
      container('pg', { stats: { cpuPercent: 2.5, memoryBytes: 200, memoryLimitBytes: 1000 } }),
      container('cache', { stats: { cpuPercent: 0.1, memoryBytes: 300, memoryLimitBytes: null } }),
    ])));

    expect(await db.hostSample.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db.hostSample.findUnique({ where: { id: recent.id } })).not.toBeNull();

    const body = await readHost(await signIn('viewer'));
    const samples = body.hosts[0]?.samples ?? {};
    expect(samples['pg']?.map((s) => s.cpuPercent)).toEqual([0.5, 1.5, 2.5]);
    expect(samples['pg']?.map((s) => s.memoryBytes)).toEqual([2, 100, 200]);
    const times = (samples['pg'] ?? []).map((s) => Date.parse(s.at));
    expect(times).toEqual(times.toSorted((a, b) => a - b));
    expect(samples['cache']?.map((s) => s.cpuPercent)).toEqual([0.1]);
  });

  it('caps a container at 500 samples on read, keeping the newest', async () => {
    const base = Date.now() - 2 * 60 * 60 * 1000;
    await db.hostSample.createMany({
      data: Array.from({ length: 520 }, (_, i) => ({ agentId, containerName: 'pg', at: new Date(base + i * 1000), cpuPercent: i, memoryBytes: BigInt(i) })),
    });
    await send(report(inventory([container('pg', { stats: null })])));
    const samples = (await readHost(await signIn('viewer'))).hosts[0]?.samples['pg'] ?? [];
    expect(samples).toHaveLength(500);
    expect(samples[0]?.cpuPercent).toBe(20);
    expect(samples[499]?.cpuPercent).toBe(519);
  });

  it('refuses a report whose host fails validation, as any invalid report is refused, and stores nothing', async () => {
    const bad = report(inventory([{ ...container('pg'), env: ['SECRET=1'] } as unknown as HostContainer]));
    const res = await send(bad);
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid_request');
    expect(await db.hostSnapshot.count()).toBe(0);
    expect(await db.app.count()).toBe(0);
    expect((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).lastHeartbeatAt).toBeNull();
  });

  it('accepts a ~600 kB signed report, while a 300 kB body to another route is still refused', async () => {
    const many = Array.from({ length: 800 }, (_, i) => container(`c-${String(i)}`, { image: `registry.example.com/${'x'.repeat(400)}:${String(i)}`, stats: null }));
    const text = JSON.stringify(report(inventory(many)));
    expect(Buffer.byteLength(text)).toBeGreaterThan(600 * 1024);
    expect(Buffer.byteLength(text)).toBeLessThan(2 * 1024 * 1024);
    const res = await sendText(text);
    expect(res.status).toBe(200);
    const stored = await db.hostSnapshot.findUniqueOrThrow({ where: { agentId } });
    expect((stored.inventory as unknown as HostInventory).containers).toHaveLength(800);

    const big = JSON.stringify({ padding: 'x'.repeat(300 * 1024) });
    const poll = await sendText(big, '/api/agent/poll');
    expect(poll.status).toBeGreaterThanOrEqual(400);
  });
});

describe('Observed containers never drift (SHP-REQ-180, SHP-REQ-182)', () => {
  it('records no drift_event when an observed container stops and changes image, and GET /api/host shows the new state', async () => {
    await send(report(inventory([container('web-1', { tier: 'shipped', app: 'web' })])));
    await seedSucceeded('web', DIGEST_A);
    const cookie = await signIn('viewer');

    const first = await send(report(inventory([
      container('web-1', { tier: 'shipped', app: 'web' }),
      container('somebody-elses-db', { state: 'running', digest: DIGEST_B }),
    ])));
    expect(first.status).toBe(200);
    expect((first.body as { drifted: string[] }).drifted).toEqual([]);
    const webBefore = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
    expect(webBefore.driftedAt).toBeNull();
    let observed = (await readHost(cookie)).hosts[0]?.inventory.containers.find((c) => c.name === 'somebody-elses-db');
    expect(observed?.state).toBe('running');

    const second = await send(report(inventory([
      container('web-1', { tier: 'shipped', app: 'web' }),
      container('somebody-elses-db', { state: 'exited', digest: DIGEST_C, imageId: `sha256:${'e'.repeat(64)}`, startedAt: null, stats: null }),
    ])));
    expect(second.status).toBe(200);
    expect((second.body as { drifted: string[] }).drifted).toEqual([]);

    expect(await db.driftEvent.count()).toBe(0);
    const webAfter = await db.app.findUniqueOrThrow({ where: { name: 'web' } });
    expect(webAfter.driftedAt).toEqual(webBefore.driftedAt);

    observed = (await readHost(cookie)).hosts[0]?.inventory.containers.find((c) => c.name === 'somebody-elses-db');
    expect(observed).toMatchObject({ state: 'exited', digest: DIGEST_C, tier: 'observed' });
  });
});
