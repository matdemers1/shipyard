import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  fingerprintOf,
  refusal,
  signingString,
  type PollResponse,
  type Refusal,
  type ScheduleEntry,
  type ScheduleList,
} from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { expireApprovals, type PendingApproval } from '../../src/approvals/index.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { claimTarget } from '../../src/agent/dispatch.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { Bus } from '../../src/events.js';
import { fireDueSchedules } from '../../src/schedules/index.js';
import { startScheduler } from '../../src/schedules/runner.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * Scheduled deploys (SHP-T-5.4, SHP-REQ-080, SHP-REQ-081, SHP-D-039, SHP-D-051). doneWhen:
 * "Overtaken schedule refused and logged; d3auth schedule fires unattended."
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

type Role = 'admin' | 'operator' | 'deployer' | 'viewer';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b1c2d3e4f5'.repeat(4);
const DIGEST = `sha256:${'d'.repeat(64)}`;
const HOUR = 60 * 60 * 1000;

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

let bus: Bus;
let deps: ServiceDeps;
let app: Express;
let key: Key;
let agentId: string;
let appIds: Map<string, string>;

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

function agentPost(path: string, body: unknown): request.Test {
  const text = JSON.stringify(body);
  return request(app).post(path).set(signed(key, path, text)).send(text);
}

async function poll(): Promise<PollResponse> {
  const res = await agentPost('/api/agent/poll', { waitSeconds: 0 });
  expect(res.status).toBe(200);
  return res.body as PollResponse;
}

async function signIn(role: Role): Promise<{ userId: string; email: string; cookie: string }> {
  const email = `${role}-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, email, cookie: `${SESSION_COOKIE}=${session.token}` };
}

async function tokenFor(label: string, apps: string[]): Promise<{ token: string; id: string }> {
  const user = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.com`, displayName: label, role: 'deployer' } });
  const { token, hash, prefix } = generateToken();
  const row = await db.apiToken.create({
    data: { userId: user.id, label, tokenHash: hash, prefix, apps: { create: apps.map((a) => ({ appId: appIds.get(a) ?? '' })) } },
  });
  return { token, id: row.id };
}

const requester = (label: string) => ({ repo: 'matdemers1/d3-auth', branch: 'main', label });

function schedule(auth: { cookie?: string; token?: string }, body: Record<string, unknown>): request.Test {
  const req = request(app).post('/api/schedules');
  if (auth.cookie !== undefined) req.set('Cookie', auth.cookie);
  if (auth.token !== undefined) req.set('Authorization', `Bearer ${auth.token}`);
  return req.send(body);
}

function inMinutes(n: number): string {
  return new Date(Date.now() + n * 60_000).toISOString();
}

async function targetOf(deployId: string) {
  return db.deployTarget.findFirstOrThrow({ where: { deployId } });
}

async function activeCount(name: string): Promise<number> {
  return db.deployTarget.count({ where: { appId: appIds.get(name) ?? '', state: { in: [...ACTIVE_STATES] } } });
}

async function auditOf(action: string, entityId: string) {
  return db.auditEvent.findMany({ where: { action, entityId }, orderBy: { at: 'asc' } });
}

async function list(cookie: string): Promise<ScheduleList> {
  const res = await request(app).get('/api/schedules').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as ScheduleList;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "schedule", "freeze", "approval", "backup_artifact", "target_image", "step", "outbox", "drift_event", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  key = makeKey();
  const agent = await db.agent.create({ data: { publicKey: key.b64, fingerprint: key.fingerprint, confirmedAt: new Date() } });
  agentId = agent.id;
  appIds = new Map();
  for (const [name, approvalPolicy] of [
    ['d3auth', 'required'],
    ['web', 'none'],
  ] as const) {
    const row = await db.app.create({
      data: {
        name,
        agentId,
        manifestYaml: `name: ${name}\napproval: ${approvalPolicy}\n`,
        manifestSha256: '0'.repeat(64),
        repo: `matdemers1/${name}`,
        defaultBranch: 'main',
        reportedAt: new Date(),
        approvalPolicy,
        services: { server: { image: `ghcr.io/matdemers1/${name}` } },
      },
    });
    appIds.set(name, row.id);
  }
  bus = new Bus();
  deps = { db, logger, config, bus };
  app = createApp({ db, logger, config, bus });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/schedules (SHP-REQ-081: approval captured at scheduling)', () => {
  it('a deployer scheduling an approval-required app is the approval; the deploy waits off the lock and is never dispatched', async () => {
    const deployer = await signIn('deployer');
    const res = await schedule({ cookie: deployer.cookie }, { app: 'd3auth', sha: SHA_A, fireAt: inMinutes(30) });
    expect(res.status).toBe(201);
    const entry = res.body as ScheduleEntry;
    expect(entry).toMatchObject({
      app: 'd3auth',
      sha: SHA_A,
      status: 'upcoming',
      state: 'queued',
      by: deployer.email,
      approval: { state: 'approved', by: deployer.email },
      refusal: null,
      firedAt: null,
    });
    expect(entry.requester.label).toBe(`${deployer.email} (scheduled)`);

    // Holds nothing, and the agent's poll has nothing to take.
    expect(await activeCount('d3auth')).toBe(0);
    expect(await claimTarget(db, agentId)).toBeNull();
    expect((await poll()).target).toBeNull();
    // Not a pending approval: it was given.
    const pending = await request(app).get('/api/approvals').set('Cookie', deployer.cookie);
    expect(pending.body).toEqual([]);

    expect(await auditOf('schedule.created', entry.id)).toHaveLength(1);
    const approved = await auditOf('schedule.approved', entry.id);
    expect(approved).toHaveLength(1);
    expect(approved[0]?.actorUserId).toBe(deployer.userId);
  });

  it('a scheduled deploy does not lock the app: a deploy now still goes through', async () => {
    const deployer = await signIn('deployer');
    await schedule({ cookie: deployer.cookie }, { app: 'web', sha: SHA_A, fireAt: inMinutes(30) }).expect(201);
    const now = await request(app).post('/api/deploys').set('Cookie', deployer.cookie).send({ kind: 'deploy', app: 'web', sha: SHA_B });
    expect(now.status).toBe(201);
    expect((now.body as { state: string }).state).toBe('locked');
  });

  it('refuses a time in the past or more than 30 days out, a non-SHA, an unknown app, a viewer, and anonymous', async () => {
    const deployer = await signIn('deployer');
    const past = await schedule({ cookie: deployer.cookie }, { app: 'web', sha: SHA_A, fireAt: inMinutes(-1) });
    expect(past.status).toBe(400);
    expect(err(past).message).toContain('future');
    const far = await schedule({ cookie: deployer.cookie }, { app: 'web', sha: SHA_A, fireAt: inMinutes(31 * 24 * 60) });
    expect(far.status).toBe(400);
    expect(err(far).message).toContain('30 days');
    const latest = await schedule({ cookie: deployer.cookie }, { app: 'web', sha: 'latest', fireAt: inMinutes(5) });
    expect(latest.status).toBe(400);
    const unknown = await schedule({ cookie: deployer.cookie }, { app: 'nope', sha: SHA_A, fireAt: inMinutes(5) });
    expect(err(unknown).code).toBe('unknown_app');
    const viewer = await signIn('viewer');
    const v = await schedule({ cookie: viewer.cookie }, { app: 'web', sha: SHA_A, fireAt: inMinutes(5) });
    expect(v.status).toBe(403);
    expect((await schedule({}, { app: 'web', sha: SHA_A, fireAt: inMinutes(5) })).status).toBe(401);
    expect(await db.schedule.count()).toBe(0);
  });

  it('a token must name its requester and be scoped to the app', async () => {
    const { token } = await tokenFor('claude', ['web']);
    const bare = await schedule({ token }, { app: 'web', sha: SHA_A, fireAt: inMinutes(5) });
    expect(bare.status).toBe(400);
    expect(err(bare).message).toContain('requester');
    const scoped = await schedule({ token }, { app: 'd3auth', sha: SHA_A, fireAt: inMinutes(5), requester: requester('claude') });
    expect(scoped.status).toBe(403);
    const ok = await schedule({ token }, { app: 'web', sha: SHA_A, fireAt: inMinutes(5), requester: requester('claude: nightly') });
    expect(ok.status).toBe(201);
    expect((ok.body as ScheduleEntry).approval.state).toBe('not_required');
    expect((ok.body as ScheduleEntry).by).toBe('token claude');
  });
});

describe('doneWhen: a d3auth schedule fires unattended', () => {
  it('approved at scheduling, it fires at its time with no further human act, reaches the agent, and succeeds', async () => {
    const deployer = await signIn('deployer');
    const created = (await schedule({ cookie: deployer.cookie }, { app: 'd3auth', sha: SHA_A, fireAt: inMinutes(60) }).expect(201))
      .body as ScheduleEntry;

    // Before its time: the runner leaves it alone.
    const early = startScheduler(deps, { now: () => new Date(), intervalMs: 60_000 });
    await early.stop();
    expect((await targetOf(created.deployId)).state).toBe('queued');

    let work = 0;
    const orig = bus.publish.bind(bus);
    bus.publish = (topic) => {
      if (topic === 'work') work += 1;
      orig(topic);
    };

    // At its time: the runner (its first sweep runs at start) fires it.
    const later = new Date(Date.now() + 61 * 60_000);
    const runner = startScheduler(deps, { now: () => later, intervalMs: 60_000 });
    await runner.stop();

    expect(work).toBe(1);
    expect((await targetOf(created.deployId)).state).toBe('locked');
    expect(await activeCount('d3auth')).toBe(1);
    const fired = await auditOf('schedule.fired', created.id);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ actorType: 'system', actorLabel: 'scheduler' });
    // No approval was asked for or given at fire time.
    expect(await db.auditEvent.count({ where: { action: { in: ['deploy.approved', 'deploy.denied'] } } })).toBe(0);
    expect(await auditOf('schedule.approved', created.id)).toHaveLength(1);

    // The agent takes it from its poll like any deploy: only the app name and the SHA.
    const target = (await poll()).target;
    expect(target).toMatchObject({ deployId: created.deployId, app: 'd3auth', sha: SHA_A, kind: 'deploy', dryRun: false });
    expect(target?.requesterLabel).toBe(`${deployer.email} (scheduled)`);

    const result = await agentPost('/api/agent/result', {
      targetId: target?.targetId,
      state: 'succeeded',
      images: [{ service: 'server', sha: SHA_A, digest: DIGEST }],
    });
    expect(result.status).toBe(200);

    const { past, upcoming } = await list(deployer.cookie);
    expect(upcoming).toEqual([]);
    expect(past[0]).toMatchObject({ id: created.id, status: 'fired', state: 'succeeded', refusal: null });
  });

  it('two server processes firing at once fire it exactly once', async () => {
    const deployer = await signIn('deployer');
    const created = (await schedule({ cookie: deployer.cookie }, { app: 'd3auth', sha: SHA_A, fireAt: inMinutes(1) }).expect(201))
      .body as ScheduleEntry;
    const later = new Date(Date.now() + 2 * 60_000);
    const [a, b] = await Promise.all([fireDueSchedules(deps, later), fireDueSchedules(deps, later)]);
    expect(a.length + b.length).toBe(1);
    expect(await auditOf('schedule.fired', created.id)).toHaveLength(1);
    expect(await auditOf('schedule.refused', created.id)).toHaveLength(0);
    expect(await fireDueSchedules(deps, later)).toEqual([]);
  });
});

describe('doneWhen: an overtaken schedule is refused and logged', () => {
  it("a newer release goes live after scheduling: at fire time the agent's G7 refuses it, and the refusal is recorded, audited and listed", async () => {
    const deployer = await signIn('deployer');
    const created = (await schedule({ cookie: deployer.cookie }, { app: 'web', sha: SHA_A, fireAt: inMinutes(30) }).expect(201))
      .body as ScheduleEntry;

    // Overtaken: SHA_B is deployed and goes live while the schedule waits.
    const now = await request(app).post('/api/deploys').set('Cookie', deployer.cookie).send({ kind: 'deploy', app: 'web', sha: SHA_B });
    const nowTarget = (await poll()).target;
    expect(nowTarget?.deployId).toBe((now.body as { deployId: string }).deployId);
    await agentPost('/api/agent/result', { targetId: nowTarget?.targetId, state: 'succeeded', images: [{ service: 'server', sha: SHA_B, digest: DIGEST }] }).expect(200);

    // Fire time: the server's checks pass (no lock, drift or freeze), so it is handed to the agent,
    // which re-runs every gate — the schedule names SHA_A, never "the latest green" (SHP-D-039).
    const outcomes = await fireDueSchedules(deps, new Date(Date.now() + 31 * 60_000));
    expect(outcomes).toEqual([{ scheduleId: created.id, deployId: created.deployId, result: 'fired' }]);
    const target = (await poll()).target;
    expect(target).toMatchObject({ deployId: created.deployId, sha: SHA_A });

    // What the agent's G7 reports for a SHA that is not ahead of live (packages/sequence/src/gates.ts).
    const g7 = refusal('not_ahead_of_live', 'aaaaaaa is not ahead of live b1c2d3e (behind)', 'live is b1c2d3e; request a descendant, or use rollback');
    await agentPost('/api/agent/result', {
      targetId: target?.targetId,
      state: 'refused',
      images: [],
      refusal: g7,
      gates: [{ gate: 'G7', pass: false, reason: g7.message }],
    }).expect(200);

    // Logged: the runner's next sweep writes schedule.refused once, naming the agent's refusal.
    await fireDueSchedules(deps, new Date(Date.now() + 32 * 60_000));
    await fireDueSchedules(deps, new Date(Date.now() + 33 * 60_000));
    const logged = await auditOf('schedule.refused', created.id);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.after).toMatchObject({ by: 'agent', deployId: created.deployId, sha: SHA_A, refusal: { code: 'not_ahead_of_live', gate: 'G7' } });

    // Listed on the Schedules screen as fired-and-refused, with the reason; the live release is untouched.
    const { past } = await list(deployer.cookie);
    expect(past[0]).toMatchObject({ id: created.id, status: 'fired', state: 'refused', refusal: { code: 'not_ahead_of_live', gate: 'G7' } });
    expect(await activeCount('web')).toBe(0);
  });

  it('server-side gates re-run at fire time too: a freeze set after scheduling refuses it (G2), recorded and audited', async () => {
    const deployer = await signIn('deployer');
    const created = (await schedule({ cookie: deployer.cookie }, { app: 'web', sha: SHA_A, fireAt: inMinutes(30) }).expect(201))
      .body as ScheduleEntry;
    await request(app).post('/api/apps/web/freeze').set('Cookie', deployer.cookie).send({ reason: 'Quarter close' }).expect(201);

    const [outcome] = await fireDueSchedules(deps, new Date(Date.now() + 31 * 60_000));
    expect(outcome).toMatchObject({ result: 'refused', refusal: { code: 'app_frozen' } });
    const target = await targetOf(created.deployId);
    expect(target.state).toBe('refused');
    expect(target.refusal).toMatchObject({ code: 'app_frozen', gate: 'G2' });
    expect(target.endedAt).not.toBeNull();
    expect((await poll()).target).toBeNull();
    const logged = await auditOf('schedule.refused', created.id);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.after).toMatchObject({ by: 'server', refusal: { code: 'app_frozen' } });
  });

  it('drift opened after scheduling refuses it (G3)', async () => {
    const deployer = await signIn('deployer');
    const created = (await schedule({ cookie: deployer.cookie }, { app: 'web', sha: SHA_A, fireAt: inMinutes(30) }).expect(201))
      .body as ScheduleEntry;
    await db.app.update({ where: { name: 'web' }, data: { driftedAt: new Date() } });
    await db.driftEvent.create({ data: { appId: appIds.get('web') ?? '', observed: { server: 'sha256:b' }, recorded: { server: 'sha256:a' } } });
    await fireDueSchedules(deps, new Date(Date.now() + 31 * 60_000));
    expect((await targetOf(created.deployId)).refusal).toMatchObject({ code: 'drift_unresolved', gate: 'G3' });
    expect(await auditOf('schedule.refused', created.id)).toHaveLength(1);
  });

  it('another deploy holding the app at fire time refuses it (G4), naming the holder; the holder is untouched', async () => {
    const deployer = await signIn('deployer');
    const created = (await schedule({ cookie: deployer.cookie }, { app: 'web', sha: SHA_A, fireAt: inMinutes(30) }).expect(201))
      .body as ScheduleEntry;
    const holder = await request(app).post('/api/deploys').set('Cookie', deployer.cookie).send({ kind: 'deploy', app: 'web', sha: SHA_B });
    expect((holder.body as { state: string }).state).toBe('locked');

    const [outcome] = await fireDueSchedules(deps, new Date(Date.now() + 31 * 60_000));
    expect(outcome).toMatchObject({ result: 'refused', refusal: { code: 'locked', gate: 'G4' } });
    const target = await targetOf(created.deployId);
    expect(target.state).toBe('refused');
    expect((target.refusal as { message: string }).message).toContain(`${deployer.email} (console)`);
    expect((await targetOf((holder.body as { deployId: string }).deployId)).state).toBe('locked');
    expect(await activeCount('web')).toBe(1);
    expect(await auditOf('schedule.refused', created.id)).toHaveLength(1);
    expect(await db.schedule.count({ where: { firedAt: null } })).toBe(0);
  });
});

describe('a token scheduling an approval-required app', () => {
  it('waits for a deployer; the hourly expiry never touches it; approved, it fires unattended at its time', async () => {
    const { token } = await tokenFor('claude', ['d3auth']);
    const created = (
      await schedule({ token }, { app: 'd3auth', sha: SHA_A, fireAt: inMinutes(3 * 60), requester: requester('claude: nightly') }).expect(201)
    ).body as ScheduleEntry;
    expect(created.approval.state).toBe('awaiting');
    expect(created.state).toBe('queued');

    // Listed as a pending approval, with its fire time.
    const deployer = await signIn('deployer');
    const pending = (await request(app).get('/api/approvals').set('Cookie', deployer.cookie).expect(200)).body as PendingApproval[];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ deployId: created.deployId, app: 'd3auth', fireAt: created.fireAt });

    // Two hours on, the one-hour approval expiry leaves it alone.
    expect(await expireApprovals(deps, new Date(Date.now() + 2 * HOUR))).toEqual([]);

    // A token cannot approve its own schedule.
    const self = await request(app).post(`/api/deploys/${created.deployId}/approve`).set('Authorization', `Bearer ${token}`);
    expect(self.status).toBe(403);

    const approve = await request(app).post(`/api/deploys/${created.deployId}/approve`).set('Cookie', deployer.cookie);
    expect(approve.status).toBe(200);
    expect(approve.body).toEqual({ deployId: created.deployId, state: 'queued' });
    expect((await targetOf(created.deployId)).state).toBe('queued');
    expect(await claimTarget(db, agentId)).toBeNull();
    const approvedLog = await auditOf('schedule.approved', created.id);
    expect(approvedLog).toHaveLength(1);
    expect(approvedLog[0]?.actorUserId).toBe(deployer.userId);

    const [outcome] = await fireDueSchedules(deps, new Date(Date.now() + 3 * HOUR + 60_000));
    expect(outcome?.result).toBe('fired');
    expect((await poll()).target).toMatchObject({ deployId: created.deployId, requesterLabel: 'claude: nightly' });
  });

  it('unapproved at its time, it is refused approval_required and logged, and can no longer be approved', async () => {
    const { token } = await tokenFor('claude', ['d3auth']);
    const created = (
      await schedule({ token }, { app: 'd3auth', sha: SHA_A, fireAt: inMinutes(10), requester: requester('claude: nightly') }).expect(201)
    ).body as ScheduleEntry;
    const [outcome] = await fireDueSchedules(deps, new Date(Date.now() + 11 * 60_000));
    expect(outcome).toMatchObject({ result: 'refused', refusal: { code: 'approval_required' } });
    const target = await targetOf(created.deployId);
    expect(target.state).toBe('refused');
    expect(await activeCount('d3auth')).toBe(0);
    expect((await db.approval.findUniqueOrThrow({ where: { deployId: created.deployId } })).expiredAt).not.toBeNull();
    expect(await auditOf('schedule.refused', created.id)).toHaveLength(1);

    const deployer = await signIn('deployer');
    const late = await request(app).post(`/api/deploys/${created.deployId}/approve`).set('Cookie', deployer.cookie);
    expect(err(late).code).toBe('approval_required');
    expect((await request(app).get('/api/approvals').set('Cookie', deployer.cookie)).body).toEqual([]);
    const { past } = await list(deployer.cookie);
    expect(past[0]).toMatchObject({ id: created.id, approval: { state: 'expired' }, state: 'refused', refusal: { code: 'approval_required' } });
  });

  it('denying it cancels the schedule', async () => {
    const { token } = await tokenFor('claude', ['d3auth']);
    const created = (
      await schedule({ token }, { app: 'd3auth', sha: SHA_A, fireAt: inMinutes(10), requester: requester('claude: nightly') }).expect(201)
    ).body as ScheduleEntry;
    const admin = await signIn('admin');
    const res = await request(app).post(`/api/deploys/${created.deployId}/deny`).set('Cookie', admin.cookie);
    expect(res.status).toBe(200);
    expect((await targetOf(created.deployId)).state).toBe('cancelled');
    expect(await fireDueSchedules(deps, new Date(Date.now() + 11 * 60_000))).toEqual([]);
    const { past, upcoming } = await list(admin.cookie);
    expect(upcoming).toEqual([]);
    expect(past[0]).toMatchObject({ id: created.id, status: 'cancelled', approval: { state: 'denied', by: admin.email } });
  });
});

describe('DELETE /api/schedules/:id', () => {
  it('a deployer cancels an unfired schedule; it never fires; cancelling again is a conflict', async () => {
    const deployer = await signIn('deployer');
    const created = (await schedule({ cookie: deployer.cookie }, { app: 'web', sha: SHA_A, fireAt: inMinutes(5) }).expect(201))
      .body as ScheduleEntry;
    const viewer = await signIn('viewer');
    expect((await request(app).delete(`/api/schedules/${created.id}`).set('Cookie', viewer.cookie)).status).toBe(403);

    const res = await request(app).delete(`/api/schedules/${created.id}`).set('Cookie', deployer.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.id, status: 'cancelled', state: 'cancelled' });
    expect(await auditOf('schedule.cancelled', created.id)).toHaveLength(1);
    expect(await fireDueSchedules(deps, new Date(Date.now() + 6 * 60_000))).toEqual([]);
    expect((await targetOf(created.deployId)).state).toBe('cancelled');

    const again = await request(app).delete(`/api/schedules/${created.id}`).set('Cookie', deployer.cookie);
    expect(err(again).code).toBe('conflict');
    expect(err(await request(app).delete(`/api/schedules/${randomUUID()}`).set('Cookie', deployer.cookie)).code).toBe('not_found');
  });

  it('a token cancels only the schedules it made', async () => {
    const mine = await tokenFor('claude-a', ['web']);
    const other = await tokenFor('claude-b', ['web']);
    const created = (await schedule({ token: mine.token }, { app: 'web', sha: SHA_A, fireAt: inMinutes(5), requester: requester('claude-a') }).expect(201))
      .body as ScheduleEntry;
    const denied = await request(app).delete(`/api/schedules/${created.id}`).set('Authorization', `Bearer ${other.token}`);
    expect(denied.status).toBe(403);
    const ok = await request(app).delete(`/api/schedules/${created.id}`).set('Authorization', `Bearer ${mine.token}`);
    expect(ok.status).toBe(200);
  });
});

describe('GET /api/schedules', () => {
  it('a viewer reads upcoming (soonest first) and past; anonymous is refused; a token sees only its apps', async () => {
    const deployer = await signIn('deployer');
    const later = (await schedule({ cookie: deployer.cookie }, { app: 'web', sha: SHA_A, fireAt: inMinutes(60) }).expect(201)).body as ScheduleEntry;
    const sooner = (await schedule({ cookie: deployer.cookie }, { app: 'd3auth', sha: SHA_B, fireAt: inMinutes(10) }).expect(201)).body as ScheduleEntry;
    const viewer = await signIn('viewer');
    const { upcoming, past } = await list(viewer.cookie);
    expect(upcoming.map((s) => s.id)).toEqual([sooner.id, later.id]);
    expect(past).toEqual([]);

    expect((await request(app).get('/api/schedules')).status).toBe(401);
    const { token } = await tokenFor('claude', ['web']);
    const scoped = (await request(app).get('/api/schedules').set('Authorization', `Bearer ${token}`).expect(200)).body as ScheduleList;
    expect(scoped.upcoming.map((s) => s.app)).toEqual(['web']);
    expect(err(await request(app).delete(`/api/schedules/${sooner.id}`).set('Authorization', `Bearer ${token}`)).code).toBe('not_found');
  });
});
