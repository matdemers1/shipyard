import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogLine, LogsChunk, LogsJob, LogsSession, PollResponse, Refusal } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import type { DeployCaller } from '../../src/deploys/service.js';
import { Bus } from '../../src/events.js';
import { logsHubFor, readLogsTail } from '../../src/logs/index.js';
import {
  agentPost,
  container,
  enrol,
  issueToken,
  makeKey,
  openStream,
  poll,
  seedApp,
  seedStack,
  seedSnapshot,
  signIn,
  until,
  type Key,
  type SseEvent,
} from './agent-work-fixtures.js';

/**
 * SHP-T-15.4: container logs (SHP-ADR-011; SHP-REQ-189, SHP-REQ-191, SHP-REQ-192). POST /api/logs
 * is for admins and operators, or a token with can_read_logs; the container must be in the host
 * snapshot; every view is audited. The agent is handed the read only when it advertises `logs`;
 * its chunks are relayed over SSE in order and dropped; the viewer leaving (DELETE or a closed
 * stream) makes the next chunk's answer `continue: false`. And the no-store rule: a marker string
 * sent in a log line appears in no table and in nothing the server logged.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });

/** Everything the server logs, at every level, captured as text. */
const logged: string[] = [];
const sink = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    logged.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    callback();
  },
});
const logger = pino({ level: 'trace' }, sink);

const WEB = container('web-1', { tier: 'shipped', app: 'web', compose: { project: 'web', service: 'web' } });
const WATCHTOWER = container('watchtower');
const PG = container('pg', { tier: 'operated', app: 'pg-stack', compose: { project: 'pg-stack', service: 'pg' } });

let bus: Bus;
let app: Express;
let deps: ServiceDeps;
let key: Key;
let agentId: string;
let server: Server | null = null;

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

function logsOf(r: PollResponse): LogsJob | undefined {
  return 'logs' in r ? r.logs : undefined;
}

function line(text: string): LogLine {
  return { at: '2026-10-22T12:00:00.000Z', stream: 'stdout', text };
}

async function sendChunk(id: string, seq: number, texts: string[], done = false, k: Key = key) {
  const body: LogsChunk = { logsId: id, seq, lines: texts.map(line), done };
  return agentPost(app, k, `/api/agent/logs/${id}/chunks`, body);
}

async function open(cookie: string, body: Record<string, unknown> = {}) {
  return request(app).post('/api/logs').set('Cookie', cookie).send({ container: WEB.id, ...body });
}

async function listening(): Promise<Server> {
  if (server === null) {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => { resolve(); }));
  }
  return server;
}

/** An admin's open session, already handed to the agent. */
async function openedAndDispatched(body: Record<string, unknown> = {}): Promise<{ session: LogsSession; cookie: string; email: string }> {
  await poll(app, key, ['logs']);
  const { cookie, email } = await signIn(db, 'admin');
  const res = await open(cookie, body);
  expect(res.status).toBe(201);
  const session = res.body as LogsSession;
  expect(logsOf(await poll(app, key, ['logs']))?.logsId).toBe(session.id);
  return { session, cookie, email };
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "action", "stack", "host_sample", "host_snapshot", "audit_event", "agent_nonce", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  logged.length = 0;
  key = makeKey();
  agentId = await enrol(db, key);
  await seedApp(db, 'web', agentId);
  await seedStack(db, 'pg-stack', agentId);
  await seedSnapshot(db, agentId, [WEB, WATCHTOWER, PG]);
  bus = new Bus();
  deps = { db, logger, config, bus };
  app = createApp({ db, logger, config, bus });
});

afterEach(async () => {
  if (server !== null) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => { resolve(); }));
    server = null;
  }
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/logs: who may read', () => {
  it('lets an admin and an operator open a session; refuses a deployer and a viewer', async () => {
    await poll(app, key, ['logs']);
    for (const role of ['admin', 'operator'] as const) {
      const { cookie } = await signIn(db, role);
      const res = await open(cookie);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ container: WEB.id, containerName: 'web-1', tail: 200, follow: false });
    }
    for (const role of ['deployer', 'viewer'] as const) {
      const { cookie } = await signIn(db, role);
      const res = await open(cookie);
      expect(res.status).toBe(403);
      expect(err(res).code).toBe('forbidden');
    }
  });

  it('lets a token read only when it was created with can_read_logs, and only an admin or operator may create one', async () => {
    await poll(app, key, ['logs']);
    const admin = await signIn(db, 'admin');
    const plain = await issueToken(app, admin.cookie, ['web']);
    const refused = await request(app).post('/api/logs').set('Authorization', `Bearer ${plain.token}`).send({ container: WEB.id });
    expect(refused.status).toBe(403);
    expect(err(refused).code).toBe('forbidden');

    const reader = await issueToken(app, admin.cookie, ['web'], true);
    const ok = await request(app).post('/api/logs').set('Authorization', `Bearer ${reader.token}`).send({ container: WEB.id, tail: 50 });
    expect(ok.status).toBe(201);

    const list = await request(app).get('/api/tokens').set('Cookie', admin.cookie);
    const byId = new Map((list.body as { id: string; canReadLogs: boolean }[]).map((t) => [t.id, t.canReadLogs]));
    expect(byId.get(reader.id)).toBe(true);
    expect(byId.get(plain.id)).toBe(false);

    const deployer = await signIn(db, 'deployer');
    const escalate = await request(app).post('/api/tokens').set('Cookie', deployer.cookie).send({ label: 'x', apps: ['web'], canReadLogs: true });
    expect(escalate.status).toBe(403);

    // A token whose owner is demoted loses it with them.
    await db.user.update({ where: { id: admin.userId }, data: { role: 'deployer' } });
    const demoted = await request(app).post('/api/logs').set('Authorization', `Bearer ${reader.token}`).send({ container: WEB.id });
    expect(demoted.status).toBe(403);
  });

  it("scopes a token's reads: only Shipped or Operated containers of the apps and stacks it names (SHP-ADR-011)", async () => {
    await poll(app, key, ['logs']);
    const admin = await signIn(db, 'admin');
    const webToken = await issueToken(app, admin.cookie, ['web'], true);
    const as = (token: string, id: string) => request(app).post('/api/logs').set('Authorization', `Bearer ${token}`).send({ container: id });

    const observed = await as(webToken.token, WATCHTOWER.id);
    expect(observed.status).toBe(403);
    expect(err(observed)).toMatchObject({ code: 'forbidden', fix: 'Use the console, or a token scoped to watchtower.' });
    const otherStack = await as(webToken.token, PG.id);
    expect(otherStack.status).toBe(403);
    expect(err(otherStack)).toMatchObject({ code: 'forbidden', fix: 'Use the console, or a token scoped to pg-stack.' });
    expect((await as(webToken.token, WEB.id)).status).toBe(201);

    const stackToken = await issueToken(app, admin.cookie, ['pg-stack'], true);
    expect((await as(stackToken.token, PG.id)).status).toBe(201);
    expect((await as(stackToken.token, WEB.id)).status).toBe(403);

    // A signed-in admin is not scoped: an Observed container is readable in the console.
    expect((await open(admin.cookie, { container: WATCHTOWER.id })).status).toBe(201);
    expect(await db.auditEvent.count({ where: { action: 'logs.view' } })).toBe(3);
  });

  it('refuses a container the snapshot does not name (unknown_container) and a tail over 2000', async () => {
    await poll(app, key, ['logs']);
    const { cookie } = await signIn(db, 'admin');
    const unknown = await open(cookie, { container: 'f'.repeat(64) });
    expect(unknown.status).toBe(404);
    expect(err(unknown).code).toBe('unknown_container');
    const tooLong = await open(cookie, { tail: 2001 });
    expect(tooLong.status).toBe(400);
    expect(err(tooLong).code).toBe('invalid_request');
  });

  it('refuses agent_too_old when the agent polls without advertising logs', async () => {
    await poll(app, key, ['build', 'actions']);
    const { cookie } = await signIn(db, 'admin');
    const res = await open(cookie);
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('agent_too_old');
  });

  it('audits every view as logs.view: viewer, container and window, never content (SHP-REQ-192)', async () => {
    await poll(app, key, ['logs']);
    const { cookie, email } = await signIn(db, 'operator');
    const res = await open(cookie, { tail: 500, follow: true });
    const session = res.body as LogsSession;
    const audit = await db.auditEvent.findMany({ where: { action: 'logs.view' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorLabel: email, entityType: 'container', entityId: WEB.id });
    expect(audit[0]?.after).toMatchObject({
      logsId: session.id,
      viewer: email,
      container: WEB.id,
      containerName: 'web-1',
      tail: 500,
      follow: true,
      window: { tail: 500, followSeconds: 300 },
    });
  });
});

describe('dispatch', () => {
  it('hands the read only to a poll that advertises logs, with followSeconds 0 unless following', async () => {
    await poll(app, key, ['logs']);
    const { cookie } = await signIn(db, 'admin');
    const once = (await open(cookie, { tail: 20 })).body as LogsSession;
    expect(logsOf(await poll(app, key, ['actions', 'build']))).toBeUndefined();
    expect(logsOf(await poll(app, key))).toBeUndefined();
    expect(logsOf(await poll(app, key, ['logs']))).toEqual({ logsId: once.id, containerId: WEB.id, tail: 20, follow: false, followSeconds: 0 });
    expect(logsOf(await poll(app, key, ['logs']))).toBeUndefined();

    const followed = (await open(cookie, { follow: true })).body as LogsSession;
    expect(logsOf(await poll(app, key, ['logs']))).toMatchObject({ logsId: followed.id, follow: true, followSeconds: 300 });
  });

  it("is never handed to another agent's poll", async () => {
    await poll(app, key, ['logs']);
    const { cookie } = await signIn(db, 'admin');
    await open(cookie);
    const otherKey = makeKey();
    await enrol(db, otherKey);
    expect(logsOf(await poll(app, otherKey, ['logs']))).toBeUndefined();
  });

  it('wakes a waiting poll promptly', async () => {
    await poll(app, key, ['logs']);
    const waiting = poll(app, key, ['logs'], 20);
    const emitter = (bus as unknown as { emitter: EventEmitter }).emitter;
    await until(() => emitter.listenerCount('work') > 0);
    const started = Date.now();
    const { cookie } = await signIn(db, 'admin');
    const session = (await open(cookie)).body as LogsSession;
    expect(logsOf(await waiting)?.logsId).toBe(session.id);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('the SSE relay', () => {
  it('relays chunks in order and ends on done', async () => {
    const { session, cookie } = await openedAndDispatched();
    const abort = new AbortController();
    const s = await openStream(await listening(), `/api/logs/${session.id}/stream`, { Cookie: cookie }, abort);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');

    expect((await sendChunk(session.id, 0, ['first', 'second'])).body).toEqual({ continue: true });
    expect((await sendChunk(session.id, 1, ['third'])).body).toEqual({ continue: true });
    expect((await sendChunk(session.id, 2, ['fourth'], true)).body).toEqual({ continue: false });

    await s.waitFor((e) => e.some((x) => x.event === 'end'));
    await s.pump;
    expect(s.isEnded()).toBe(true);
    const lines = s.events.filter((e): e is SseEvent & { data: { seq: number; lines: LogLine[] } } => e.event === 'lines');
    expect(lines.map((e) => e.data.seq)).toEqual([0, 1, 2]);
    expect(lines.flatMap((e) => e.data.lines.map((l) => l.text))).toEqual(['first', 'second', 'third', 'fourth']);
    expect(s.events.at(-1)).toEqual({ event: 'end', data: { reason: 'done' } });
  });

  it('holds chunks that arrive before the viewer attaches', async () => {
    const { session, cookie } = await openedAndDispatched();
    await sendChunk(session.id, 0, ['early'], true);
    const s = await openStream(await listening(), `/api/logs/${session.id}/stream`, { Cookie: cookie }, new AbortController());
    await s.waitFor((e) => e.some((x) => x.event === 'end'));
    expect(s.events.map((e) => e.event)).toEqual(['lines', 'end']);
  });

  it('only the viewer who opened it may attach or stop it', async () => {
    const { session } = await openedAndDispatched();
    const other = await signIn(db, 'admin');
    expect((await request(app).get(`/api/logs/${session.id}/stream`).set('Cookie', other.cookie)).status).toBe(404);
    expect((await request(app).delete(`/api/logs/${session.id}`).set('Cookie', other.cookie)).status).toBe(404);
  });

  it('DELETE stops it: 204, audited, and the next chunk is told to stop', async () => {
    const { session, cookie } = await openedAndDispatched({ follow: true });
    expect((await sendChunk(session.id, 0, ['a'])).body).toEqual({ continue: true });
    const res = await request(app).delete(`/api/logs/${session.id}`).set('Cookie', cookie);
    expect(res.status).toBe(204);
    expect((await sendChunk(session.id, 1, ['b'])).body).toEqual({ continue: false });
    expect(await db.auditEvent.count({ where: { action: 'logs.stop', entityId: WEB.id } })).toBe(1);
  });

  it('the viewer closing the stream makes the next chunk ack continue:false', async () => {
    const { session, cookie } = await openedAndDispatched({ follow: true });
    const abort = new AbortController();
    const s = await openStream(await listening(), `/api/logs/${session.id}/stream`, { Cookie: cookie }, abort);
    expect((await sendChunk(session.id, 0, ['a'])).body).toEqual({ continue: true });
    await s.waitFor((e) => e.some((x) => x.event === 'lines'));
    abort.abort();
    await until(() => !logsHubFor(bus).isLive(session.id));
    expect((await sendChunk(session.id, 1, ['b'])).body).toEqual({ continue: false });
  });

  it("refuses a chunk from an agent the read was not handed to", async () => {
    const { session } = await openedAndDispatched();
    const otherKey = makeKey();
    await enrol(db, otherKey);
    const res = await sendChunk(session.id, 0, ['x'], false, otherKey);
    expect(res.status).toBe(404);
  });
});

describe('the no-store rule (SHP-REQ-191)', () => {
  it('a malformed chunk is refused 400 and none of its body reaches a log or a table', async () => {
    const marker = `SECRET_MARKER_PASSWORD-${randomUUID()}`;
    const { session } = await openedAndDispatched();
    const path = `/api/agent/logs/${session.id}/chunks`;
    const text = `{"logsId":"${session.id}","seq":0,"lines":[{"text":"${marker}"`;
    const res = await request(app).post(path).set('content-type', 'application/json').send(text);
    expect(res.status).toBe(400);
    expect(err(res).code).toBe('invalid_request');
    expect(JSON.stringify(res.body)).not.toContain(marker);
    // The report path goes through the global error handler: the same holds there.
    const report = await request(app).post('/api/agent/report').set('content-type', 'application/json').send(`{"apps":[${marker}`);
    expect(report.status).toBe(400);

    expect(logged.join('')).not.toContain(marker);
    const tables = await db.$queryRawUnsafe<{ name: string }[]>(
      `select table_name as name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'`,
    );
    for (const { name } of tables) {
      const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`select count(*) as n from "${name.replace(/"/g, '""')}" t where t::text like $1`, `%${marker}%`);
      expect(Number(rows[0]?.n ?? 0), name).toBe(0);
    }
  });

  it('a marker sent in log lines reaches the viewer and no table, and nothing the server logged', async () => {
    const marker = `SHIPYARD-LOG-MARKER-${randomUUID()}`;
    const { session, cookie } = await openedAndDispatched();
    const s = await openStream(await listening(), `/api/logs/${session.id}/stream`, { Cookie: cookie }, new AbortController());
    await sendChunk(session.id, 0, [`token=${marker}`, `${marker} again`]);
    await sendChunk(session.id, 1, [marker], true);
    await s.waitFor((e) => e.some((x) => x.event === 'end'));
    // It did reach the viewer: the check below would pass vacuously otherwise.
    expect(JSON.stringify(s.events)).toContain(marker);

    // The tail read the MCP task uses goes the same way.
    const user = await db.user.findFirstOrThrow({ where: { role: 'admin' } });
    const caller: DeployCaller = {
      actor: { type: 'user', id: user.id, label: user.email },
      role: 'admin',
      tokenApps: undefined,
      audit: async (event) => {
        await db.auditEvent.create({
          data: { actorType: 'user', actorUserId: user.id, actorLabel: user.email, action: event.action, entityType: event.entityType, after: event.after as object },
        });
      },
    };
    const tail = readLogsTail(deps, caller, { containerId: WATCHTOWER.id, tail: 10 }, 10_000);
    await until(() => logsHubFor(bus).size >= 2);
    const job = logsOf(await poll(app, key, ['logs']));
    expect(job?.containerId).toBe(WATCHTOWER.id);
    await sendChunk(job?.logsId ?? '', 0, [`tail ${marker}`], true);
    const lines = await tail;
    expect(Array.isArray(lines) ? lines.map((l) => l.text) : lines).toEqual([`tail ${marker}`]);

    const tables = await db.$queryRawUnsafe<{ name: string }[]>(
      `select table_name as name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'`,
    );
    expect(tables.length).toBeGreaterThan(10);
    const hits: string[] = [];
    for (const { name } of tables) {
      const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`select count(*) as n from "${name.replace(/"/g, '""')}" t where t::text like $1`, `%${marker}%`);
      if (Number(rows[0]?.n ?? 0) > 0) hits.push(name);
    }
    expect(hits).toEqual([]);
    // The logger did log the session (so it was capturing), and never a line of content.
    expect(logged.join('')).toContain(session.id);
    expect(logged.join('')).not.toContain(marker);
  });
});
