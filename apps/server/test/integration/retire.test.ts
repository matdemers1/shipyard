import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, signingString, type AgentReport, type DeployAccepted, type GroupSummary, type Refusal } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { listPendingApprovals } from '../../src/approvals/service.js';
import { assertDeployable } from '../../src/apps/index.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';

/**
 * Retiring an app the agent stops reporting (SHP-REQ-174, SHP-T-3.14), driven through the real
 * signed report. The incident it reproduces, 2026-10-07: foreman-board's manifest left the host,
 * foreman-asksage became group foreman's canary, and the stale foreman-board row — still a member,
 * still a canary — made every group deploy of foreman refuse "more than one canary".
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

const SHA = 'e'.repeat(40);
const DIGEST = `sha256:${'a'.repeat(64)}`;

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

function manifest(name: string, extra: Record<string, unknown> = {}): AgentReport['apps'][number]['manifest'] {
  return {
    name,
    repo: 'matdemers1/foreman',
    defaultBranch: 'main',
    workflow: 'ci.yml',
    compose: { files: [`/data/${name}/compose.yml`], project: name },
    services: { web: { image: `ghcr.io/matdemers1/${name}` } },
    health: { service: 'web', port: 8080, path: '/health' },
    soakSeconds: 60,
    approval: 'none',
    diskFloorGb: 5,
    retainImages: 3,
    ...extra,
  };
}

let app: Express;
let key: Key;
let agentId: string;
let cookie: string;

interface ReportBody {
  retired: string[];
  revived: string[];
}

/** Sends a report naming exactly these apps, each with the given manifest extras. */
async function reportApps(apps: Record<string, Record<string, unknown>>, k: Key = key): Promise<ReportBody> {
  const body: AgentReport = {
    agentVersion: '0.1.0',
    composeVersion: '5.0.1',
    engineApiVersion: '1.51',
    patExpiresAt: null,
    apps: Object.entries(apps).map(([name, extra]) => ({ manifest: manifest(name, extra), manifestSha256: '0'.repeat(64), running: { web: null } })),
  };
  const text = JSON.stringify(body);
  const res = await request(app).post('/api/agent/report').set(signed(k, '/api/agent/report', text)).send(text);
  expect(res.status).toBe(200);
  return res.body as ReportBody;
}

/** The three members of group foreman before the board's manifest left the host. */
const BEFORE = {
  foreman: { group: 'foreman' },
  'foreman-asksage': { group: 'foreman' },
  'foreman-board': { group: 'foreman', canary: true },
};
/** After: the board's manifest is gone and asksage is the canary. */
const AFTER = {
  foreman: { group: 'foreman' },
  'foreman-asksage': { group: 'foreman', canary: true },
};

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "freeze", "approval", "schedule", "outbox", "drift_event", "target_image", "step", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  key = makeKey();
  agentId = (await db.agent.create({ data: { publicKey: key.b64, fingerprint: key.fingerprint, confirmedAt: new Date() } })).id;
  app = createApp({ db, logger, config, bus: new Bus() });
  const user = await db.user.create({ data: { email: `deployer-${randomUUID()}@example.com`, displayName: 'deployer', role: 'deployer' } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  cookie = `${SESSION_COOKIE}=${session.token}`;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('an app the agent stops reporting is retired (SHP-REQ-174)', () => {
  it('doneWhen: a removed canary leaves its group, and the group deploys with the new canary', async () => {
    await reportApps(BEFORE);
    const board = await db.app.findUniqueOrThrow({ where: { name: 'foreman-board' } });
    // The board's history: one succeeded deploy, which must stay readable after it is retired.
    await db.deploy.create({
      data: {
        requestedSha: SHA,
        requesterLabel: 'user matthew',
        targets: { create: { appId: board.id, state: 'succeeded', endedAt: new Date(), images: { create: [{ service: 'web', repo: 'ghcr.io/matdemers1/foreman-board', sha: SHA, digest: DIGEST }] } } },
      },
    });

    const res = await reportApps(AFTER);
    expect(res.retired).toEqual(['foreman-board']);
    expect(res.revived).toEqual([]);
    expect((await db.app.findUniqueOrThrow({ where: { name: 'foreman-board' } })).retiredAt).not.toBeNull();
    expect((await db.app.findUniqueOrThrow({ where: { name: 'foreman-asksage' } })).retiredAt).toBeNull();

    const groups = await request(app).get('/api/groups').set('Cookie', cookie);
    expect(groups.body as GroupSummary[]).toEqual([{ name: 'foreman', canary: 'foreman-asksage', members: ['foreman-asksage', 'foreman'] }]);

    const deploy = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', group: 'foreman', sha: SHA });
    expect(deploy.status).toBe(201);
    const targets = await db.deployTarget.findMany({ where: { deployId: (deploy.body as DeployAccepted).deployId }, select: { app: { select: { name: true } } } });
    expect(targets.map((t) => t.app.name).sort()).toEqual(['foreman', 'foreman-asksage']);

    const audit = await db.auditEvent.findMany({ where: { action: 'app.retired' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: 'app', entityId: board.id, actorAgentId: agentId });
  });

  it('leaves a retired app out of the app list and MCP status, while its own page and history still answer', async () => {
    await reportApps(BEFORE);
    const board = await db.app.findUniqueOrThrow({ where: { name: 'foreman-board' } });
    await db.deploy.create({
      data: { requestedSha: SHA, requesterLabel: 'user matthew', targets: { create: { appId: board.id, state: 'succeeded', endedAt: new Date() } } },
    });
    await reportApps(AFTER);

    const list = await request(app).get('/api/apps').set('Cookie', cookie);
    expect((list.body as { apps: { name: string }[] }).apps.map((a) => a.name)).toEqual(['foreman', 'foreman-asksage']);

    const detail = await request(app).get('/api/apps/foreman-board').set('Cookie', cookie);
    expect(detail.status).toBe(200);
    const body = detail.body as { retiredAt: string | null; targets: { sha: string; state: string }[] };
    expect(body.retiredAt).not.toBeNull();
    expect(body.targets).toEqual([expect.objectContaining({ sha: SHA, state: 'succeeded' })]);

    const { appStatuses } = await import('../../src/mcp/status.js');
    const statuses = await appStatuses({ db, config }, ['foreman', 'foreman-board'], { github: { compare: () => Promise.resolve(null) } });
    expect(statuses.map((s) => s.name)).toEqual(['foreman']);
  });

  it('refuses a deploy, a schedule and a build of a retired app as unknown_app, naming how to bring it back', async () => {
    await reportApps(BEFORE);
    await reportApps(AFTER);

    const refused = await assertDeployable(db, 'foreman-board');
    expect(refused).toMatchObject({ code: 'unknown_app' });
    expect(refused?.message).toContain('retired');
    expect(refused?.fix).toContain('manifest back');

    const deploy = await request(app).post('/api/deploys').set('Cookie', cookie).send({ kind: 'deploy', app: 'foreman-board', sha: SHA });
    expect(err(deploy).code).toBe('unknown_app');
    const schedule = await request(app)
      .post('/api/schedules')
      .set('Cookie', cookie)
      .send({ app: 'foreman-board', sha: SHA, fireAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(err(schedule).code).toBe('unknown_app');
    expect(await db.deploy.count()).toBe(0);
  });

  it('drops a retired app from pending approvals', async () => {
    await reportApps({ ...BEFORE, 'foreman-board': { group: 'foreman', canary: true, approval: 'required' } });
    const board = await db.app.findUniqueOrThrow({ where: { name: 'foreman-board' } });
    await db.deploy.create({
      data: {
        requestedSha: SHA,
        requesterLabel: 'claude: foreman',
        targets: { create: { appId: board.id, state: 'awaiting_approval' } },
        approval: { create: { expiresAt: new Date(Date.now() + 3_600_000) } },
      },
    });
    expect(await listPendingApprovals({ db, logger, config, bus: new Bus() })).toHaveLength(1);
    await reportApps(AFTER);
    expect(await listPendingApprovals({ db, logger, config, bus: new Bus() })).toEqual([]);
  });

  it('brings a retired app back when a report names it again', async () => {
    await reportApps(BEFORE);
    await reportApps(AFTER);
    const res = await reportApps(BEFORE);
    expect(res.revived).toEqual(['foreman-board']);
    expect((await db.app.findUniqueOrThrow({ where: { name: 'foreman-board' } })).retiredAt).toBeNull();
    expect(await assertDeployable(db, 'foreman-board')).toBeNull();
    expect(await db.auditEvent.count({ where: { action: 'app.revived' } })).toBe(1);
  });

  it('retires nothing on a report that names no apps, and only what the reporting agent owns', async () => {
    await reportApps(BEFORE);
    expect((await reportApps({})).retired).toEqual([]);
    expect(await db.app.count({ where: { retiredAt: { not: null } } })).toBe(0);

    // Another agent's report never retires this agent's apps.
    const other = makeKey();
    await db.agent.create({ data: { publicKey: other.b64, fingerprint: other.fingerprint, confirmedAt: new Date() } });
    expect((await reportApps({ elsewhere: {} }, other)).retired).toEqual([]);
    expect(await db.app.count({ where: { retiredAt: { not: null } } })).toBe(0);
  });

  it('an unchanged report after a retirement retires nothing more and writes no audit', async () => {
    await reportApps(BEFORE);
    await reportApps(AFTER);
    const before = await db.auditEvent.count();
    const res = await reportApps(AFTER);
    expect(res.retired).toEqual([]);
    expect(await db.auditEvent.count()).toBe(before);
  });
});
