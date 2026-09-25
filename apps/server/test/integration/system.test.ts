import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import type { Refusal, SystemStatus } from '@shipyard/schema';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { Bus } from '../../src/events.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * GET /api/system (SHP-T-6.5, SHP-REQ-094/095/106) — deployer-only; versions, the agent's
 * heartbeat/PAT status, the Foreman outbox backlog, and Shipyard's own last backup and drill.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret', SHIPYARD_VERSION: 'sha-test123', HEARTBEAT_STALE_MINUTES: '5' });
const logger = pino({ enabled: false });

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

let bus: Bus;
let app: Express;

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

async function signIn(role: Role): Promise<{ cookie: string }> {
  const email = `${role}-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { cookie: `${SESSION_COOKIE}=${session.token}` };
}

async function tokenFor(role: Role): Promise<string> {
  const user = await db.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role } });
  const { token, hash, prefix } = generateToken();
  await db.apiToken.create({ data: { userId: user.id, label: 'test token', tokenHash: hash, prefix } });
  return token;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "outbox", "target_image", "step", "drift_event", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  bus = new Bus();
  const deps: ServiceDeps = { db, logger, config, bus };
  app = createApp(deps);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/system', () => {
  it('is refused for a viewer', async () => {
    const { cookie } = await signIn('viewer');
    const res = await request(app).get('/api/system').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(err(res).code).toBe('forbidden');
  });

  it('is refused for a token', async () => {
    const token = await tokenFor('deployer');
    const res = await request(app).get('/api/system').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('is refused when unauthenticated', async () => {
    const res = await request(app).get('/api/system');
    expect(res.status).toBe(401);
  });

  it('reports no agent, an empty outbox and no backups when nothing has happened yet', async () => {
    const { cookie } = await signIn('deployer');
    const res = await request(app).get('/api/system').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as SystemStatus;
    expect(body.versions.server).toBe('sha-test123');
    expect(body.agent).toBeNull();
    expect(body.outbox).toEqual({ unsent: 0, unsentOverHour: 0, oldestUnsentAt: null, lastError: null });
    expect(body.backups).toEqual({ lastBackup: null, lastDrill: null });
  });

  it('shows the confirmed agent, stale after the threshold, with its PAT warning', async () => {
    const { cookie } = await signIn('deployer');
    await db.agent.create({
      data: {
        publicKey: 'key',
        fingerprint: `fp-${randomUUID()}`,
        confirmedAt: new Date(),
        lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago, threshold is 5
        agentVersion: '1.0.0',
        composeVersion: '5.0.0',
        engineApiVersion: '1.44',
        patExpiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), // 10 days: expiring soon
      },
    });

    const res = await request(app).get('/api/system').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as SystemStatus;
    expect(body.agent?.stale).toBe(true);
    expect(body.agent?.patWarning).toBe('expiring');
    expect(body.versions.agent).toBe('1.0.0');
  });

  it('reports "expired" for a PAT already past its expiry, and "none" for a fresh one', async () => {
    const { cookie } = await signIn('deployer');
    await db.agent.create({
      data: {
        publicKey: 'key',
        fingerprint: `fp-${randomUUID()}`,
        confirmedAt: new Date(),
        lastHeartbeatAt: new Date(),
        patExpiresAt: new Date(Date.now() - 60 * 1000),
      },
    });
    const res = await request(app).get('/api/system').set('Cookie', cookie);
    expect((res.body as SystemStatus).agent?.patWarning).toBe('expired');
    expect((res.body as SystemStatus).agent?.stale).toBe(false);
  });

  it('counts unsent deploys, not rows, and flags those unsent for over an hour (SHP-REQ-095)', async () => {
    const { cookie } = await signIn('deployer');
    const agent = await db.agent.create({ data: { publicKey: 'key', fingerprint: `fp-${randomUUID()}` } });
    const appRow = await db.app.create({
      data: { name: 'web', agentId: agent.id, manifestYaml: 'name: web\n', manifestSha256: '0'.repeat(64) },
    });
    const target = async () => {
      const deploy = await db.deploy.create({ data: { requestedSha: 'a'.repeat(40), requesterLabel: 'test' } });
      return (await db.deployTarget.create({ data: { deployId: deploy.id, appId: appRow.id, state: 'succeeded' } })).id;
    };
    const stuck = await target();
    const recent = await target();
    const done = await target();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    // One stuck deploy of a two-image app: two rows, one deploy.
    for (const service of ['server', 'worker']) {
      await db.outbox.create({
        data: { targetId: stuck, idempotencyKey: `${stuck}:${service}`, payload: {}, createdAt: twoHoursAgo, lastError: 'connection refused' },
      });
    }
    await db.outbox.create({ data: { targetId: recent, idempotencyKey: `${recent}:server`, payload: {}, createdAt: new Date() } });
    await db.outbox.create({ data: { targetId: done, idempotencyKey: `${done}:server`, payload: {}, deliveredAt: new Date() } });

    const res = await request(app).get('/api/system').set('Cookie', cookie);
    const body = res.body as SystemStatus;
    expect(body.outbox.unsent).toBe(2);
    expect(body.outbox.unsentOverHour).toBe(1);
    expect(body.outbox.lastError).toBe('connection refused');
  });

  it('reads Shipyard\'s own last backup and drill from the newest audit events', async () => {
    const { cookie } = await signIn('deployer');
    await db.auditEvent.create({
      data: {
        at: new Date('2026-09-24T03:00:00.000Z'),
        actorType: 'system',
        actorLabel: 'backup',
        action: 'system.backup',
        entityType: 'system',
        after: { ok: true, file: 'shipyard-1.sql.gz', bytes: 1000, durationMs: 500 },
      },
    });
    await db.auditEvent.create({
      data: {
        at: new Date('2026-09-25T03:00:00.000Z'),
        actorType: 'system',
        actorLabel: 'backup',
        action: 'system.backup',
        entityType: 'system',
        after: { ok: false, error: 'disk full' },
      },
    });
    await db.auditEvent.create({
      data: {
        at: new Date('2026-09-25T03:00:00.000Z'),
        actorType: 'system',
        actorLabel: 'drill',
        action: 'system.drill',
        entityType: 'system',
        after: { ok: true },
      },
    });

    const res = await request(app).get('/api/system').set('Cookie', cookie);
    const body = res.body as SystemStatus;
    expect(body.backups.lastBackup).toMatchObject({ ok: false, error: 'disk full' });
    expect(body.backups.lastDrill).toMatchObject({ ok: true });
  });
});
