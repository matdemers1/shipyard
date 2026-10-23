import type { EventEmitter } from 'node:events';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActionJob, ActionPage, ActionStatus, PollResponse, Refusal } from '@shipyard/schema';
import { ACTION_STALE_MS, requestAction, sweepStaleActions, waitForAction } from '../../src/actions/service.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import type { DeployCaller } from '../../src/deploys/service.js';
import { Bus } from '../../src/events.js';
import {
  agentPost,
  container,
  enrol,
  issueToken,
  makeKey,
  poll,
  seedApp,
  seedSnapshot,
  seedStack,
  signIn,
  until,
  type Key,
} from './agent-work-fixtures.js';

/**
 * SHP-T-15.4: lifecycle actions (SHP-ADR-010). POST /api/actions refuses a viewer, a token's stop,
 * an out-of-scope token, an unknown target, an Observed compose project, an app whose deploy holds
 * the lock, and an agent that cannot (SHP-REQ-184/185/186/188); otherwise it queues and audits.
 * Only a poll that advertises `actions` is handed one; progress and results move it; a dispatched
 * action that never reports back is failed; the list is Activity's source.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

let bus: Bus;
let app: Express;
let deps: ServiceDeps;
let key: Key;
let agentId: string;
let webId: string;

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

function actionOf(r: PollResponse): ActionJob | undefined {
  return 'action' in r ? r.action : undefined;
}

function listenerCount(topic: string): number {
  return (bus as unknown as { emitter: EventEmitter }).emitter.listenerCount(topic);
}

async function act(cookie: string, body: unknown) {
  return request(app).post('/api/actions').set('Cookie', cookie).send(body as object);
}

async function actWithToken(token: string, body: unknown) {
  return request(app).post('/api/actions').set('Authorization', `Bearer ${token}`).send(body as object);
}

/** A deployer's queued restart of web's `web` service; the agent has advertised `actions`. */
async function queueRestart(): Promise<{ status: ActionStatus; cookie: string; email: string }> {
  await poll(app, key, ['actions']);
  const { cookie, email } = await signIn(db, 'deployer');
  const res = await act(cookie, { target: { kind: 'app', name: 'web' }, verb: 'restart', service: 'web' });
  expect(res.status).toBe(202);
  return { status: res.body as ActionStatus, cookie, email };
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "action", "stack", "host_sample", "host_snapshot", "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  key = makeKey();
  agentId = await enrol(db, key);
  webId = await seedApp(db, 'web', agentId);
  await seedApp(db, 'api', agentId);
  await seedStack(db, 'pg-stack', agentId);
  bus = new Bus();
  deps = { db, logger, config, bus };
  app = createApp({ db, logger, config, bus });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/actions', () => {
  it('queues a deployer restart of one service, audited with target, verb, service and requester (SHP-REQ-184)', async () => {
    const { status, email } = await queueRestart();
    expect(status).toMatchObject({
      target: { kind: 'app', name: 'web' },
      verb: 'restart',
      service: 'web',
      state: 'queued',
      requesterLabel: `${email} (console)`,
      startedAt: null,
      endedAt: null,
      refusal: null,
      output: null,
    });
    const row = await db.action.findUniqueOrThrow({ where: { id: status.id } });
    expect(row).toMatchObject({ agentId, state: 'queued', targetKind: 'app', targetName: 'web' });
    const audit = await db.auditEvent.findMany({ where: { action: 'action.request', entityId: status.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorLabel).toBe(email);
    expect(audit[0]?.after).toMatchObject({ target: { kind: 'app', name: 'web' }, verb: 'restart', service: 'web', requester: `${email} (console)` });
  });

  it('queues a whole-project stop of an Operated stack from an admin', async () => {
    await poll(app, key, ['actions']);
    const { cookie } = await signIn(db, 'admin');
    const res = await act(cookie, { target: { kind: 'stack', name: 'pg-stack' }, verb: 'stop' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ target: { kind: 'stack', name: 'pg-stack' }, verb: 'stop', service: null, state: 'queued' });
  });

  it('refuses a viewer (forbidden) and queues nothing', async () => {
    await poll(app, key, ['actions']);
    const { cookie } = await signIn(db, 'viewer');
    const res = await act(cookie, { target: { kind: 'app', name: 'web' }, verb: 'restart' });
    expect(res.status).toBe(403);
    expect(err(res).code).toBe('forbidden');
    expect(await db.action.count()).toBe(0);
  });

  it('refuses a stop from an API token, pointing at the console (SHP-REQ-188); a restart is fine', async () => {
    await poll(app, key, ['actions']);
    const { cookie } = await signIn(db, 'deployer');
    const { token } = await issueToken(app, cookie, ['web']);
    const stop = await actWithToken(token, { target: { kind: 'app', name: 'web' }, verb: 'stop' });
    expect(stop.status).toBe(403);
    expect(err(stop)).toMatchObject({ code: 'forbidden', fix: 'Stop it from the console.' });
    expect(await db.action.count()).toBe(0);

    const restart = await actWithToken(token, {
      target: { kind: 'app', name: 'web' },
      verb: 'restart',
      requester: { label: 'claude: shipyard restart', repo: 'matdemers1/shipyard', branch: 'main' },
    });
    expect(restart.status).toBe(202);
    expect((restart.body as ActionStatus).requesterLabel).toBe('claude: shipyard restart (token claude)');
    const row = await db.action.findFirstOrThrow();
    expect(row.requesterTokenId).not.toBeNull();
  });

  it('refuses a token not scoped to the target, and a token naming a stack', async () => {
    await poll(app, key, ['actions']);
    const { cookie } = await signIn(db, 'deployer');
    const { token } = await issueToken(app, cookie, ['api']);
    const res = await actWithToken(token, { target: { kind: 'app', name: 'web' }, verb: 'restart' });
    expect(res.status).toBe(403);
    expect(err(res).code).toBe('forbidden');
    const onStack = await actWithToken(token, { target: { kind: 'stack', name: 'pg-stack' }, verb: 'restart' });
    expect(err(onStack).code).toBe('forbidden');
  });

  it('refuses an unknown target (unknown_app), and names the right kind when it is the other one', async () => {
    await poll(app, key, ['actions']);
    const { cookie } = await signIn(db, 'deployer');
    const res = await act(cookie, { target: { kind: 'app', name: 'ghost' }, verb: 'restart' });
    expect(res.status).toBe(404);
    expect(err(res).code).toBe('unknown_app');
    const wrongKind = await act(cookie, { target: { kind: 'app', name: 'pg-stack' }, verb: 'restart' });
    expect(err(wrongKind)).toMatchObject({ code: 'unknown_app', fix: 'Send target.kind "stack".' });
  });

  it('refuses a retired app as unknown', async () => {
    await poll(app, key, ['actions']);
    await db.$executeRaw`update "app" set "retired_at" = now() where "id" = ${webId}::uuid`;
    const { cookie } = await signIn(db, 'deployer');
    const res = await act(cookie, { target: { kind: 'app', name: 'web' }, verb: 'restart' });
    expect(err(res).code).toBe('unknown_app');
  });

  it('refuses an Observed compose project from the host snapshot as not_adopted (SHP-REQ-185)', async () => {
    await poll(app, key, ['actions']);
    await seedSnapshot(db, agentId, [
      container('watchtower', { compose: { project: 'watchtower', service: 'watchtower' } }),
      container('web-1', { tier: 'shipped', app: 'web', compose: { project: 'web', service: 'web' } }),
    ]);
    const { cookie } = await signIn(db, 'admin');
    for (const kind of ['app', 'stack'] as const) {
      const res = await act(cookie, { target: { kind, name: 'watchtower' }, verb: 'restart' });
      expect(res.status).toBe(409);
      expect(err(res).code).toBe('not_adopted');
    }
    expect(await db.action.count()).toBe(0);
  });

  it('refuses an app whose deploy holds the lock, naming the holder (SHP-REQ-186)', async () => {
    await poll(app, key, ['actions']);
    const deploy = await db.deploy.create({ data: { requestedSha: 'a'.repeat(40), requesterLabel: 'claude: web release' } });
    await db.deployTarget.create({ data: { deployId: deploy.id, appId: webId, state: 'swapping', currentStep: 'swap' } });
    const { cookie } = await signIn(db, 'admin');
    const res = await act(cookie, { target: { kind: 'app', name: 'web' }, verb: 'restart' });
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('locked');
    expect(err(res).message).toContain('claude: web release');
    expect(err(res).fix).toContain(deploy.id);
    // Another app is not held.
    const other = await act(cookie, { target: { kind: 'app', name: 'api' }, verb: 'restart' });
    expect(other.status).toBe(202);
  });

  it('refuses agent_too_old when the agent polls without advertising actions, agent_offline when it never polled', async () => {
    const { cookie } = await signIn(db, 'deployer');
    const never = await act(cookie, { target: { kind: 'app', name: 'web' }, verb: 'restart' });
    expect(never.status).toBe(503);
    expect(err(never).code).toBe('agent_offline');
    await poll(app, key, ['build']);
    const old = await act(cookie, { target: { kind: 'app', name: 'web' }, verb: 'restart' });
    expect(old.status).toBe(409);
    expect(err(old).code).toBe('agent_too_old');
    expect(await db.action.count()).toBe(0);
  });

  it('refuses an invalid body (a command string is not a verb)', async () => {
    const { cookie } = await signIn(db, 'admin');
    const res = await act(cookie, { target: { kind: 'app', name: 'web' }, verb: 'exec', service: 'web; rm -rf /' });
    expect(res.status).toBe(400);
    expect(err(res).code).toBe('invalid_request');
  });
});

describe('dispatch over the long poll', () => {
  it('is handed only to a poll that advertises actions, once, and audited', async () => {
    const { status } = await queueRestart();
    expect(actionOf(await poll(app, key))).toBeUndefined();
    expect(actionOf(await poll(app, key, ['build']))).toBeUndefined();
    expect((await db.action.findUniqueOrThrow({ where: { id: status.id } })).state).toBe('queued');

    const job = actionOf(await poll(app, key, ['actions']));
    expect(job).toEqual({ actionId: status.id, target: { kind: 'app', name: 'web' }, verb: 'restart', service: 'web', requesterLabel: status.requesterLabel });
    const row = await db.action.findUniqueOrThrow({ where: { id: status.id } });
    expect(row.state).toBe('dispatched');
    expect(row.dispatchedAt).not.toBeNull();
    expect(actionOf(await poll(app, key, ['actions']))).toBeUndefined();
    expect(await db.auditEvent.count({ where: { action: 'action.dispatched', entityId: status.id } })).toBe(1);
  });

  it("is never handed to another agent's poll", async () => {
    await queueRestart();
    const otherKey = makeKey();
    await enrol(db, otherKey);
    expect(actionOf(await poll(app, otherKey, ['actions']))).toBeUndefined();
  });

  it('wakes a waiting poll promptly', async () => {
    await poll(app, key, ['actions']);
    const waiting = poll(app, key, ['actions'], 20);
    await until(() => listenerCount('work') > 0);
    const started = Date.now();
    const { cookie } = await signIn(db, 'deployer');
    const res = await act(cookie, { target: { kind: 'app', name: 'web' }, verb: 'recreate' });
    expect(res.status).toBe(202);
    const job = actionOf(await waiting);
    expect(job?.actionId).toBe((res.body as ActionStatus).id);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('holds a queued action while a deploy of its app took the lock after it was queued', async () => {
    const { status } = await queueRestart();
    const deploy = await db.deploy.create({ data: { requestedSha: 'a'.repeat(40), requesterLabel: 'someone' } });
    const target = await db.deployTarget.create({ data: { deployId: deploy.id, appId: webId, state: 'pulling' } });
    expect(actionOf(await poll(app, key, ['actions']))).toBeUndefined();
    await db.deployTarget.update({ where: { id: target.id }, data: { state: 'succeeded', endedAt: new Date() } });
    expect(actionOf(await poll(app, key, ['actions']))?.actionId).toBe(status.id);
  });
});

describe('progress, result and status', () => {
  it('moves dispatched → running → succeeded, each audited, and keeps the output', async () => {
    const { status, cookie } = await queueRestart();
    await poll(app, key, ['actions']);

    const progress = await agentPost(app, key, `/api/agent/actions/${status.id}/progress`, { actionId: status.id, state: 'running' });
    expect(progress.status).toBe(200);
    expect(progress.body).toMatchObject({ state: 'running' });
    const running = await request(app).get(`/api/actions/${status.id}`).set('Cookie', cookie);
    expect(running.body).toMatchObject({ state: 'running' });
    expect((running.body as ActionStatus).startedAt).not.toBeNull();

    const result = await agentPost(app, key, `/api/agent/actions/${status.id}/result`, {
      actionId: status.id,
      state: 'succeeded',
      output: ' Container web-web-1  Restarted',
    });
    expect(result.status).toBe(200);
    const done = await request(app).get(`/api/actions/${status.id}`).set('Cookie', cookie);
    expect(done.body).toMatchObject({ state: 'succeeded', output: ' Container web-web-1  Restarted', refusal: null });
    expect((done.body as ActionStatus).endedAt).not.toBeNull();

    const again = await agentPost(app, key, `/api/agent/actions/${status.id}/result`, { actionId: status.id, state: 'failed' });
    expect(again.status).toBe(409);
    expect(await db.auditEvent.count({ where: { action: 'action.progress', entityId: status.id } })).toBe(1);
    const resultAudit = await db.auditEvent.findFirstOrThrow({ where: { action: 'action.result', entityId: status.id } });
    expect(resultAudit.actorAgentId).toBe(agentId);
    expect(resultAudit.after).toMatchObject({ state: 'succeeded', verb: 'restart' });
  });

  it('gives a failure without a refusal an action_failed one, and keeps an agent refusal as sent', async () => {
    const { status, cookie } = await queueRestart();
    await poll(app, key, ['actions']);
    await agentPost(app, key, `/api/agent/actions/${status.id}/result`, { actionId: status.id, state: 'failed', output: 'exit 1' });
    const failed = await request(app).get(`/api/actions/${status.id}`).set('Cookie', cookie);
    expect((failed.body as ActionStatus).refusal?.code).toBe('action_failed');

    const second = await act(cookie, { target: { kind: 'stack', name: 'pg-stack' }, verb: 'restart' });
    const id = (second.body as ActionStatus).id;
    await poll(app, key, ['actions']);
    const refusal = { code: 'not_adopted', gate: 'none', message: 'pg-stack has no manifest on the host.', fix: 'Adopt it again.' };
    await agentPost(app, key, `/api/agent/actions/${id}/result`, { actionId: id, state: 'refused', refusal });
    const refused = await request(app).get(`/api/actions/${id}`).set('Cookie', cookie);
    expect(refused.body).toMatchObject({ state: 'refused', refusal });
  });

  it('refuses progress or a result for an action not dispatched to this agent', async () => {
    const { status } = await queueRestart();
    const early = await agentPost(app, key, `/api/agent/actions/${status.id}/result`, { actionId: status.id, state: 'succeeded' });
    expect(early.status).toBe(404);
    await poll(app, key, ['actions']);
    const otherKey = makeKey();
    await enrol(db, otherKey);
    const foreign = await agentPost(app, otherKey, `/api/agent/actions/${status.id}/progress`, { actionId: status.id, state: 'running' });
    expect(foreign.status).toBe(404);
    const mismatched = await agentPost(app, key, `/api/agent/actions/${status.id}/result`, { actionId: '00000000-0000-4000-8000-000000000000', state: 'succeeded' });
    expect(mismatched.status).toBe(404);
    expect((await db.action.findUniqueOrThrow({ where: { id: status.id } })).state).toBe('dispatched');
  });

  it('fails a dispatched action that never reports back after two minutes (action_failed), audited', async () => {
    const { status, cookie } = await queueRestart();
    await poll(app, key, ['actions']);
    const past = new Date(Date.now() - ACTION_STALE_MS - 1000);
    await db.action.update({ where: { id: status.id }, data: { dispatchedAt: past } });
    const res = await request(app).get(`/api/actions/${status.id}`).set('Cookie', cookie);
    expect(res.body).toMatchObject({ state: 'failed', refusal: { code: 'action_failed' } });
    expect((res.body as ActionStatus).refusal?.message).toContain('did not report back');
    expect(await db.auditEvent.count({ where: { action: 'action.failed', entityId: status.id } })).toBe(1);
    // Swept once only; a late result is not accepted.
    expect(await sweepStaleActions(deps)).toEqual([]);
    const late = await agentPost(app, key, `/api/agent/actions/${status.id}/result`, { actionId: status.id, state: 'succeeded' });
    expect(late.status).toBe(409);
  });

  it('the poll sweeps a running action whose agent went quiet', async () => {
    const { status } = await queueRestart();
    await poll(app, key, ['actions']);
    await agentPost(app, key, `/api/agent/actions/${status.id}/progress`, { actionId: status.id, state: 'running' });
    const past = new Date(Date.now() - ACTION_STALE_MS - 1000);
    await db.action.update({ where: { id: status.id }, data: { dispatchedAt: past, startedAt: past } });
    await poll(app, key, ['actions']);
    expect((await db.action.findUniqueOrThrow({ where: { id: status.id } })).state).toBe('failed');
  });

  it('waitForAction returns as soon as the result lands', async () => {
    const { status } = await queueRestart();
    await poll(app, key, ['actions']);
    const waiting = waitForAction(deps, status.id, 20_000);
    await until(() => listenerCount(`action:${status.id}`) > 0);
    await agentPost(app, key, `/api/agent/actions/${status.id}/result`, { actionId: status.id, state: 'succeeded' });
    expect((await waiting)?.state).toBe('succeeded');
  });

  it('requestAction is callable as a service (the MCP task) and returns a refusal or a status', async () => {
    await poll(app, key, ['actions']);
    const user = await db.user.create({ data: { email: 'svc@example.com', displayName: 'svc', role: 'deployer' } });
    const caller: DeployCaller = {
      actor: { type: 'user', id: user.id, label: user.email },
      role: 'deployer',
      tokenApps: undefined,
      audit: () => Promise.resolve(),
    };
    const ok = await requestAction(deps, caller, { target: { kind: 'app', name: 'api' }, verb: 'start' });
    expect(ok).toMatchObject({ state: 'queued' });
    const refused = await requestAction(deps, caller, { target: { kind: 'app', name: 'ghost' }, verb: 'start' });
    expect(refused).toMatchObject({ code: 'unknown_app' });
  });
});

describe('GET /api/actions (Activity)', () => {
  it('lists newest first, a page at a time; a viewer may read', async () => {
    await poll(app, key, ['actions']);
    const { cookie } = await signIn(db, 'admin');
    const ids: string[] = [];
    for (const verb of ['start', 'restart', 'recreate'] as const) {
      const res = await act(cookie, { target: { kind: 'app', name: 'web' }, verb });
      ids.push((res.body as ActionStatus).id);
    }
    const viewer = await signIn(db, 'viewer');
    const first = await request(app).get('/api/actions?limit=2').set('Cookie', viewer.cookie);
    expect(first.status).toBe(200);
    const page = first.body as ActionPage;
    expect(page.items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
    expect(page.nextCursor).not.toBeNull();
    const second = await request(app).get(`/api/actions?limit=2&cursor=${page.nextCursor ?? ''}`).set('Cookie', viewer.cookie);
    expect((second.body as ActionPage).items.map((i) => i.id)).toEqual([ids[0]]);
    expect((second.body as ActionPage).nextCursor).toBeNull();
  });

  it('shows a token only the actions on apps it is scoped to', async () => {
    await poll(app, key, ['actions']);
    const { cookie } = await signIn(db, 'admin');
    const onWeb = await act(cookie, { target: { kind: 'app', name: 'web' }, verb: 'restart' });
    const onApi = await act(cookie, { target: { kind: 'app', name: 'api' }, verb: 'restart' });
    await act(cookie, { target: { kind: 'stack', name: 'pg-stack' }, verb: 'restart' });
    const { token } = await issueToken(app, cookie, ['web']);
    const list = await request(app).get('/api/actions').set('Authorization', `Bearer ${token}`);
    expect((list.body as ActionPage).items.map((i) => i.id)).toEqual([(onWeb.body as ActionStatus).id]);
    const out = await request(app).get(`/api/actions/${(onApi.body as ActionStatus).id}`).set('Authorization', `Bearer ${token}`);
    expect(out.status).toBe(403);
  });

  it('answers 404 for an unknown or malformed ID', async () => {
    const { cookie } = await signIn(db, 'viewer');
    expect((await request(app).get('/api/actions/00000000-0000-4000-8000-000000000000').set('Cookie', cookie)).status).toBe(404);
    expect((await request(app).get('/api/actions/nope').set('Cookie', cookie)).status).toBe(404);
  });
});
