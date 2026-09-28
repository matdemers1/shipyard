import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import type { Refusal } from '@shipyard/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import {
  claimNextBuild,
  enqueueBuild,
  getBuild,
  isRefusal,
  rebuild,
  recordBuildProgress,
  recordBuildResult,
  requestCancel,
  type BuildDetail,
  type EnqueuedBuild,
} from '../../src/builds/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { Bus } from '../../src/events.js';

/**
 * SHP-T-7.4: the build service. FIFO one-at-a-time dispatch (SHP-REQ-137), cancel at the next
 * stage boundary and rebuild (SHP-REQ-143), an audit event for each (SHP-REQ-148), the routes'
 * role and scope rules, and the live SSE stream.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });
const sha = (c: string): string => c.repeat(40);
const DIGEST = `sha256:${'d'.repeat(64)}`;

let bus: Bus;
let deps: ServiceDeps;
let app: Express;
let server: Server | null = null;
let unaudited: string[];

function manifest(name: string, source: 'shipyard' | 'github' | null): string {
  return JSON.stringify({
    name,
    repo: `matdemers1/${name}`,
    workflow: 'ci.yml',
    compose: { files: [`/data/${name}/compose.yml`], project: name },
    services: { web: { image: `ghcr.io/matdemers1/${name}` } },
    health: { service: 'web', port: 8080, path: '/health' },
    ...(source === 'shipyard' ? { build: { source: 'shipyard', releaseTargets: { web: 'release' } } } : {}),
    ...(source === 'github' ? { build: { source: 'github' } } : {}),
  });
}

async function seedApp(name: string, source: 'shipyard' | 'github' | null = 'shipyard'): Promise<void> {
  const agent = await db.agent.create({ data: { publicKey: 'k', fingerprint: `fp-${randomUUID()}` } });
  await db.app.create({
    data: { name, agentId: agent.id, manifestYaml: manifest(name, source), manifestSha256: '0'.repeat(64), reportedAt: new Date() },
  });
}

async function signIn(role: 'admin' | 'deployer' | 'viewer'): Promise<{ userId: string; cookie: string }> {
  const user = await db.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, cookie: `${SESSION_COOKIE}=${session.token}` };
}

async function issueToken(cookie: string, apps: string[]): Promise<string> {
  const res = await request(app).post('/api/tokens').set('Cookie', cookie).send({ label: 'mcp', apps });
  expect(res.status).toBe(201);
  return (res.body as { token: string }).token;
}

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

const SYSTEM = { label: 'shipyard: webhook' };

async function enqueue(appName: string, commit: string): Promise<EnqueuedBuild> {
  const r = await enqueueBuild(deps, { app: appName, sha: commit, trigger: 'webhook', requester: SYSTEM });
  if (isRefusal(r)) throw new Error(`refused: ${r.message}`);
  return r;
}

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await db.auditEvent.findMany({ where: { entityType: 'build', entityId }, orderBy: { at: 'asc' }, select: { action: true } });
  return rows.map((r) => r.action);
}

const at = (): string => new Date().toISOString();

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "build_log", "build_stage", "build", "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  bus = new Bus();
  deps = { db, logger, config, bus };
  unaudited = [];
  app = createApp({
    db,
    logger,
    config,
    bus,
    onUnauditedMutation: (info) => {
      unaudited.push(`${info.method} ${info.path}`);
    },
  });
});

afterEach(async () => {
  expect(unaudited).toEqual([]);
  if (server !== null) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => { resolve(); }));
    server = null;
  }
});

afterAll(async () => {
  await db.$disconnect();
});

describe('enqueueBuild', () => {
  it('queues a build, publishes work, and audits build.request', async () => {
    await seedApp('toy');
    const woken = bus.wait('work', 1000);
    const r = await enqueue('toy', sha('a'));
    expect(r).toMatchObject({ state: 'queued', created: true });
    expect(await woken).toBe(true);
    expect(await auditActions(r.buildId)).toEqual(['build.request']);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { entityId: r.buildId } });
    expect(audit).toMatchObject({ actorType: 'system', actorLabel: 'shipyard: webhook' });
  });

  it('returns the open build instead of a second one for the same app and SHA', async () => {
    await seedApp('toy');
    const [a, b] = await Promise.all([enqueue('toy', sha('a')), enqueue('toy', sha('a'))]);
    expect(a.buildId).toBe(b.buildId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await db.build.count()).toBe(1);
    // Every request is audited, the duplicate included (SHP-REQ-148).
    expect(await auditActions(a.buildId)).toEqual(['build.request', 'build.request']);
  });

  it('refuses an unknown app, an app GitHub builds, and a short SHA', async () => {
    await seedApp('ci', 'github');
    await seedApp('plain', null);
    const unknown = await enqueueBuild(deps, { app: 'ghost', sha: sha('a'), trigger: 'manual', requester: SYSTEM });
    expect(isRefusal(unknown) && unknown.code).toBe('unknown_app');
    for (const name of ['ci', 'plain']) {
      const notOurs = await enqueueBuild(deps, { app: name, sha: sha('a'), trigger: 'manual', requester: SYSTEM });
      expect(isRefusal(notOurs) && notOurs.code).toBe('invalid_request');
      expect(isRefusal(notOurs) && notOurs.fix).toContain('build.source: shipyard');
    }
    const short = await enqueueBuild(deps, { app: 'ci', sha: 'abc1234', trigger: 'manual', requester: SYSTEM });
    expect(isRefusal(short) && short.code).toBe('invalid_request');
    expect(await db.build.count()).toBe(0);
    expect(await db.auditEvent.count({ where: { entityType: 'build' } })).toBe(0);
  });
});

describe('claimNextBuild (SHP-REQ-137)', () => {
  it('dispatches three enqueues in arrival order, one at a time', async () => {
    await seedApp('toy');
    await seedApp('other');
    const first = await enqueue('toy', sha('a'));
    const second = await enqueue('other', sha('b'));
    const third = await enqueue('toy', sha('c'));

    const order: string[] = [];
    for (const expected of [first, second, third]) {
      const job = await claimNextBuild(deps);
      expect(job?.buildId).toBe(expected.buildId);
      order.push(job?.buildId ?? '');
      // While it runs, nothing else is handed out.
      expect(await claimNextBuild(deps)).toBeNull();
      const running = await db.build.findUniqueOrThrow({ where: { id: expected.buildId } });
      expect(running.state).toBe('running');
      expect(running.dispatchedAt).not.toBeNull();
      expect(running.startedAt).not.toBeNull();
      await recordBuildResult(deps, { buildId: expected.buildId, state: 'succeeded', digests: { web: DIGEST } });
    }
    expect(order).toEqual([first.buildId, second.buildId, third.buildId]);
    expect(await claimNextBuild(deps)).toBeNull();
  });

  it('hands one queued build to exactly one of several concurrent claimers', async () => {
    await seedApp('toy');
    await enqueue('toy', sha('a'));
    await enqueue('toy', sha('b'));
    const jobs = await Promise.all(Array.from({ length: 6 }, () => claimNextBuild(deps)));
    expect(jobs.filter((j) => j !== null)).toHaveLength(1);
    expect(await db.build.count({ where: { state: 'running' } })).toBe(1);
  });

  it('returns the job the agent needs', async () => {
    await seedApp('toy');
    const q = await enqueue('toy', sha('a'));
    expect(await claimNextBuild(deps)).toEqual({ buildId: q.buildId, app: 'toy', sha: sha('a'), requesterLabel: 'shipyard: webhook' });
  });
});

describe('progress and result', () => {
  it('records stages and logs, and replays of a result change nothing', async () => {
    await seedApp('toy');
    const q = await enqueue('toy', sha('a'));
    await claimNextBuild(deps);
    expect(await recordBuildProgress(deps, { buildId: q.buildId, stage: 'fetch', state: 'running', at: at() })).toEqual({
      accepted: true,
      cancel: false,
    });
    await recordBuildProgress(deps, { buildId: q.buildId, stage: 'fetch', state: 'succeeded', log: 'fetched 12 files', at: at() });
    const detail = await getBuild(db, q.buildId);
    expect(detail?.stages).toEqual([expect.objectContaining({ stage: 'fetch', state: 'succeeded' })]);
    expect(detail?.stages[0]?.endedAt).not.toBeNull();
    expect(await db.buildLog.count({ where: { buildId: q.buildId } })).toBe(1);

    const first = await recordBuildResult(deps, { buildId: q.buildId, state: 'failed', digests: {}, failedStage: 'test' });
    expect(first).toEqual({ accepted: true, state: 'failed' });
    const ended = await db.build.findUniqueOrThrow({ where: { id: q.buildId } });
    const replay = await recordBuildResult(deps, { buildId: q.buildId, state: 'failed', digests: {}, failedStage: 'test' });
    expect(replay).toEqual({ accepted: false, state: 'failed' });
    const after = await db.build.findUniqueOrThrow({ where: { id: q.buildId } });
    expect(after.updatedAt).toEqual(ended.updatedAt);
    expect(after.endedAt).toEqual(ended.endedAt);

    // Progress for an ended build is ignored.
    expect(await recordBuildProgress(deps, { buildId: q.buildId, stage: 'push', state: 'running', at: at() })).toEqual({
      accepted: false,
      cancel: true,
    });
    expect(await db.buildStageRun.count({ where: { buildId: q.buildId } })).toBe(1);
  });

  it('stores digests on success', async () => {
    await seedApp('toy');
    const q = await enqueue('toy', sha('a'));
    await claimNextBuild(deps);
    await recordBuildResult(deps, { buildId: q.buildId, state: 'succeeded', digests: { web: DIGEST } });
    expect((await getBuild(db, q.buildId))?.digests).toEqual({ web: DIGEST });
  });
});

describe('cancel (SHP-REQ-143)', () => {
  const actor = { type: 'system' as const, label: 'test' };

  it('ends a queued build at once', async () => {
    await seedApp('toy');
    const q = await enqueue('toy', sha('a'));
    const r = await requestCancel(deps, q.buildId, { actor });
    expect(r).toEqual({ buildId: q.buildId, state: 'cancelled', cancelRequested: false });
    const row = await db.build.findUniqueOrThrow({ where: { id: q.buildId } });
    expect(row.endedAt).not.toBeNull();
    expect(await claimNextBuild(deps)).toBeNull();
    expect(await auditActions(q.buildId)).toEqual(['build.request', 'build.cancel']);
  });

  it('takes effect on a running build at its next stage boundary', async () => {
    await seedApp('toy');
    const q = await enqueue('toy', sha('a'));
    await claimNextBuild(deps);
    await recordBuildProgress(deps, { buildId: q.buildId, stage: 'fetch', state: 'running', at: at() });

    const r = await requestCancel(deps, q.buildId, { actor });
    expect(r).toEqual({ buildId: q.buildId, state: 'running', cancelRequested: true });
    // Still running until the agent reaches a boundary; its next report tells it to stop.
    expect((await db.build.findUniqueOrThrow({ where: { id: q.buildId } })).state).toBe('running');
    expect(await recordBuildProgress(deps, { buildId: q.buildId, stage: 'fetch', state: 'succeeded', at: at() })).toEqual({
      accepted: true,
      cancel: true,
    });
    await recordBuildResult(deps, { buildId: q.buildId, state: 'cancelled', digests: {} });
    expect((await db.build.findUniqueOrThrow({ where: { id: q.buildId } })).state).toBe('cancelled');
    expect(await auditActions(q.buildId)).toEqual(['build.request', 'build.cancel']);
  });

  it('refuses an ended build with conflict', async () => {
    await seedApp('toy');
    const q = await enqueue('toy', sha('a'));
    await claimNextBuild(deps);
    await recordBuildResult(deps, { buildId: q.buildId, state: 'succeeded', digests: { web: DIGEST } });
    const r = await requestCancel(deps, q.buildId, { actor });
    expect(isRefusal(r) && r.code).toBe('conflict');
    expect(await auditActions(q.buildId)).toEqual(['build.request']);
  });
});

describe('rebuild (SHP-REQ-143)', () => {
  it('creates a new build of the same SHA naming the old one, audited build.rebuild', async () => {
    await seedApp('toy');
    const q = await enqueue('toy', sha('a'));
    await claimNextBuild(deps);
    await recordBuildResult(deps, { buildId: q.buildId, state: 'failed', digests: {}, failedStage: 'test' });

    const r = await rebuild(deps, q.buildId, { label: 'matt (console)' });
    expect(isRefusal(r)).toBe(false);
    if (isRefusal(r)) return;
    expect(r.buildId).not.toBe(q.buildId);
    const row = await db.build.findUniqueOrThrow({ where: { id: r.buildId }, include: { app: true } });
    expect(row).toMatchObject({ sha: sha('a'), trigger: 'rebuild', rebuildOfId: q.buildId, state: 'queued' });
    expect(row.app.name).toBe('toy');
    expect(await auditActions(r.buildId)).toEqual(['build.rebuild']);
  });

  it('refuses with conflict while a build of that SHA is open', async () => {
    await seedApp('toy');
    const q = await enqueue('toy', sha('a'));
    const r = await rebuild(deps, q.buildId, { label: 'matt' });
    expect(isRefusal(r) && r.code).toBe('conflict');
    expect(await db.build.count()).toBe(1);
  });

  it('refuses an unknown build', async () => {
    const r = await rebuild(deps, randomUUID(), { label: 'matt' });
    expect(isRefusal(r) && r.code).toBe('not_found');
  });
});

describe('/api/builds routes', () => {
  it('a deployer queues, rebuilds and cancels; each is audited with the user as actor', async () => {
    await seedApp('toy');
    const { userId, cookie } = await signIn('deployer');

    const created = await request(app).post('/api/builds').set('Cookie', cookie).send({ app: 'toy', sha: sha('a') });
    expect(created.status).toBe(201);
    const buildId = (created.body as EnqueuedBuild).buildId;
    const row = await db.build.findUniqueOrThrow({ where: { id: buildId } });
    expect(row).toMatchObject({ trigger: 'manual', requesterUserId: userId });
    expect(row.requesterLabel).toMatch(/ \(console\)$/);

    const again = await request(app).post('/api/builds').set('Cookie', cookie).send({ app: 'toy', sha: sha('a') });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ buildId, state: 'queued', created: false });

    const cancelled = await request(app).post(`/api/builds/${buildId}/cancel`).set('Cookie', cookie).send();
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ buildId, state: 'cancelled', cancelRequested: false });

    const conflict = await request(app).post(`/api/builds/${buildId}/cancel`).set('Cookie', cookie).send();
    expect(conflict.status).toBe(409);
    expect(err(conflict).code).toBe('conflict');

    const rebuilt = await request(app).post(`/api/builds/${buildId}/rebuild`).set('Cookie', cookie).send();
    expect(rebuilt.status).toBe(201);
    const newId = (rebuilt.body as EnqueuedBuild).buildId;

    const events = await db.auditEvent.findMany({ where: { entityType: 'build' }, orderBy: { at: 'asc' } });
    expect(events.map((e) => [e.action, e.entityId, e.actorType, e.actorUserId])).toEqual([
      ['build.request', buildId, 'user', userId],
      ['build.request', buildId, 'user', userId],
      ['build.cancel', buildId, 'user', userId],
      ['build.rebuild', newId, 'user', userId],
    ]);
    expect(events.every((e) => e.requestId !== null)).toBe(true);
  });

  it('lets a viewer read but not change anything', async () => {
    await seedApp('toy');
    const q = await enqueue('toy', sha('a'));
    const { cookie } = await signIn('viewer');

    expect((await request(app).get('/api/builds').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get(`/api/builds/${q.buildId}`).set('Cookie', cookie)).status).toBe(200);
    for (const res of [
      await request(app).post('/api/builds').set('Cookie', cookie).send({ app: 'toy', sha: sha('b') }),
      await request(app).post(`/api/builds/${q.buildId}/cancel`).set('Cookie', cookie).send(),
      await request(app).post(`/api/builds/${q.buildId}/rebuild`).set('Cookie', cookie).send(),
    ]) {
      expect(res.status).toBe(403);
      expect(err(res).code).toBe('forbidden');
    }
    expect(await db.build.count()).toBe(1);
    expect((await db.build.findUniqueOrThrow({ where: { id: q.buildId } })).state).toBe('queued');
  });

  it('refuses anonymous callers', async () => {
    expect((await request(app).get('/api/builds')).status).toBe(401);
    expect((await request(app).post('/api/builds').send({ app: 'toy', sha: sha('a') })).status).toBe(401);
  });

  it('scopes a token to its apps for reads and writes', async () => {
    await seedApp('toy');
    await seedApp('other');
    const mine = await enqueue('toy', sha('a'));
    const theirs = await enqueue('other', sha('a'));
    const { cookie } = await signIn('deployer');
    const token = await issueToken(cookie, ['toy']);
    const auth = `Bearer ${token}`;

    const list = await request(app).get('/api/builds').set('Authorization', auth);
    expect(list.status).toBe(200);
    expect((list.body as { items: { buildId: string }[] }).items.map((b) => b.buildId)).toEqual([mine.buildId]);
    expect((await request(app).get('/api/builds?app=other').set('Authorization', auth)).status).toBe(403);
    expect((await request(app).get(`/api/builds/${theirs.buildId}`).set('Authorization', auth)).status).toBe(403);
    expect((await request(app).get(`/api/builds/${theirs.buildId}/logs`).set('Authorization', auth)).status).toBe(403);
    expect((await request(app).get(`/api/builds/${mine.buildId}`).set('Authorization', auth)).status).toBe(200);

    const outOfScope = await request(app).post('/api/builds').set('Authorization', auth).send({ app: 'other', sha: sha('b') });
    expect(outOfScope.status).toBe(403);
    expect((await request(app).post(`/api/builds/${theirs.buildId}/cancel`).set('Authorization', auth).send()).status).toBe(403);

    const ok = await request(app).post('/api/builds').set('Authorization', auth).send({ app: 'toy', sha: sha('b'), requester: { label: 'claude (mcp)' } });
    expect(ok.status).toBe(201);
    const row = await db.build.findUniqueOrThrow({ where: { id: (ok.body as EnqueuedBuild).buildId } });
    expect(row.requesterLabel).toBe('claude (mcp)');
    expect(row.requesterTokenId).not.toBeNull();
  });

  it('validates the body and ids', async () => {
    await seedApp('ci', 'github');
    const { cookie } = await signIn('deployer');
    const bad = await request(app).post('/api/builds').set('Cookie', cookie).send({ app: 'toy', sha: 'abc' });
    expect(bad.status).toBe(400);
    expect(err(bad).code).toBe('invalid_request');
    const unknown = await request(app).post('/api/builds').set('Cookie', cookie).send({ app: 'ghost', sha: sha('a') });
    expect(unknown.status).toBe(404);
    expect(err(unknown).code).toBe('unknown_app');
    const github = await request(app).post('/api/builds').set('Cookie', cookie).send({ app: 'ci', sha: sha('a') });
    expect(github.status).toBe(400);
    expect(err(github).fix).toContain('build.source: shipyard');
    expect((await request(app).get('/api/builds/not-a-uuid').set('Cookie', cookie)).status).toBe(404);
    expect((await request(app).post(`/api/builds/${randomUUID()}/cancel`).set('Cookie', cookie).send()).status).toBe(404);
  });

  it('lists newest first with a cursor, and serves logs after an id', async () => {
    await seedApp('toy');
    const a = await enqueue('toy', sha('a'));
    const b = await enqueue('toy', sha('b'));
    const { cookie } = await signIn('viewer');
    const page1 = await request(app).get('/api/builds?limit=1').set('Cookie', cookie);
    const body1 = page1.body as { items: { buildId: string }[]; nextCursor: string | null };
    expect(body1.items.map((i) => i.buildId)).toEqual([b.buildId]);
    expect(body1.nextCursor).not.toBeNull();
    const page2 = await request(app).get(`/api/builds?limit=1&cursor=${body1.nextCursor ?? ''}`).set('Cookie', cookie);
    expect((page2.body as { items: { buildId: string }[]; nextCursor: string | null }).items.map((i) => i.buildId)).toEqual([a.buildId]);
    expect((page2.body as { nextCursor: string | null }).nextCursor).toBeNull();

    await claimNextBuild(deps);
    await recordBuildProgress(deps, { buildId: a.buildId, stage: 'fetch', state: 'running', log: 'one', at: at() });
    await recordBuildProgress(deps, { buildId: a.buildId, stage: 'fetch', state: 'succeeded', log: 'two', at: at() });
    const all = await request(app).get(`/api/builds/${a.buildId}/logs`).set('Cookie', cookie);
    const logs = (all.body as { logs: { id: string; chunk: string }[] }).logs;
    expect(logs.map((l) => l.chunk)).toEqual(['one', 'two']);
    const rest = await request(app).get(`/api/builds/${a.buildId}/logs?after=${logs[0]?.id ?? ''}`).set('Cookie', cookie);
    expect((rest.body as { logs: { chunk: string }[] }).logs.map((l) => l.chunk)).toEqual(['two']);
  });
});

interface SseEvent {
  id: string;
  event: string;
  data: unknown;
}

async function openStream(path: string, headers: Record<string, string>, controller: AbortController) {
  if (server === null) {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => { resolve(); }));
  }
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    headers: { Accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });
  const events: SseEvent[] = [];
  let buffer = '';
  let ended = false;
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
  const decoder = new TextDecoder();
  void (async () => {
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
          let id = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
            else if (line.startsWith('id: ')) id = line.slice(4);
          }
          if (data !== '') events.push({ id, event, data: JSON.parse(data) as unknown });
          cut = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted */
    }
    ended = true;
  })();
  async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error(`timed out; events: ${JSON.stringify(events.map((e) => e.event))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return { res, events, waitFor, isEnded: () => ended };
}

describe('GET /api/builds/:id/events', () => {
  it('delivers build and logs events on progress, and ends on a terminal state', async () => {
    await seedApp('toy');
    const q = await enqueue('toy', sha('a'));
    await claimNextBuild(deps);
    await recordBuildProgress(deps, { buildId: q.buildId, stage: 'fetch', state: 'running', log: 'starting', at: at() });
    const { cookie } = await signIn('viewer');
    const abort = new AbortController();
    const s = await openStream(`/api/builds/${q.buildId}/events`, { Cookie: cookie }, abort);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');

    await s.waitFor(() => s.events.length >= 2);
    expect(s.events[0]?.event).toBe('build');
    expect((s.events[0]?.data as BuildDetail).stages).toEqual([expect.objectContaining({ stage: 'fetch', state: 'running' })]);
    expect(s.events[1]?.event).toBe('logs');
    expect((s.events[1]?.data as { logs: { chunk: string }[] }).logs.map((l) => l.chunk)).toEqual(['starting']);

    await recordBuildProgress(deps, { buildId: q.buildId, stage: 'fetch', state: 'succeeded', log: 'fetched', at: at() });
    await s.waitFor(() => s.events.length >= 4);
    expect(s.events[2]?.event).toBe('build');
    expect((s.events[2]?.data as BuildDetail).stages[0]?.state).toBe('succeeded');
    expect(s.events[3]?.event).toBe('logs');
    // Only the new chunk, not the whole log again.
    expect((s.events[3]?.data as { logs: { chunk: string }[] }).logs.map((l) => l.chunk)).toEqual(['fetched']);

    await recordBuildResult(deps, { buildId: q.buildId, state: 'succeeded', digests: { web: DIGEST } });
    await s.waitFor(() => s.isEnded());
    const last = s.events.slice(-2);
    expect(last[0]?.event).toBe('build');
    expect((last[0]?.data as BuildDetail).state).toBe('succeeded');
    expect(last[1]).toMatchObject({ event: 'end', data: { state: 'succeeded' } });
    abort.abort();
  });

  it('resumes the log after Last-Event-ID', async () => {
    await seedApp('toy');
    const q = await enqueue('toy', sha('a'));
    await claimNextBuild(deps);
    await recordBuildProgress(deps, { buildId: q.buildId, stage: 'fetch', state: 'running', log: 'one', at: at() });
    await recordBuildProgress(deps, { buildId: q.buildId, stage: 'fetch', state: 'succeeded', log: 'two', at: at() });
    const firstId = (await db.buildLog.findFirstOrThrow({ where: { buildId: q.buildId }, orderBy: { id: 'asc' } })).id.toString();
    const { cookie } = await signIn('viewer');
    const abort = new AbortController();
    const s = await openStream(`/api/builds/${q.buildId}/events`, { Cookie: cookie, 'Last-Event-ID': firstId }, abort);
    await s.waitFor(() => s.events.length >= 2);
    expect((s.events[1]?.data as { logs: { chunk: string }[] }).logs.map((l) => l.chunk)).toEqual(['two']);
    abort.abort();
  });

  it('refuses a token out of scope before opening a stream', async () => {
    await seedApp('toy');
    await seedApp('other');
    const q = await enqueue('other', sha('a'));
    const { cookie } = await signIn('deployer');
    const token = await issueToken(cookie, ['toy']);
    const res = await request(app).get(`/api/builds/${q.buildId}/events`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
