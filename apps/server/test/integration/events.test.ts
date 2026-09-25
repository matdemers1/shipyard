import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import type { DeployStatus, Refusal } from '@shipyard/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { StepView } from '../../src/deploys/events.js';
import { Bus } from '../../src/events.js';

/** Live deploy progress over SSE (SHP-T-3.4, SHP-REQ-058) and the steps contract. */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });
const SHA = 'c'.repeat(40);

let bus: Bus;
let app: Express;
let server: Server | null = null;

function listenerCount(topic: string): number {
  return (bus as unknown as { emitter: EventEmitter }).emitter.listenerCount(topic);
}

async function signIn(role: 'admin' | 'deployer' | 'viewer'): Promise<string> {
  const user = await db.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return `${SESSION_COOKIE}=${session.token}`;
}

async function seed(): Promise<{ deployId: string; targetId: string }> {
  const agent = await db.agent.create({ data: { publicKey: 'k', fingerprint: `fp-${randomUUID()}` } });
  const web = await db.app.create({
    data: { name: 'web', agentId: agent.id, manifestYaml: 'name: web\n', manifestSha256: '0'.repeat(64), reportedAt: new Date() },
  });
  await db.app.create({
    data: { name: 'api', agentId: agent.id, manifestYaml: 'name: api\n', manifestSha256: '0'.repeat(64), reportedAt: new Date() },
  });
  const deploy = await db.deploy.create({
    data: {
      kind: 'deploy',
      requestedSha: SHA,
      requesterLabel: 'matt (console)',
      targets: { create: { appId: web.id, state: 'verifying', currentStep: 'verify' } },
    },
    select: { id: true, targets: { select: { id: true } } },
  });
  return { deployId: deploy.id, targetId: deploy.targets[0]?.id ?? '' };
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** An SSE client over fetch: the parsed events so far, and a way to wait for more. */
async function openStream(path: string, cookie: string, controller: AbortController) {
  if (server === null) {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server?.once('listening', () => { resolve(); }));
  }
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const events: SseEvent[] = [];
  let buffer = '';
  let ended = false;
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
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
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data !== '') events.push({ event, data: JSON.parse(data) as unknown });
          cut = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted */
    }
    ended = true;
  })();
  async function waitFor(pred: (e: SseEvent[]) => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!pred(events)) {
      if (Date.now() - start > ms) throw new Error(`timed out; events: ${JSON.stringify(events.map((e) => e.event))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return { res, events, waitFor, pump, isEnded: () => ended };
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  bus = new Bus();
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

describe('GET /api/deploys/:id/steps', () => {
  it('returns the steps contract ordered by startedAt', async () => {
    const { deployId, targetId } = await seed();
    const t0 = new Date('2026-09-24T10:00:00Z');
    await db.step.create({
      data: { targetId, name: 'backup', argv: ['pg_dump', 'web'], startedAt: new Date(t0.getTime() + 5000) },
    });
    await db.step.create({
      data: {
        targetId,
        name: 'verify',
        argv: ['gh', 'api'],
        startedAt: t0,
        endedAt: new Date(t0.getTime() + 1000),
        exitCode: 0,
        output: 'ok',
      },
    });
    const cookie = await signIn('viewer');
    const res = await request(app).get(`/api/deploys/${deployId}/steps`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      steps: [
        { name: 'verify', argv: ['gh', 'api'], startedAt: '2026-09-24T10:00:00.000Z', endedAt: '2026-09-24T10:00:01.000Z', exitCode: 0, output: 'ok' },
        { name: 'backup', argv: ['pg_dump', 'web'], startedAt: '2026-09-24T10:00:05.000Z', endedAt: null, exitCode: null, output: null },
      ] satisfies StepView[],
    });
  });

  it('404s an unknown deploy and 401s nobody', async () => {
    const cookie = await signIn('viewer');
    const missing = await request(app).get(`/api/deploys/${randomUUID()}/steps`).set('Cookie', cookie);
    expect(missing.status).toBe(404);
    const anon = await request(app).get(`/api/deploys/${randomUUID()}/steps`);
    expect(anon.status).toBe(401);
  });
});

describe('GET /api/deploys/:id/events', () => {
  it('sends status and steps at once, a new status on publish, and closes on a terminal state', async () => {
    const { deployId, targetId } = await seed();
    const cookie = await signIn('viewer');
    const abort = new AbortController();
    const s = await openStream(`/api/deploys/${deployId}/events`, cookie, abort);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');
    expect(s.res.headers.get('cache-control')).toBe('no-cache');
    expect(s.res.headers.get('x-accel-buffering')).toBe('no');

    await s.waitFor((e) => e.length >= 2);
    expect(s.events[0]?.event).toBe('status');
    expect((s.events[0]?.data as DeployStatus).state).toBe('verifying');
    expect(s.events[1]).toEqual({ event: 'steps', data: { steps: [] } });
    await s.waitFor(() => listenerCount(`deploy:${deployId}`) === 1);

    // A publish with nothing changed sends nothing (deduped).
    bus.publish(`deploy:${deployId}`);
    await s.waitFor(() => listenerCount(`deploy:${deployId}`) === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.events).toHaveLength(2);

    await db.deployTarget.update({ where: { id: targetId }, data: { state: 'pulling', currentStep: 'pull' } });
    await db.step.create({ data: { targetId, name: 'pull', argv: ['docker', 'pull'] } });
    bus.publish(`deploy:${deployId}`);
    await s.waitFor((e) => e.some((x) => x.event === 'status' && (x.data as DeployStatus).state === 'pulling'));
    await s.waitFor((e) => e.filter((x) => x.event === 'steps').length === 2);
    const lastSteps = s.events.filter((x) => x.event === 'steps').at(-1)?.data as { steps: StepView[] };
    expect(lastSteps.steps.map((x) => x.name)).toEqual(['pull']);

    await db.deployTarget.update({
      where: { id: targetId },
      data: { state: 'succeeded', schemaRevision: '0007_init', endedAt: new Date() },
    });
    bus.publish(`deploy:${deployId}`);
    await s.waitFor(() => s.isEnded());
    const statuses = s.events.filter((x) => x.event === 'status').map((x) => (x.data as DeployStatus).state);
    expect(statuses).toEqual(['verifying', 'pulling', 'succeeded']);
    expect(s.events.at(-1)).toEqual({ event: 'end', data: { state: 'succeeded' } });
    expect(listenerCount(`deploy:${deployId}`)).toBe(0);
  });

  it('a client gone before the first read leaves no listener behind (50 raw connect-and-drop)', async () => {
    const { deployId } = await seed();
    const cookie = await signIn('viewer');
    if (server === null) {
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server?.once('listening', () => { resolve(); }));
    }
    const { port } = server.address() as AddressInfo;
    const { request: httpRequest } = await import('node:http');
    for (let i = 0; i < 50; i += 1) {
      const req = httpRequest({ host: '127.0.0.1', port, path: `/api/deploys/${deployId}/events`, headers: { Cookie: cookie } });
      req.on('error', () => undefined);
      req.end();
      // Dropped before the server has answered anything.
      req.destroy();
    }
    const start = Date.now();
    while (listenerCount(`deploy:${deployId}`) !== 0 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(listenerCount(`deploy:${deployId}`)).toBe(0);
  });

  it('a terminal deploy sends its state and closes at once (reconnect gets the full state)', async () => {
    const { deployId, targetId } = await seed();
    await db.deployTarget.update({ where: { id: targetId }, data: { state: 'failed', endedAt: new Date() } });
    const cookie = await signIn('viewer');
    const s = await openStream(`/api/deploys/${deployId}/events`, cookie, new AbortController());
    await s.waitFor(() => s.isEnded());
    expect(s.events.map((e) => e.event)).toEqual(['status', 'steps', 'end']);
    expect(listenerCount(`deploy:${deployId}`)).toBe(0);
  });

  it('a client abort leaves no bus listener behind', async () => {
    const { deployId } = await seed();
    const cookie = await signIn('viewer');
    const abort = new AbortController();
    const s = await openStream(`/api/deploys/${deployId}/events`, cookie, abort);
    await s.waitFor((e) => e.length >= 2);
    await s.waitFor(() => listenerCount(`deploy:${deployId}`) === 1);
    abort.abort();
    await s.pump;
    const start = Date.now();
    while (listenerCount(`deploy:${deployId}`) !== 0 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(listenerCount(`deploy:${deployId}`)).toBe(0);
  });

  it('refuses a token scoped to another app, before any stream opens', async () => {
    const { deployId } = await seed();
    const cookie = await signIn('deployer');
    const issued = await request(app).post('/api/tokens').set('Cookie', cookie).send({ label: 'mcp', apps: ['api'] });
    expect(issued.status).toBe(201);
    const token = (issued.body as { token: string }).token;

    for (const path of ['events', 'steps']) {
      const res = await request(app).get(`/api/deploys/${deployId}/${path}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect((res.body as { error: Refusal }).error.code).toBe('forbidden');
    }
    expect(listenerCount(`deploy:${deployId}`)).toBe(0);

    const scoped = await request(app).post('/api/tokens').set('Cookie', cookie).send({ label: 'mcp', apps: ['web'] });
    const ok = await request(app)
      .get(`/api/deploys/${deployId}/steps`)
      .set('Authorization', `Bearer ${(scoped.body as { token: string }).token}`);
    expect(ok.status).toBe(200);
  });
});
