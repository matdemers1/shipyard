import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, signingString, type DeployAccepted, type DeployStatus, type PollResponse } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';

/**
 * `GET /api/deploys/:id` for a group deploy (SHP-T-5.11, SHP-REQ-078, SHP-REQ-079): the plain
 * deploy-status endpoint — the one the console's live view and SSE stream already poll — now
 * carries every member's app, state and refusal under `group`, in deploy order, alongside the
 * top-level fields that still describe the member currently in charge.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

const SHA = 'e'.repeat(40);
const DIGEST_SERVER = `sha256:${'4'.repeat(64)}`;

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

function signed(key: Key, path: string, body: string): Record<string, string> {
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

let app: Express;
let key: Key;
let agentId: string;
let cookie: string;

async function agentPost(path: string, body: unknown) {
  const text = JSON.stringify(body);
  return request(app).post(path).set(signed(key, path, text)).send(text);
}

async function poll(): Promise<PollResponse['target']> {
  const res = await agentPost('/api/agent/poll', { waitSeconds: 0 });
  expect(res.status).toBe(200);
  return (res.body as PollResponse).target;
}

function targetOf(t: PollResponse['target']): NonNullable<PollResponse['target']> {
  if (t === null) throw new Error('expected a target');
  return t;
}

async function report(targetId: string, state: string, images: { service: string; digest: string }[] = [], refusalCode?: string) {
  const res = await agentPost('/api/agent/result', {
    targetId,
    state,
    images: images.map((i) => ({ service: i.service, sha: SHA, digest: i.digest })),
    ...(refusalCode === undefined ? {} : { refusal: { code: refusalCode, gate: 'none', message: 'boom', fix: 'fix it' } }),
  });
  expect(res.status).toBe(200);
}

async function seedApp(name: string, group: string, canary = false): Promise<void> {
  await db.app.create({
    data: {
      name,
      agentId,
      manifestYaml: `name: ${name}\n`,
      manifestSha256: '0'.repeat(64),
      reportedAt: new Date(),
      services: { server: { image: `ghcr.io/matdemers1/${name}/server` } },
      groupName: group,
      canary,
    },
  });
}

async function deployStatus(deployId: string): Promise<DeployStatus> {
  const res = await request(app).get(`/api/deploys/${deployId}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as DeployStatus;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "freeze", "approval", "backup_artifact", "outbox", "drift_event", "target_image", "step", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  key = makeKey();
  const agent = await db.agent.create({ data: { publicKey: key.b64, fingerprint: key.fingerprint, confirmedAt: new Date() } });
  agentId = agent.id;
  app = createApp({ db, logger, config, bus: new Bus() });
  const user = await db.user.create({ data: { email: `deployer-${randomUUID()}@example.com`, displayName: 'deployer', role: 'deployer' } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  cookie = `${SESSION_COOKIE}=${session.token}`;
  await seedApp('alpha', 'trio');
  await seedApp('bravo', 'trio');
  await seedApp('charlie', 'trio');
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/deploys/:id for a group deploy (SHP-T-5.11)', () => {
  it('carries every member while the first is still running, describing that member at the top level', async () => {
    const created = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', group: 'trio', sha: SHA });
    expect(created.status).toBe(201);
    const { deployId } = created.body as DeployAccepted;

    const status = await deployStatus(deployId);
    expect(status.app).toBe('alpha');
    expect(status.state).toBe('locked');
    expect(status.group).toBeDefined();
    expect(status.group?.name).toBe('trio');
    expect(status.group?.members.map((m) => [m.app, m.state, m.canary, m.position])).toEqual([
      ['alpha', 'locked', false, 0],
      ['bravo', 'locked', false, 1],
      ['charlie', 'locked', false, 2],
    ]);
    expect(status.group?.members.every((m) => m.refusal === null)).toBe(true);
  });

  it('once the group stops, the top level describes the member that failed it, and the stopped member carries group_stopped', async () => {
    const created = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', group: 'trio', sha: SHA });
    const { deployId } = created.body as DeployAccepted;

    const first = targetOf(await poll());
    expect(first.app).toBe('alpha');
    await report(first.targetId, 'succeeded', [{ service: 'server', digest: DIGEST_SERVER }]);

    const second = targetOf(await poll());
    expect(second.app).toBe('bravo');
    await report(second.targetId, 'failed', [], 'health_failed');
    expect(await poll()).toBeNull();

    const status = await deployStatus(deployId);
    // Every member is terminal now; the top level describes bravo (the one that actually failed),
    // not charlie (cancelled without ever running).
    expect(status.app).toBe('bravo');
    expect(status.state).toBe('failed');
    expect(status.refusal?.code).toBe('health_failed');

    expect(status.group?.members.map((m) => [m.app, m.state])).toEqual([
      ['alpha', 'succeeded'],
      ['bravo', 'failed'],
      ['charlie', 'cancelled'],
    ]);
    const charlie = status.group?.members[2];
    expect(charlie?.refusal?.code).toBe('group_stopped');
    expect(charlie?.refusal?.message).toContain('bravo');
    expect(status.group?.members[0]?.refusal).toBeNull();
  });

  it('is absent for a single-app deploy', async () => {
    await db.app.create({
      data: {
        name: 'solo',
        agentId,
        manifestYaml: 'name: solo\n',
        manifestSha256: '0'.repeat(64),
        reportedAt: new Date(),
        services: { server: { image: 'ghcr.io/matdemers1/solo/server' } },
      },
    });
    const created = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'solo', sha: SHA });
    expect(created.status).toBe(201);
    const status = await deployStatus((created.body as DeployAccepted).deployId);
    expect(status.group).toBeUndefined();
  });
});
