import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentReport, PollResponse, Refusal, StackManifest, StackUpdateJob, StackUpdatePage, StackUpdateStatus } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db, type Prisma } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { Bus } from '../../src/events.js';
import {
  STACK_APPROVAL_EXPIRED_MESSAGE,
  STACK_APPROVAL_TTL_MS,
  STACK_UPDATE_STALE_MS,
  expireHeldStackUpdates,
  requestStackUpdate,
  sweepStaleStackUpdates,
  waitForStackUpdate,
  type StackNeedsYou,
  type StackView,
} from '../../src/stack-updates/service.js';
import { agentPost, enrol, makeKey, poll, seedApp, seedStack, signIn, type Key } from './agent-work-fixtures.js';

/**
 * SHP-T-16.3: stack updates by digest (SHP-ADR-010; SHP-REQ-195, SHP-REQ-199, SHP-REQ-200).
 * POST /api/stacks/:name/updates defaults to the reported candidates, takes explicit digests only
 * for tracked services, refuses updates: none, a viewer, an out-of-scope token, a held lock and an
 * agent that cannot; the stack's approval policy holds token (or every) requests for a deployer,
 * who approves or denies; only a poll advertising `stack-updates` is handed one; progress and the
 * result store the images before and after; a rollback names an earlier success; a silent one is
 * failed; history and the list are scoped; Needs you lists held and failed ones; the report mirrors
 * each stack's services and candidates; everything is audited.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const D3 = `sha256:${'3'.repeat(64)}`;

let bus: Bus;
let app: Express;
let deps: ServiceDeps;
let key: Key;
let agentId: string;

function manifestFor(name: string, approval: 'tokens' | 'always' | 'never' = 'tokens'): StackManifest {
  return {
    kind: 'stack',
    name,
    compose: { files: [`/DATA/AppData/${name}/docker-compose.yml`], project: name },
    updates: 'digest',
    services: {
      server: { image: 'codeberg.org/forgejo/forgejo', track: { semver: '11.x' } },
      db: { image: 'postgres', track: 'pinned' },
    },
    soakSeconds: 60,
    approval,
  };
}

const MIRROR = {
  server: { running: D1, candidate: { tag: '11.0.2', digest: D2 }, checkedAt: '2026-10-22T12:00:00.000Z', error: null },
  db: { running: D3, candidate: null, checkedAt: '2026-10-22T12:00:00.000Z', error: null },
};

/** A digest-updated stack row as the report writes it (only the report does so in src; tests seed). */
async function seedDigestStack(name: string, approval: 'tokens' | 'always' | 'never' = 'tokens'): Promise<string> {
  const row = await db.stack.create({
    data: {
      name,
      agentId,
      manifestJson: JSON.stringify(manifestFor(name, approval)),
      manifestSha256: 'b'.repeat(64),
      composeProject: name,
      services: MIRROR,
      reportedAt: new Date(),
    },
  });
  return row.id;
}

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

function jobOf(r: PollResponse): StackUpdateJob | undefined {
  return 'stackUpdate' in r ? r.stackUpdate : undefined;
}

type Auth = { cookie: string } | { token: string };

function authed(req: request.Test, auth: Auth): request.Test {
  return 'cookie' in auth ? req.set('Cookie', auth.cookie) : req.set('Authorization', `Bearer ${auth.token}`);
}

async function update(auth: Auth, name: string, body: unknown = {}) {
  return authed(request(app).post(`/api/stacks/${name}/updates`), auth).send(body as object);
}

async function rollback(auth: Auth, name: string, body: unknown) {
  return authed(request(app).post(`/api/stacks/${name}/rollback`), auth).send(body as object);
}

async function stackToken(cookie: string, names: string[]): Promise<string> {
  const res = await request(app).post('/api/tokens').set('Cookie', cookie).send({ label: 'claude', apps: names });
  expect(res.status).toBe(201);
  return (res.body as { token: string }).token;
}

async function seedUpdate(stackId: string, name: string, state: StackUpdateStatus['state'], createdAt: Date, extra: Partial<Prisma.StackUpdateUncheckedCreateInput> = {}): Promise<string> {
  const row = await db.stackUpdate.create({
    data: { stackId, stackName: name, agentId, state, requesterLabel: 'seed', digests: { server: D2 }, createdAt, ...extra },
  });
  return row.id;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "stack_update", "action", "api_token_stack", "stack", "host_sample", "host_snapshot", "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  key = makeKey();
  agentId = await enrol(db, key);
  await seedApp(db, 'web', agentId);
  await seedDigestStack('forgejo');
  await seedStack(db, 'immich', agentId);
  bus = new Bus();
  deps = { db, logger, config, bus };
  app = createApp({ db, logger, config, bus });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/stacks/:name/updates', () => {
  it('defaults to the reported candidates of unpinned services, queued and audited (SHP-REQ-195)', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie, email, userId } = await signIn(db, 'deployer');
    const res = await update({ cookie }, 'forgejo');
    expect(res.status).toBe(202);
    const status = res.body as StackUpdateStatus;
    expect(status).toMatchObject({
      stack: 'forgejo',
      kind: 'update',
      state: 'queued',
      digests: { server: D2 },
      images: [],
      previous: [],
      requesterLabel: `${email} (console)`,
      approvedBy: null,
      refusal: null,
    });
    const row = await db.stackUpdate.findUniqueOrThrow({ where: { id: status.id } });
    expect(row).toMatchObject({ agentId, requesterUserId: userId, heldAt: null, soakSeconds: 60 });
    const audit = await db.auditEvent.findMany({ where: { action: 'stack_update.request', entityId: status.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toMatchObject({ stack: 'forgejo', kind: 'update', digests: { server: D2 }, approval: 'tokens', state: 'queued' });
  });

  it('takes explicit digests only for tracked, unpinned services (digest_not_tracked)', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const untracked = await update({ cookie }, 'forgejo', { digests: { web: D2 } });
    expect(untracked.status).toBe(409);
    expect(err(untracked).code).toBe('digest_not_tracked');
    const pinned = await update({ cookie }, 'forgejo', { digests: { db: D2 } });
    expect(err(pinned).code).toBe('digest_not_tracked');
    expect(await db.stackUpdate.count()).toBe(0);
    const ok = await update({ cookie }, 'forgejo', { digests: { server: D3 } });
    expect(ok.status).toBe(202);
    expect((ok.body as StackUpdateStatus).digests).toEqual({ server: D3 });
  });

  it('refuses updates: none, an app, an unknown name and a viewer', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const none = await update({ cookie }, 'immich');
    expect(none.status).toBe(409);
    expect(err(none).code).toBe('updates_disabled');
    expect(err(await update({ cookie }, 'web')).code).toBe('unknown_app');
    expect(err(await update({ cookie }, 'ghost')).code).toBe('unknown_app');
    const viewer = await signIn(db, 'viewer');
    const refused = await update({ cookie: viewer.cookie }, 'forgejo');
    expect(refused.status).toBe(403);
    expect(err(refused).code).toBe('forbidden');
    expect(await db.stackUpdate.count()).toBe(0);
  });

  it('refuses when the agent is not polling or never advertised stack-updates', async () => {
    const { cookie } = await signIn(db, 'deployer');
    const offline = await update({ cookie }, 'forgejo');
    expect(err(offline).code).toBe('agent_offline');
    await poll(app, key, ['actions']);
    const old = await update({ cookie }, 'forgejo');
    expect(err(old).code).toBe('agent_too_old');
    expect(await db.stackUpdate.count()).toBe(0);
  });

  it('a stack-scoped token may request (held for approval by default); an app-scoped one may not (SHP-REQ-199)', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const appToken = await stackToken(cookie, ['web']);
    const refused = await update({ token: appToken }, 'forgejo');
    expect(refused.status).toBe(403);
    expect(err(refused).code).toBe('forbidden');

    const token = await stackToken(cookie, ['forgejo']);
    const held = await update({ token }, 'forgejo', { requester: { label: 'claude: forgejo bump', repo: 'matdemers1/shipyard', branch: 'main' } });
    expect(held.status).toBe(202);
    expect(held.body).toMatchObject({ state: 'awaiting_approval', requesterLabel: 'claude: forgejo bump (token claude)' });
    const row = await db.stackUpdate.findFirstOrThrow();
    expect(row.heldAt).not.toBeNull();
    expect(row.requesterTokenId).not.toBeNull();
    expect(row).toMatchObject({ requesterRepo: 'matdemers1/shipyard', requesterBranch: 'main' });
  });

  it('follows the policy: always holds a console request, never queues a token request', async () => {
    await seedDigestStack('gitea', 'always');
    await seedDigestStack('vault', 'never');
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    expect((await update({ cookie }, 'gitea')).body).toMatchObject({ state: 'awaiting_approval' });
    const token = await stackToken(cookie, ['vault']);
    expect((await update({ token }, 'vault')).body).toMatchObject({ state: 'queued' });
  });

  it('refuses locked while another update of the stack is active, or an action on it is', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const first = await update({ cookie }, 'forgejo');
    expect(first.status).toBe(202);
    const second = await update({ cookie }, 'forgejo');
    expect(second.status).toBe(409);
    expect(err(second)).toMatchObject({ code: 'locked' });
    expect(err(second).fix).toContain((first.body as StackUpdateStatus).id);

    await db.stackUpdate.updateMany({ data: { state: 'succeeded', endedAt: new Date() } });
    await db.action.create({ data: { targetKind: 'stack', targetName: 'forgejo', agentId, verb: 'restart', state: 'running', requesterLabel: 'someone' } });
    const third = await update({ cookie }, 'forgejo');
    expect(err(third).code).toBe('locked');
    expect(err(third).message).toContain('restart');
  });
});

describe('approval, dispatch, progress and result', () => {
  it('approve → queued → dispatched only to a stack-updates agent → running → succeeded with images and previous (SHP-REQ-200)', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const token = await stackToken(cookie, ['forgejo']);
    const held = (await update({ token }, 'forgejo')).body as StackUpdateStatus;
    expect(held.state).toBe('awaiting_approval');

    // Nothing is handed out while it is held.
    expect(jobOf(await poll(app, key, ['stack-updates']))).toBeUndefined();

    const needs = await request(app).get('/api/stack-updates/needs-you').set('Cookie', cookie);
    expect(needs.status).toBe(200);
    expect((needs.body as StackNeedsYou).approvals.map((a) => a.id)).toEqual([held.id]);

    // A token never approves.
    const byToken = await request(app).post(`/api/stack-updates/${held.id}/approve`).set('Authorization', `Bearer ${token}`);
    expect(byToken.status).toBe(403);
    const viewer = await signIn(db, 'viewer');
    expect((await request(app).post(`/api/stack-updates/${held.id}/approve`).set('Cookie', viewer.cookie)).status).toBe(403);

    const approver = await signIn(db, 'admin');
    const approved = await request(app).post(`/api/stack-updates/${held.id}/approve`).set('Cookie', approver.cookie);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ state: 'queued', approvedBy: approver.email });
    expect(await db.auditEvent.count({ where: { action: 'stack_update.approved', entityId: held.id } })).toBe(1);
    const again = await request(app).post(`/api/stack-updates/${held.id}/approve`).set('Cookie', approver.cookie);
    expect(err(again).code).toBe('conflict');

    // An agent that did not advertise stack-updates is never handed it.
    const other = await poll(app, key, ['actions', 'logs', 'build']);
    expect(jobOf(other)).toBeUndefined();
    expect((await db.stackUpdate.findUniqueOrThrow({ where: { id: held.id } })).state).toBe('queued');

    const job = jobOf(await poll(app, key, ['stack-updates']));
    expect(job).toEqual({ updateId: held.id, kind: 'update', stack: 'forgejo', digests: { server: D2 }, requesterLabel: 'token claude' });
    expect(await db.auditEvent.count({ where: { action: 'stack_update.dispatched', entityId: held.id } })).toBe(1);

    const path = (p: string) => `/api/agent/stack-updates/${held.id}/${p}`;
    const progress = await agentPost(app, key, path('progress'), { updateId: held.id, step: 'pulling' });
    expect(progress.status).toBe(200);
    expect(progress.body).toMatchObject({ state: 'running', step: 'pulling' });

    const images = [{ service: 'server', tag: '11.0.2', digest: D2 }];
    const previous = [{ service: 'server', tag: '11.0.1', digest: D1 }];
    const result = await agentPost(app, key, path('result'), {
      updateId: held.id,
      state: 'succeeded',
      images,
      previous,
      backupArtifact: { path: '/DATA/forgejo/backups/a.zip', size: 10, createdAt: '2026-10-23T00:00:00.000Z' },
    });
    expect(result.status).toBe(200);
    const read = await request(app).get(`/api/stack-updates/${held.id}`).set('Cookie', cookie);
    expect(read.body).toMatchObject({ state: 'succeeded', images, previous, refusal: null, approvedBy: approver.email });
    expect((read.body as StackUpdateStatus).endedAt).not.toBeNull();

    const duplicate = await agentPost(app, key, path('result'), { updateId: held.id, state: 'failed', images: [], previous: [] });
    expect(duplicate.status).toBe(409);
    const late = await agentPost(app, key, path('progress'), { updateId: held.id, step: 'soaking' });
    expect(late.status).toBe(409);

    const audit = await db.auditEvent.findMany({ where: { entityId: held.id } });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'stack_update.approved',
      'stack_update.dispatched',
      'stack_update.progress',
      'stack_update.request',
      'stack_update.result',
    ]);
    expect(audit.find((a) => a.action === 'stack_update.result')?.after).toMatchObject({ state: 'succeeded', images, previous });
  });

  it('accepts progress and results only from the agent it was dispatched to', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const queued = (await update({ cookie }, 'forgejo')).body as StackUpdateStatus;
    // Not yet dispatched: nobody may report on it.
    expect((await agentPost(app, key, `/api/agent/stack-updates/${queued.id}/progress`, { updateId: queued.id, step: 'verifying' })).status).toBe(404);
    await poll(app, key, ['stack-updates']);
    const stranger = makeKey();
    await enrol(db, stranger);
    const res = await agentPost(app, stranger, `/api/agent/stack-updates/${queued.id}/progress`, { updateId: queued.id, step: 'verifying' });
    expect(res.status).toBe(404);
    const mismatched = await agentPost(app, key, `/api/agent/stack-updates/${queued.id}/progress`, { updateId: '00000000-0000-4000-8000-000000000000', step: 'verifying' });
    expect(mismatched.status).toBe(404);
  });

  it('a failure without a refusal gets one, and waitForStackUpdate returns it', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const queued = (await update({ cookie }, 'forgejo')).body as StackUpdateStatus;
    await poll(app, key, ['stack-updates']);
    const waiting = waitForStackUpdate(deps, queued.id, 5000);
    await agentPost(app, key, `/api/agent/stack-updates/${queued.id}/result`, { updateId: queued.id, state: 'rolled_back', images: [{ service: 'server', tag: '11.0.1', digest: D1 }], previous: [{ service: 'server', tag: '11.0.1', digest: D1 }] });
    const done = await waiting;
    expect(done).toMatchObject({ state: 'rolled_back', refusal: { code: 'health_failed' } });
  });

  it('deny ends it denied with an approval_required refusal naming who, audited', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const token = await stackToken(cookie, ['forgejo']);
    const held = (await update({ token }, 'forgejo')).body as StackUpdateStatus;
    const decider = await signIn(db, 'operator');
    const denied = await request(app).post(`/api/stack-updates/${held.id}/deny`).set('Cookie', decider.cookie);
    expect(denied.status).toBe(200);
    expect(denied.body).toMatchObject({ state: 'denied', approvedBy: null, refusal: { code: 'approval_required', message: `denied by ${decider.email}` } });
    expect(await db.auditEvent.count({ where: { action: 'stack_update.denied', entityId: held.id } })).toBe(1);
    expect(jobOf(await poll(app, key, ['stack-updates']))).toBeUndefined();
    const needs = (await request(app).get('/api/stack-updates/needs-you').set('Cookie', cookie)).body as StackNeedsYou;
    expect(needs.approvals).toEqual([]);
    expect((await request(app).post('/api/stack-updates/not-a-uuid/deny').set('Cookie', decider.cookie)).status).toBe(404);
  });

  it('refuses an approval while another update of the stack holds it', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const token = await stackToken(cookie, ['forgejo']);
    const held = (await update({ token }, 'forgejo')).body as StackUpdateStatus;
    expect((await update({ cookie }, 'forgejo')).status).toBe(202);
    const approved = await request(app).post(`/api/stack-updates/${held.id}/approve`).set('Cookie', cookie);
    expect(err(approved).code).toBe('locked');
    expect((await db.stackUpdate.findUniqueOrThrow({ where: { id: held.id } })).state).toBe('awaiting_approval');
  });
});

describe('the lock runs both ways with lifecycle actions (SHP-T-16.3)', () => {
  it('refuses a stack action while an update of it is queued, naming the update and its requester', async () => {
    await poll(app, key, ['stack-updates', 'actions']);
    const { cookie, email } = await signIn(db, 'deployer');
    const queued = (await update({ cookie }, 'forgejo')).body as StackUpdateStatus;
    const res = await request(app).post('/api/actions').set('Cookie', cookie).send({ target: { kind: 'stack', name: 'forgejo' }, verb: 'restart' });
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('locked');
    expect(err(res).message).toContain(queued.id);
    expect(err(res).message).toContain(`${email} (console)`);
    expect(await db.action.count()).toBe(0);
    // Another stack is not locked by it.
    expect((await request(app).post('/api/actions').set('Cookie', cookie).send({ target: { kind: 'stack', name: 'immich' }, verb: 'restart' })).status).toBe(202);
  });

  it('never dispatches a queued stack action while an update of that stack holds it', async () => {
    const stackId = (await db.stack.findUniqueOrThrow({ where: { name: 'forgejo' } })).id;
    const action = await db.action.create({ data: { targetKind: 'stack', targetName: 'forgejo', agentId, verb: 'restart', requesterLabel: 'someone' } });
    const holding = await seedUpdate(stackId, 'forgejo', 'running', new Date());
    const blocked = await poll(app, key, ['actions']);
    expect('action' in blocked).toBe(false);
    expect((await db.action.findUniqueOrThrow({ where: { id: action.id } })).state).toBe('queued');

    await db.stackUpdate.update({ where: { id: holding }, data: { state: 'succeeded', endedAt: new Date() } });
    const freed = await poll(app, key, ['actions']);
    expect('action' in freed ? freed.action.actionId : undefined).toBe(action.id);
  });
});

describe('held updates expire and are decided only on the adopted stack', () => {
  it('expires a held update after an hour: cancelled with approval_required, audited, no longer approvable (SHP-REQ-061)', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const token = await stackToken(cookie, ['forgejo']);
    const held = (await update({ token }, 'forgejo')).body as StackUpdateStatus;
    expect(await expireHeldStackUpdates(deps, new Date(Date.now() + STACK_APPROVAL_TTL_MS - 60_000))).toEqual([]);
    expect(await expireHeldStackUpdates(deps, new Date(Date.now() + STACK_APPROVAL_TTL_MS + 60_000))).toEqual([held.id]);
    const row = await db.stackUpdate.findUniqueOrThrow({ where: { id: held.id } });
    expect(row.state).toBe('cancelled');
    expect(row.endedAt).not.toBeNull();
    expect(row.refusal).toMatchObject({ code: 'approval_required', message: STACK_APPROVAL_EXPIRED_MESSAGE });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'stack_update.expired', entityId: held.id } });
    expect(audit.actorType).toBe('system');
    const approved = await request(app).post(`/api/stack-updates/${held.id}/approve`).set('Cookie', cookie);
    expect(approved.status).toBe(409);
    expect(err(approved)).toMatchObject({ code: 'approval_required', message: STACK_APPROVAL_EXPIRED_MESSAGE });
    const needs = (await request(app).get('/api/stack-updates/needs-you').set('Cookie', cookie)).body as StackNeedsYou;
    expect(needs.approvals).toEqual([]);
  });

  it('expires lazily on approve: one held past its hour is refused, never queued', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const token = await stackToken(cookie, ['forgejo']);
    const held = (await update({ token }, 'forgejo')).body as StackUpdateStatus;
    await db.stackUpdate.update({ where: { id: held.id }, data: { heldAt: new Date(Date.now() - STACK_APPROVAL_TTL_MS - 1000) } });
    const approved = await request(app).post(`/api/stack-updates/${held.id}/approve`).set('Cookie', cookie);
    expect(err(approved).code).toBe('approval_required');
    expect((await db.stackUpdate.findUniqueOrThrow({ where: { id: held.id } })).state).toBe('cancelled');
  });

  it('refuses to approve or deny one whose stack is no longer the adopted stack it was requested for', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const token = await stackToken(cookie, ['forgejo']);
    const held = (await update({ token }, 'forgejo')).body as StackUpdateStatus;
    // The agent stops naming the stack: the report retires it.
    const report: AgentReport = {
      agentVersion: '0.1.0',
      composeVersion: '5.0.1',
      engineApiVersion: '1.51',
      patExpiresAt: null,
      apps: [],
      stacks: [{ manifest: { kind: 'stack', name: 'immich', compose: { files: ['/DATA/AppData/immich/docker-compose.yml'], project: 'immich' }, updates: 'none' }, manifestSha256: 'e'.repeat(64) }],
    };
    expect((await agentPost(app, key, '/api/agent/report', report)).status).toBe(200);
    expect((await db.stack.findUniqueOrThrow({ where: { name: 'forgejo' } })).retiredAt).not.toBeNull();
    for (const decision of ['approve', 'deny']) {
      const res = await request(app).post(`/api/stack-updates/${held.id}/${decision}`).set('Cookie', cookie);
      expect(res.status).toBe(409);
      expect(err(res).code).toBe('conflict');
    }
    expect((await db.stackUpdate.findUniqueOrThrow({ where: { id: held.id } })).state).toBe('awaiting_approval');
  });
});

describe('POST /api/stacks/:name/rollback', () => {
  it('validates the target and queues a rollback the agent resolves from its own ledger', async () => {
    await poll(app, key, ['stack-updates']);
    const stackId = (await db.stack.findUniqueOrThrow({ where: { name: 'forgejo' } })).id;
    const otherId = await seedDigestStack('gitea', 'never');
    const earlier = await seedUpdate(stackId, 'forgejo', 'succeeded', new Date('2026-10-01T00:00:00Z'));
    const failed = await seedUpdate(stackId, 'forgejo', 'failed', new Date('2026-10-02T00:00:00Z'));
    const newest = await seedUpdate(stackId, 'forgejo', 'succeeded', new Date('2026-10-03T00:00:00Z'));
    const foreign = await seedUpdate(otherId, 'gitea', 'succeeded', new Date('2026-10-01T00:00:00Z'));
    const { cookie } = await signIn(db, 'deployer');

    for (const toUpdateId of [failed, newest, foreign, '00000000-0000-4000-8000-000000000000']) {
      const res = await rollback({ cookie }, 'forgejo', { toUpdateId });
      expect(res.status).toBe(409);
      expect(err(res).code).toBe('rollback_target_invalid');
    }
    const viewer = await signIn(db, 'viewer');
    expect(err(await rollback({ cookie: viewer.cookie }, 'forgejo', { toUpdateId: earlier })).code).toBe('forbidden');

    const res = await rollback({ cookie }, 'forgejo', { toUpdateId: earlier });
    expect(res.status).toBe(202);
    const status = res.body as StackUpdateStatus;
    expect(status).toMatchObject({ kind: 'rollback', state: 'queued', toUpdateId: earlier, digests: null });
    const job = jobOf(await poll(app, key, ['stack-updates']));
    expect(job).toMatchObject({ updateId: status.id, kind: 'rollback', stack: 'forgejo', toUpdateId: earlier });

    await agentPost(app, key, `/api/agent/stack-updates/${status.id}/result`, {
      updateId: status.id,
      state: 'succeeded',
      images: [{ service: 'server', tag: '11.0.1', digest: D1 }],
      previous: [{ service: 'server', tag: '11.0.2', digest: D2 }],
    });
    expect((await request(app).get(`/api/stack-updates/${status.id}`).set('Cookie', cookie)).body).toMatchObject({ state: 'succeeded', digests: { server: D1 } });
  });

  it('holds a token rollback for approval like an update', async () => {
    await poll(app, key, ['stack-updates']);
    const stackId = (await db.stack.findUniqueOrThrow({ where: { name: 'forgejo' } })).id;
    const earlier = await seedUpdate(stackId, 'forgejo', 'succeeded', new Date('2026-10-01T00:00:00Z'));
    await seedUpdate(stackId, 'forgejo', 'succeeded', new Date('2026-10-03T00:00:00Z'));
    const { cookie } = await signIn(db, 'deployer');
    const token = await stackToken(cookie, ['forgejo']);
    const res = await rollback({ token }, 'forgejo', { toUpdateId: earlier });
    expect(res.body).toMatchObject({ kind: 'rollback', state: 'awaiting_approval' });
  });
});

describe('the stale sweep', () => {
  it('fails a dispatched update with no word from the agent past thirty minutes and its soak, audited', async () => {
    await poll(app, key, ['stack-updates']);
    const { cookie } = await signIn(db, 'deployer');
    const queued = (await update({ cookie }, 'forgejo')).body as StackUpdateStatus;
    await poll(app, key, ['stack-updates']);
    // Within the window (soak included), nothing happens.
    expect(await sweepStaleStackUpdates(deps, new Date(Date.now() + STACK_UPDATE_STALE_MS + 30_000))).toEqual([]);
    const later = new Date(Date.now() + STACK_UPDATE_STALE_MS + 120_000);
    expect(await sweepStaleStackUpdates(deps, later)).toEqual([queued.id]);
    const row = await db.stackUpdate.findUniqueOrThrow({ where: { id: queued.id } });
    expect(row.state).toBe('failed');
    expect(row.refusal).toMatchObject({ code: 'agent_offline' });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'stack_update.failed', entityId: queued.id } });
    expect(audit.actorType).toBe('system');
    // A late result is refused: it already ended.
    const late = await agentPost(app, key, `/api/agent/stack-updates/${queued.id}/result`, { updateId: queued.id, state: 'succeeded', images: [], previous: [] });
    expect(late.status).toBe(409);
  });
});

describe('history, the list, Needs you and the stack mirror', () => {
  it("lists a stack's history newest first with a cursor, and scopes a token to its stacks", async () => {
    const forgejoId = (await db.stack.findUniqueOrThrow({ where: { name: 'forgejo' } })).id;
    const giteaId = await seedDigestStack('gitea');
    const a = await seedUpdate(forgejoId, 'forgejo', 'succeeded', new Date('2026-10-01T00:00:00Z'));
    const b = await seedUpdate(forgejoId, 'forgejo', 'failed', new Date('2026-10-02T00:00:00Z'));
    const g = await seedUpdate(giteaId, 'gitea', 'succeeded', new Date('2026-10-03T00:00:00Z'));
    const viewer = await signIn(db, 'viewer');

    const first = await request(app).get('/api/stacks/forgejo/updates?limit=1').set('Cookie', viewer.cookie);
    expect(first.status).toBe(200);
    const page1 = first.body as StackUpdatePage;
    expect(page1.items.map((i) => i.id)).toEqual([b]);
    expect(page1.nextCursor).not.toBeNull();
    const second = await request(app).get(`/api/stacks/forgejo/updates?limit=1&cursor=${page1.nextCursor ?? ''}`).set('Cookie', viewer.cookie);
    expect((second.body as StackUpdatePage).items.map((i) => i.id)).toEqual([a]);
    expect((await request(app).get('/api/stacks/ghost/updates').set('Cookie', viewer.cookie)).status).toBe(404);

    const all = await request(app).get('/api/stack-updates').set('Cookie', viewer.cookie);
    expect((all.body as StackUpdatePage).items.map((i) => i.id)).toEqual([g, b, a]);

    const deployer = await signIn(db, 'deployer');
    const token = await stackToken(deployer.cookie, ['forgejo']);
    const scoped = await request(app).get('/api/stack-updates').set('Authorization', `Bearer ${token}`);
    expect((scoped.body as StackUpdatePage).items.map((i) => i.id)).toEqual([b, a]);
    expect((await request(app).get(`/api/stack-updates/${g}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect((await request(app).get('/api/stacks/gitea/updates').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    const stacks = await request(app).get('/api/stacks').set('Authorization', `Bearer ${token}`);
    expect((stacks.body as { stacks: StackView[] }).stacks.map((s) => s.name)).toEqual(['forgejo']);
  });

  it('Needs you lists the newest failed or rolled-back update per stack until a later one succeeds', async () => {
    const forgejoId = (await db.stack.findUniqueOrThrow({ where: { name: 'forgejo' } })).id;
    const giteaId = await seedDigestStack('gitea');
    await seedUpdate(forgejoId, 'forgejo', 'succeeded', new Date('2026-10-01T00:00:00Z'));
    const failed = await seedUpdate(forgejoId, 'forgejo', 'failed', new Date('2026-10-02T00:00:00Z'));
    await seedUpdate(forgejoId, 'forgejo', 'refused', new Date('2026-10-03T00:00:00Z'));
    const rolled = await seedUpdate(giteaId, 'gitea', 'rolled_back', new Date('2026-10-04T00:00:00Z'));
    const { cookie } = await signIn(db, 'viewer');
    const read = async () => (await request(app).get('/api/stack-updates/needs-you').set('Cookie', cookie)).body as StackNeedsYou;
    expect((await read()).failed.map((f) => f.id)).toEqual([rolled, failed]);

    await seedUpdate(forgejoId, 'forgejo', 'succeeded', new Date('2026-10-05T00:00:00Z'));
    expect((await read()).failed.map((f) => f.id)).toEqual([rolled]);

    const deployer = await signIn(db, 'deployer');
    const token = await stackToken(deployer.cookie, ['forgejo']);
    expect((await request(app).get('/api/stack-updates/needs-you').set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('the report mirrors each stack\'s tracked services and candidates, and GET /api/stacks shows them (SHP-REQ-194)', async () => {
    const body: AgentReport = {
      agentVersion: '0.1.0',
      composeVersion: '5.0.1',
      engineApiVersion: '1.51',
      patExpiresAt: null,
      apps: [],
      stacks: [
        { manifest: manifestFor('forgejo'), manifestSha256: 'c'.repeat(64), services: MIRROR },
        { manifest: { kind: 'stack', name: 'immich', compose: { files: ['/DATA/AppData/immich/docker-compose.yml'], project: 'immich' }, updates: 'none' }, manifestSha256: 'e'.repeat(64) },
      ],
    };
    const res = await agentPost(app, key, '/api/agent/report', body);
    expect(res.status).toBe(200);
    expect((await db.stack.findUniqueOrThrow({ where: { name: 'forgejo' } })).services).toEqual(MIRROR);
    expect((await db.stack.findUniqueOrThrow({ where: { name: 'immich' } })).services).toBeNull();

    const { cookie } = await signIn(db, 'viewer');
    const list = (await request(app).get('/api/stacks').set('Cookie', cookie)).body as { stacks: StackView[] };
    const forgejo = list.stacks.find((s) => s.name === 'forgejo');
    expect(forgejo).toMatchObject({ updates: 'digest', approval: 'tokens', soakSeconds: 60, activeUpdate: null, lastUpdate: null });
    expect(forgejo?.services).toEqual([
      { service: 'db', image: 'postgres', track: 'pinned', running: D3, candidate: null, checkedAt: MIRROR.db.checkedAt, error: null },
      { service: 'server', image: 'codeberg.org/forgejo/forgejo', track: { semver: '11.x' }, running: D1, candidate: { tag: '11.0.2', digest: D2 }, checkedAt: MIRROR.server.checkedAt, error: null },
    ]);
    expect(list.stacks.find((s) => s.name === 'immich')).toMatchObject({ updates: 'none', services: [] });

    // A later report without services clears them (an older agent, or the stack went lifecycle-only).
    await agentPost(app, key, '/api/agent/report', { ...body, stacks: [{ manifest: manifestFor('forgejo'), manifestSha256: 'c'.repeat(64) }] });
    expect((await db.stack.findUniqueOrThrow({ where: { name: 'forgejo' } })).services).toBeNull();
  });

  it('requestStackUpdate is callable directly (the MCP tool uses it)', async () => {
    await poll(app, key, ['stack-updates']);
    const { userId, email } = await signIn(db, 'deployer');
    const result = await requestStackUpdate(
      deps,
      { actor: { type: 'user', id: userId, label: email }, role: 'deployer', tokenApps: undefined, tokenStacks: undefined, audit: async () => {} },
      'forgejo',
      {},
    );
    expect(result).toMatchObject({ state: 'queued', digests: { server: D2 } });
  });
});
