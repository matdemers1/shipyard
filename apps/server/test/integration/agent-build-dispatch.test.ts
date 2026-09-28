import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, signingString, type BuildJob, type PollResponse, type Refusal } from '@shipyard/schema';
import { BUILD_STALE_MINUTES } from '../../src/agent/dispatch.js';
import { createApp } from '../../src/app.js';
import { enqueueBuild, getBuild, isRefusal, requestCancel } from '../../src/builds/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { createDeploy, type DeployCaller } from '../../src/deploys/service.js';
import { Bus } from '../../src/events.js';

/**
 * SHP-T-7.9: builds over the agent's long poll. A build is handed out only to a poll that asks for
 * one, only when no build is running and none of the agent's deploy targets is in flight
 * (SHP-REQ-129, SHP-REQ-130); progress and results are accepted only from the owning agent; and a
 * running build whose agent went silent is failed `interrupted` so the queue moves on.
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

function manifest(name: string): string {
  return JSON.stringify({
    name,
    repo: `matdemers1/${name}`,
    workflow: 'ci.yml',
    compose: { files: [`/data/${name}/compose.yml`], project: name },
    services: { web: { image: `ghcr.io/matdemers1/${name}` } },
    health: { service: 'web', port: 8080, path: '/health' },
    build: { source: 'shipyard', releaseTargets: { web: 'release' } },
  });
}

let bus: Bus;
let app: Express;
let deps: ServiceDeps;
let key: Key;
let otherKey: Key;
let agentId: string;
let caller: DeployCaller;

async function post(path: string, body: unknown, k: Key = key) {
  const text = JSON.stringify(body);
  return request(app).post(path).set(signed(k, path, text)).send(text);
}

async function poll(opts: { build?: boolean; key?: Key; waitSeconds?: number } = {}): Promise<PollResponse> {
  const res = await post(
    '/api/agent/poll',
    { waitSeconds: opts.waitSeconds ?? 0, ...(opts.build === true ? { capabilities: ['build'] } : {}) },
    opts.key ?? key,
  );
  expect(res.status).toBe(200);
  return res.body as PollResponse;
}

function buildOf(r: PollResponse): BuildJob | undefined {
  return 'build' in r ? r.build : undefined;
}

async function enrol(k: Key): Promise<string> {
  const row = await db.agent.create({ data: { publicKey: k.b64, fingerprint: k.fingerprint, confirmedAt: new Date() } });
  return row.id;
}

async function seedApp(name: string, owner: string): Promise<void> {
  await db.app.create({
    data: {
      name,
      agentId: owner,
      manifestYaml: manifest(name),
      manifestSha256: '0'.repeat(64),
      reportedAt: new Date(),
      services: { web: { image: `ghcr.io/matdemers1/${name}` } },
    },
  });
}

async function enqueue(appName: string, commit: string): Promise<string> {
  const result = await enqueueBuild(deps, { app: appName, sha: commit, trigger: 'manual', requester: { label: 'test' } });
  if (isRefusal(result)) throw new Error(result.message);
  return result.buildId;
}

/** Pushes every sign of life on `buildId` back past the stale limit. */
async function ageBuild(buildId: string, minutes = BUILD_STALE_MINUTES + 1): Promise<void> {
  const past = new Date(Date.now() - minutes * 60_000);
  await db.$executeRaw`update "build" set "dispatched_at" = ${past}, "started_at" = ${past}, "updated_at" = ${past} where "id" = ${buildId}::uuid`;
  await db.$executeRaw`update "build_stage" set "started_at" = ${past}, "ended_at" = case when "ended_at" is null then null else ${past}::timestamptz end where "build_id" = ${buildId}::uuid`;
  await db.$executeRaw`update "build_log" set "at" = ${past} where "build_id" = ${buildId}::uuid`;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "build_log", "build_stage", "build", "backup_artifact", "outbox", "drift_event", "target_image", "step", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "app", "agent", "session", "user" cascade',
  );
  key = makeKey();
  otherKey = makeKey();
  agentId = await enrol(key);
  const otherAgentId = await enrol(otherKey);
  await seedApp('web', agentId);
  await seedApp('api', agentId);
  await seedApp('elsewhere', otherAgentId);
  bus = new Bus();
  deps = { db, logger, config, bus };
  app = createApp({ db, logger, config, bus });
  const user = await db.user.create({ data: { email: `svc-${randomUUID()}@example.com`, displayName: 'svc', role: 'deployer' } });
  caller = { actor: { type: 'user', id: user.id, label: user.email }, role: 'deployer', tokenApps: undefined, audit: () => Promise.resolve() };
});

afterAll(async () => {
  await db.$disconnect();
});

describe('POST /api/agent/poll hands out builds (SHP-REQ-129, SHP-REQ-130)', () => {
  it('never to a poll without the build capability', async () => {
    const buildId = await enqueue('web', sha('a'));
    expect(await poll()).toEqual({ target: null });
    expect((await getBuild(db, buildId))?.state).toBe('queued');
  });

  it('doneWhen: only when none is running — one at a time, FIFO', async () => {
    const first = await enqueue('web', sha('a'));
    const second = await enqueue('api', sha('b'));
    const job = buildOf(await poll({ build: true }));
    expect(job).toEqual({ buildId: first, app: 'web', sha: sha('a'), requesterLabel: 'test' });
    expect((await getBuild(db, first))?.state).toBe('running');
    expect(await db.auditEvent.count({ where: { action: 'build.dispatched', actorAgentId: agentId, entityId: first } })).toBe(1);

    // One is running: the next poll gets nothing, and the second stays queued.
    expect(await poll({ build: true })).toEqual({ target: null });
    expect((await getBuild(db, second))?.state).toBe('queued');

    const done = await post('/api/agent/build-result', { buildId: first, state: 'succeeded', digests: { web: DIGEST } });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ accepted: true, state: 'succeeded' });
    expect(buildOf(await poll({ build: true }))?.buildId).toBe(second);
  });

  it('a waiting poll is woken by a queued build', async () => {
    const pending = poll({ build: true, waitSeconds: 10 });
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    const buildId = await enqueue('web', sha('a'));
    const res = await pending;
    expect(buildOf(res)?.buildId).toBe(buildId);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('deploys first, and no build while one of its targets is in flight', async () => {
    const buildId = await enqueue('web', sha('a'));
    const accepted = await createDeploy(deps, caller, { kind: 'deploy', app: 'api', sha: sha('c') }, { check: () => Promise.resolve(null) });
    if (isRefusal(accepted)) throw new Error(accepted.message);

    const first = await poll({ build: true });
    expect(first.target?.deployId).toBe(accepted.deployId);
    const targetId = first.target?.targetId ?? '';
    // The target is in flight on this agent's host: the build waits.
    expect(await poll({ build: true })).toEqual({ target: null });
    expect((await getBuild(db, buildId))?.state).toBe('queued');

    const result = await post('/api/agent/result', {
      targetId,
      state: 'failed',
      images: [],
      refusal: { code: 'step_failed', gate: 'none', message: 'failed', fix: 'fix it' },
    });
    expect(result.status).toBe(200);
    expect(buildOf(await poll({ build: true }))?.buildId).toBe(buildId);
  });

  it("never hands another agent's build out, and leaves it queued for its agent", async () => {
    const theirs = await enqueue('elsewhere', sha('a'));
    expect(await poll({ build: true })).toEqual({ target: null });
    expect((await getBuild(db, theirs))?.state).toBe('queued');
    expect(buildOf(await poll({ build: true, key: otherKey }))?.buildId).toBe(theirs);
  });
});

describe('POST /api/agent/build-progress and /build-result', () => {
  it("answer 404 for another agent's build, or one never dispatched", async () => {
    const theirs = await enqueue('elsewhere', sha('a'));
    expect(buildOf(await poll({ build: true, key: otherKey }))?.buildId).toBe(theirs);
    const at = new Date().toISOString();

    const progress = await post('/api/agent/build-progress', { buildId: theirs, stage: 'test', state: 'running', at });
    expect(progress.status).toBe(404);
    expect((progress.body as { error: Refusal }).error.code).toBe('not_found');
    const result = await post('/api/agent/build-result', { buildId: theirs, state: 'failed', digests: {} });
    expect(result.status).toBe(404);
    expect((await getBuild(db, theirs))?.state).toBe('running');

    await post('/api/agent/build-result', { buildId: theirs, state: 'cancelled', digests: {} }, otherKey);
    const queued = await enqueue('web', sha('b'));
    const early = await post('/api/agent/build-progress', { buildId: queued, stage: 'test', state: 'running', at });
    expect(early.status).toBe(404);
    const junk = await post('/api/agent/build-progress', { buildId: 'not-a-uuid', stage: 'test', state: 'running', at });
    expect(junk.status).toBe(404);
  });

  it('records stages and logs, relays a cancel, and a heartbeat reopens nothing', async () => {
    const buildId = await enqueue('web', sha('a'));
    buildOf(await poll({ build: true }));
    const at = (): string => new Date().toISOString();

    const running = await post('/api/agent/build-progress', { buildId, stage: 'test', state: 'running', at: at() });
    expect(running.body).toEqual({ cancel: false });
    const passed = await post('/api/agent/build-progress', { buildId, stage: 'test', state: 'succeeded', log: 'ok', at: at() });
    expect(passed.body).toEqual({ cancel: false });
    expect(await db.auditEvent.count({ where: { action: 'build.progress', entityId: buildId } })).toBe(2);

    // A heartbeat for the finished stage leaves it finished, and bumps the build's sign of life.
    const before = (await db.build.findUniqueOrThrow({ where: { id: buildId } })).updatedAt;
    await new Promise((r) => setTimeout(r, 20));
    const beat = await post('/api/agent/build-progress', { buildId, stage: 'test', state: 'running', at: at() });
    expect(beat.status).toBe(200);
    expect(beat.body).toEqual({ cancel: false });
    const detail = await getBuild(db, buildId);
    expect(detail?.stages).toEqual([expect.objectContaining({ stage: 'test', state: 'succeeded' })]);
    expect((await db.build.findUniqueOrThrow({ where: { id: buildId } })).updatedAt.getTime()).toBeGreaterThan(before.getTime());
    expect(await db.auditEvent.count({ where: { action: 'build.progress', entityId: buildId } })).toBe(2);

    const cancel = await requestCancel(deps, buildId, { actor: { type: 'system', label: 'test' } });
    expect(isRefusal(cancel)).toBe(false);
    const next = await post('/api/agent/build-progress', { buildId, stage: 'test', state: 'running', at: at() });
    expect(next.body).toEqual({ cancel: true });

    const ended = await post('/api/agent/build-result', { buildId, state: 'cancelled', digests: {} });
    expect(ended.body).toEqual({ accepted: true, state: 'cancelled' });
    const again = await post('/api/agent/build-result', { buildId, state: 'cancelled', digests: {} });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ accepted: false, state: 'cancelled' });
    expect(await db.auditEvent.count({ where: { action: 'build.result', entityId: buildId } })).toBe(1);
    // Progress for an ended build tells the agent to stop.
    const late = await post('/api/agent/build-progress', { buildId, stage: 'build', state: 'running', at: at() });
    expect(late.body).toEqual({ cancel: true });
  });
});

describe(`the stale sweep (${String(BUILD_STALE_MINUTES)} minutes)`, () => {
  it('doneWhen: a running build left by an agent that stopped reporting is failed interrupted, and the queue moves on', async () => {
    const stuck = await enqueue('web', sha('a'));
    expect(buildOf(await poll({ build: true }))?.buildId).toBe(stuck);
    await post('/api/agent/build-progress', { buildId: stuck, stage: 'test', state: 'running', log: 'step 1', at: new Date().toISOString() });
    const next = await enqueue('api', sha('b'));

    // Recent activity: not swept, and the slot stays taken.
    expect(await poll({ build: true })).toEqual({ target: null });
    expect((await getBuild(db, stuck))?.state).toBe('running');

    await ageBuild(stuck);
    const res = await poll({ build: true });
    const swept = await getBuild(db, stuck);
    expect(swept).toMatchObject({ state: 'failed', failedStage: 'test', refusal: { code: 'interrupted' } });
    expect(swept?.refusal?.message).toContain('stopped reporting');
    expect(swept?.endedAt).not.toBeNull();
    expect(await db.auditEvent.count({ where: { action: 'build.interrupted', entityId: stuck } })).toBe(1);
    expect(buildOf(res)?.buildId).toBe(next);

    // The dead agent's late result changes nothing.
    const late = await post('/api/agent/build-result', { buildId: stuck, state: 'succeeded', digests: { web: DIGEST } });
    expect(late.body).toEqual({ accepted: false, state: 'failed' });
  });

  it('a heartbeat keeps a long build alive', async () => {
    const buildId = await enqueue('web', sha('a'));
    buildOf(await poll({ build: true }));
    await post('/api/agent/build-progress', { buildId, stage: 'test', state: 'running', at: new Date().toISOString() });
    await ageBuild(buildId);
    // Only the heartbeat is recent.
    const beat = await post('/api/agent/build-progress', { buildId, stage: 'test', state: 'running', at: new Date().toISOString() });
    expect(beat.body).toEqual({ cancel: false });
    await poll({ build: true });
    expect((await getBuild(db, buildId))?.state).toBe('running');
  });

  it('sweeps even for a poll that does not ask for builds', async () => {
    const buildId = await enqueue('web', sha('a'));
    buildOf(await poll({ build: true }));
    await ageBuild(buildId);
    await poll();
    expect(await getBuild(db, buildId)).toMatchObject({ state: 'failed', refusal: { code: 'interrupted' } });
  });
});
