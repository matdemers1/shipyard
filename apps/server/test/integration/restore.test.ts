import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import type { DeployAccepted, Refusal, RestoreCandidates } from '@shipyard/schema';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { describeTarget } from '../../src/agent/dispatch.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { Bus } from '../../src/events.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * Guided restore (SHP-T-5.6, SHP-REQ-083..085, SHP-D-038): the candidates with their loss window,
 * the typed confirmation, console only, the 24-hour limit, the lock, and what the agent is sent.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

const SHA_1 = '1'.repeat(40);
const SHA_2 = '2'.repeat(40);
const HOUR = 3_600_000;

let bus: Bus;
let app: Express;
let appId: string;

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

async function signIn(role: Role): Promise<{ userId: string; cookie: string }> {
  const user = await db.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, cookie: `${SESSION_COOKIE}=${session.token}` };
}

async function tokenFor(apps: string[]): Promise<string> {
  const user = await db.user.create({ data: { email: `claude-${randomUUID()}@example.com`, displayName: 'claude', role: 'deployer' } });
  const { token, hash, prefix } = generateToken();
  await db.apiToken.create({
    data: { userId: user.id, label: 'claude', tokenHash: hash, prefix, apps: { create: apps.map(() => ({ appId })) } },
  });
  return token;
}

/** A finished, dispatched target of `kind` for the app, ended `endedAgoMs` ago. */
async function finished(kind: 'deploy' | 'rollback' | 'restore', sha: string, state: 'succeeded' | 'failed', endedAgoMs: number): Promise<{ deployId: string; targetId: string }> {
  const endedAt = new Date(Date.now() - endedAgoMs);
  const deploy = await db.deploy.create({
    data: {
      kind,
      requestedSha: sha,
      requesterLabel: 'seed',
      targets: { create: { appId, state, dispatchedAt: endedAt, startedAt: endedAt, endedAt } },
    },
    select: { id: true, targets: { select: { id: true } } },
  });
  return { deployId: deploy.id, targetId: deploy.targets[0]?.id ?? '' };
}

async function backupOf(targetId: string, createdAgoMs: number, path = '/srv/web/backups/web.dump'): Promise<void> {
  await db.backupArtifact.create({ data: { appId, targetId, path, size: BigInt(4096), createdAt: new Date(Date.now() - createdAgoMs) } });
}

/** c1 released 5 h ago; the contract release c2 took a backup 3 h 12 min ago and failed. */
async function contractFailure(): Promise<{ release: string; failed: string }> {
  const release = await finished('deploy', SHA_1, 'succeeded', 5 * HOUR);
  const failed = await finished('deploy', SHA_2, 'failed', 3 * HOUR);
  await backupOf(failed.targetId, 3 * HOUR + 12 * 60_000 + 5_000);
  return { release: release.deployId, failed: failed.deployId };
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "backup_artifact", "freeze", "approval", "target_image", "step", "outbox", "drift_event", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  const agent = await db.agent.create({ data: { publicKey: 'test-key', fingerprint: `fp-${randomUUID()}` } });
  const row = await db.app.create({
    data: { name: 'web', agentId: agent.id, manifestYaml: 'name: web\n', manifestSha256: '0'.repeat(64), reportedAt: new Date() },
  });
  appId = row.id;
  bus = new Bus();
  const deps: ServiceDeps = { db, logger, config, bus };
  app = createApp(deps);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/apps/:app/restore', () => {
  it('lists the backups deploys took, newest first, with the loss window in words and the release they run', async () => {
    const { failed } = await contractFailure();
    const viewer = await signIn('viewer');
    const res = await request(app).get('/api/apps/web/restore').set('Cookie', viewer.cookie);
    expect(res.status).toBe(200);
    const body = res.body as RestoreCandidates;
    expect(body.limited).toBeNull();
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      backupDeployId: failed,
      backupDeployKind: 'deploy',
      backupDeploySha: SHA_2,
      path: '/srv/web/backups/web.dump',
      size: 4096,
      lossWindow: '3 hours 12 minutes',
      releaseSha: SHA_1,
      available: true,
    });
    expect(body.candidates[0]?.lossWindowSeconds).toBeGreaterThanOrEqual(3 * 3600 + 12 * 60);
  });

  it('shows every candidate unavailable while a restore completed within 24 hours, with when it frees up', async () => {
    await contractFailure();
    await finished('restore', SHA_1, 'succeeded', 2 * HOUR);
    const viewer = await signIn('viewer');
    const body = (await request(app).get('/api/apps/web/restore').set('Cookie', viewer.cookie)).body as RestoreCandidates;
    expect(body.limited).not.toBeNull();
    expect(Date.parse(body.limited?.freesAt ?? '') - Date.parse(body.limited?.lastRestoreAt ?? '')).toBe(24 * HOUR);
    expect(body.candidates.every((c) => !c.available)).toBe(true);
  });

  it('refuses a token (console only) and an unknown app', async () => {
    const token = await tokenFor(['web']);
    const t = await request(app).get('/api/apps/web/restore').set('Authorization', `Bearer ${token}`);
    expect(t.status).toBe(403);
    const viewer = await signIn('viewer');
    const missing = await request(app).get('/api/apps/nope/restore').set('Cookie', viewer.cookie);
    expect(missing.status).toBe(404);
  });
});

describe('POST /api/apps/:app/restore', () => {
  it('a deployer who types the name exactly gets a locked restore the agent is sent with the backup deploy as toDeployId', async () => {
    const { failed } = await contractFailure();
    const deployer = await signIn('deployer');
    const res = await request(app).post('/api/apps/web/restore').set('Cookie', deployer.cookie).send({ backupDeployId: failed, confirm: 'web' });
    expect(res.status).toBe(201);
    const accepted = res.body as DeployAccepted;
    expect(accepted.state).toBe('locked');

    const target = await db.deployTarget.findFirstOrThrow({ where: { deployId: accepted.deployId }, include: { deploy: true } });
    expect(target.deploy.kind).toBe('restore');
    // The release that matches the backup's data: c1, which was live when c2 took it.
    expect(target.deploy.requestedSha).toBe(SHA_1);
    expect(target.rollbackToDeployId).toBe(failed);
    expect(target.deploy.requesterUserId).toBe(deployer.userId);

    // What the agent's poll carries: the app, a SHA and the deploy ID — never a path.
    const polled = await describeTarget(db, target.id);
    expect(polled).toMatchObject({ kind: 'restore', app: 'web', sha: SHA_1, toDeployId: failed, dryRun: false });
    expect(JSON.stringify(polled)).not.toContain('/srv/web/backups');

    const audit = await db.auditEvent.findMany({ where: { action: 'deploy.requested' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(deployer.userId);
    expect(audit[0]?.after).toMatchObject({ app: 'web', kind: 'restore', backupDeployId: failed, artifact: '/srv/web/backups/web.dump' });
  });

  it('refuses a confirmation that does not match the app name exactly (invalid_request), creating nothing', async () => {
    const { failed } = await contractFailure();
    const deployer = await signIn('deployer');
    for (const confirm of ['Web', 'web ', 'we', 'api']) {
      const res = await request(app).post('/api/apps/web/restore').set('Cookie', deployer.cookie).send({ backupDeployId: failed, confirm });
      expect(res.status, confirm).toBe(400);
      expect(err(res).code).toBe('invalid_request');
    }
    const missing = await request(app).post('/api/apps/web/restore').set('Cookie', deployer.cookie).send({ backupDeployId: failed });
    expect(missing.status).toBe(400);
    expect(await db.deploy.count({ where: { kind: 'restore' } })).toBe(0);
  });

  it('refuses a token even when scoped to the app, a viewer, and an anonymous caller', async () => {
    const { failed } = await contractFailure();
    const token = await tokenFor(['web']);
    const t = await request(app).post('/api/apps/web/restore').set('Authorization', `Bearer ${token}`).send({ backupDeployId: failed, confirm: 'web' });
    expect(t.status).toBe(403);
    expect(err(t).message).toContain('console-only');

    const viewer = await signIn('viewer');
    const v = await request(app).post('/api/apps/web/restore').set('Cookie', viewer.cookie).send({ backupDeployId: failed, confirm: 'web' });
    expect(v.status).toBe(403);

    const anon = await request(app).post('/api/apps/web/restore').send({ backupDeployId: failed, confirm: 'web' });
    expect(anon.status).toBe(401);
    expect(await db.deploy.count({ where: { kind: 'restore' } })).toBe(0);
  });

  it('refuses a deploy that took no reported backup (restore_limited)', async () => {
    const { release } = await contractFailure();
    const operator = await signIn('operator');
    const res = await request(app).post('/api/apps/web/restore').set('Cookie', operator.cookie).send({ backupDeployId: release, confirm: 'web' });
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('restore_limited');
    const unknown = await request(app).post('/api/apps/web/restore').set('Cookie', operator.cookie).send({ backupDeployId: randomUUID(), confirm: 'web' });
    expect(err(unknown).code).toBe('restore_limited');
  });

  it('refuses another restore within 24 hours of a completed one (restore_limited), naming when it frees up', async () => {
    const { failed } = await contractFailure();
    await finished('restore', SHA_1, 'succeeded', 23 * HOUR);
    const admin = await signIn('admin');
    const res = await request(app).post('/api/apps/web/restore').set('Cookie', admin.cookie).send({ backupDeployId: failed, confirm: 'web' });
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('restore_limited');
    expect(err(res).message).toContain('another restore is allowed from');
  });

  it('refuses while another deploy holds the app (locked), naming the holder', async () => {
    const { failed } = await contractFailure();
    await db.deploy.create({ data: { kind: 'deploy', requestedSha: SHA_2, requesterLabel: 'claude: ship it', targets: { create: { appId, state: 'swapping' } } } });
    const deployer = await signIn('deployer');
    const res = await request(app).post('/api/apps/web/restore').set('Cookie', deployer.cookie).send({ backupDeployId: failed, confirm: 'web' });
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('locked');
    expect(err(res).message).toContain('claude: ship it');
  });

  it('a frozen app may still be restored (SHP-REQ-077)', async () => {
    const { failed } = await contractFailure();
    const deployer = await signIn('deployer');
    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'incident' }).expect(201);
    const res = await request(app).post('/api/apps/web/restore').set('Cookie', deployer.cookie).send({ backupDeployId: failed, confirm: 'web' });
    expect(res.status).toBe(201);
  });
});
