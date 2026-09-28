import { createHmac, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import type { Refusal } from '@shipyard/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { WEBHOOK_AUDIT_ACTION, verifySignature } from '../../src/webhooks/index.js';

/**
 * SHP-T-7.5: POST /api/webhooks/github. A validly signed push to the default branch of a
 * `build: shipyard` app enqueues one build and answers after it committed (SHP-REQ-112); a bad or
 * missing signature, another ref, a deleted branch, a `build: github` app and a replayed delivery
 * each enqueue nothing and are recorded (SHP-REQ-113).
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const SECRET = 'webhook-secret-for-tests-0123456789';
const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret', GITHUB_WEBHOOK_SECRET: SECRET });
const logger = pino({ enabled: false });
const HEAD = 'a1b2c3d4e5'.repeat(4);
const REPO = 'matdemers1/foreman';

let app: Express;
let unaudited: string[];

function build(cfg: Config = config): Express {
  return createApp({
    db,
    logger,
    config: cfg,
    bus: new Bus(),
    onUnauditedMutation: (info) => {
      unaudited.push(`${info.method} ${info.path}`);
    },
  });
}

function manifest(name: string, source: 'shipyard' | 'github'): string {
  return JSON.stringify({
    name,
    repo: REPO,
    workflow: 'ci.yml',
    compose: { files: [`/data/${name}/compose.yml`], project: name },
    services: { web: { image: `ghcr.io/matdemers1/${name}` } },
    health: { service: 'web', port: 8080, path: '/health' },
    build: source === 'shipyard' ? { source: 'shipyard', releaseTargets: { web: 'release' } } : { source: 'github' },
  });
}

async function seedApp(name: string, source: 'shipyard' | 'github' = 'shipyard', repo = REPO): Promise<void> {
  const agent = await db.agent.create({ data: { publicKey: 'k', fingerprint: `fp-${randomUUID()}` } });
  await db.app.create({
    data: {
      name,
      agentId: agent.id,
      repo,
      defaultBranch: 'main',
      manifestYaml: manifest(name, source),
      manifestSha256: '0'.repeat(64),
      reportedAt: new Date(),
    },
  });
}

function pushBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ref: 'refs/heads/main',
    before: '0'.repeat(39) + '1',
    after: HEAD,
    deleted: false,
    repository: { full_name: 'MatDemers1/Foreman' },
    head_commit: { id: HEAD, message: 'SHP-T-7.5: a change' },
    ...overrides,
  });
}

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

interface Delivery {
  body?: string;
  event?: string;
  delivery?: string;
  signature?: string | null;
}

function deliver(target: Express, d: Delivery = {}): request.Test {
  const body = d.body ?? pushBody();
  let req = request(target)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', d.event ?? 'push')
    .set('X-GitHub-Delivery', d.delivery ?? randomUUID());
  if (d.signature !== null) req = req.set('X-Hub-Signature-256', d.signature ?? sign(body));
  return req.send(body);
}

async function webhookRows(): Promise<{ after: Record<string, unknown>; actorType: string; actorLabel: string }[]> {
  const rows = await db.auditEvent.findMany({ where: { action: WEBHOOK_AUDIT_ACTION }, orderBy: { at: 'asc' } });
  return rows.map((r) => ({ after: r.after as Record<string, unknown>, actorType: r.actorType, actorLabel: r.actorLabel }));
}

async function onlyWebhookRow(): Promise<Record<string, unknown>> {
  const rows = await webhookRows();
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) throw new Error('no row');
  expect(row).toMatchObject({ actorType: 'system', actorLabel: 'github-webhook' });
  return row.after;
}

async function assertNoSecretLeak(): Promise<void> {
  const rows = await db.auditEvent.findMany({ select: { after: true, before: true } });
  const text = JSON.stringify(rows);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain('sha256=');
  expect(text).not.toContain('SHP-T-7.5: a change');
}

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "build_log", "build_stage", "build", "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  unaudited = [];
  app = build();
});

afterEach(async () => {
  expect(unaudited).toEqual([]);
  await assertNoSecretLeak();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('verifySignature', () => {
  it('accepts the right HMAC and refuses a wrong, short, malformed or absent one without throwing', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySignature(SECRET, body, sign('{"a":1}'))).toBe(true);
    expect(verifySignature(SECRET, body, sign('{"a":2}'))).toBe(false);
    expect(verifySignature(SECRET, body, sign('{"a":1}', 'another-secret-0123456789'))).toBe(false);
    expect(verifySignature(SECRET, body, 'sha256=abcd')).toBe(false);
    expect(verifySignature(SECRET, body, `sha1=${'0'.repeat(40)}`)).toBe(false);
    expect(verifySignature(SECRET, body, 'garbage')).toBe(false);
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
  });
});

describe('POST /api/webhooks/github', () => {
  it('a validly signed push enqueues one build and answers only after the row exists', async () => {
    await seedApp('foreman');
    const delivery = randomUUID();
    const res = await deliver(app, { delivery });
    expect(res.status).toBe(202);
    const body = res.body as { builds: { app: string; buildId: string; created: boolean }[]; skipped: unknown[] };
    expect(body.skipped).toEqual([]);
    expect(body.builds).toHaveLength(1);
    expect(body.builds[0]).toMatchObject({ app: 'foreman', created: true });
    // The response followed the commit: the row is there the moment the answer arrives.
    const rows = await db.build.findMany({ select: { id: true, sha: true, state: true, trigger: true, requesterLabel: true } });
    expect(rows).toEqual([
      { id: body.builds[0]?.buildId, sha: HEAD, state: 'queued', trigger: 'webhook', requesterLabel: `github: push MatDemers1/Foreman@${HEAD.slice(0, 7)}` },
    ]);
    const after = await onlyWebhookRow();
    expect(after).toMatchObject({ deliveryId: delivery, event: 'push', repo: 'MatDemers1/Foreman', ref: 'refs/heads/main', sha: HEAD, outcome: 'accepted' });
    // The build itself is audited as build.request by the build service.
    expect(await db.auditEvent.count({ where: { action: 'build.request' } })).toBe(1);
  });

  it('enqueues a build for every app on the pushed repo', async () => {
    await seedApp('foreman');
    await seedApp('foreman-board');
    await seedApp('other', 'shipyard', 'matdemers1/other');
    const res = await deliver(app);
    expect(res.status).toBe(202);
    const builds = (res.body as { builds: { app: string }[] }).builds.map((b) => b.app);
    expect(builds).toEqual(['foreman', 'foreman-board']);
    expect(await db.build.count()).toBe(2);
    await onlyWebhookRow();
  });

  it('refuses a missing signature with 401, enqueues nothing and records it', async () => {
    await seedApp('foreman');
    const res = await deliver(app, { signature: null });
    expect(res.status).toBe(401);
    expect(err(res).code).toBe('unauthenticated');
    expect(await db.build.count()).toBe(0);
    expect(await onlyWebhookRow()).toMatchObject({ outcome: 'bad_signature', refusal: 'unauthenticated' });
  });

  it('refuses a signature made with another secret', async () => {
    await seedApp('foreman');
    const body = pushBody();
    const res = await deliver(app, { body, signature: sign(body, 'not-the-secret-0123456789') });
    expect(res.status).toBe(401);
    expect(await db.build.count()).toBe(0);
    expect(await onlyWebhookRow()).toMatchObject({ outcome: 'bad_signature' });
  });

  it('refuses a signature over a different body', async () => {
    await seedApp('foreman');
    const res = await deliver(app, { body: pushBody(), signature: sign(pushBody({ after: 'f'.repeat(40) })) });
    expect(res.status).toBe(401);
    expect(await db.build.count()).toBe(0);
    await onlyWebhookRow();
  });

  it('refuses a malformed signature header without throwing', async () => {
    await seedApp('foreman');
    for (const signature of ['sha256=zz', 'sha256=', `sha256=${'0'.repeat(63)}`, 'sha1=abc']) {
      const res = await deliver(app, { signature });
      expect(res.status).toBe(401);
    }
    expect(await db.build.count()).toBe(0);
    expect(await webhookRows()).toHaveLength(4);
  });

  it('a push to another branch enqueues nothing and is recorded', async () => {
    await seedApp('foreman');
    const res = await deliver(app, { body: pushBody({ ref: 'refs/heads/feature' }) });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ builds: [], skipped: [{ app: 'foreman', reason: 'not_default_branch' }] });
    expect(await db.build.count()).toBe(0);
    expect(await onlyWebhookRow()).toMatchObject({ outcome: 'accepted', ref: 'refs/heads/feature', skipped: [{ app: 'foreman', reason: 'not_default_branch' }] });
  });

  it('a tag push enqueues nothing', async () => {
    await seedApp('foreman');
    const res = await deliver(app, { body: pushBody({ ref: 'refs/tags/main' }) });
    expect(res.status).toBe(202);
    expect(await db.build.count()).toBe(0);
    await onlyWebhookRow();
  });

  it('a deleted default branch enqueues nothing', async () => {
    await seedApp('foreman');
    const res = await deliver(app, { body: pushBody({ deleted: true, after: '0'.repeat(40) }) });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ builds: [], skipped: [{ app: 'foreman', reason: 'branch_deleted' }] });
    expect(await db.build.count()).toBe(0);
    await onlyWebhookRow();
  });

  it('a build: github app is skipped and recorded', async () => {
    await seedApp('foreman', 'github');
    const res = await deliver(app);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ builds: [], skipped: [{ app: 'foreman', reason: 'not_built_by_shipyard' }] });
    expect(await db.build.count()).toBe(0);
    expect(await onlyWebhookRow()).toMatchObject({ outcome: 'accepted', skipped: [{ app: 'foreman', reason: 'not_built_by_shipyard' }] });
  });

  it('a push for a repo with no app enqueues nothing and is recorded', async () => {
    const res = await deliver(app);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ builds: [], skipped: [] });
    await onlyWebhookRow();
  });

  it('answers ping with 200 and records it', async () => {
    const res = await deliver(app, { event: 'ping', body: JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 }) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await onlyWebhookRow()).toMatchObject({ event: 'ping', outcome: 'ping' });
  });

  it('ignores any other event with 202 and records it', async () => {
    await seedApp('foreman');
    const res = await deliver(app, { event: 'pull_request' });
    expect(res.status).toBe(202);
    expect(await db.build.count()).toBe(0);
    expect(await onlyWebhookRow()).toMatchObject({ event: 'pull_request', outcome: 'ignored' });
  });

  it('a validly signed body that is not JSON is a 400, recorded', async () => {
    await seedApp('foreman');
    const res = await deliver(app, { body: 'payload=%7B%7D' });
    expect(res.status).toBe(400);
    expect(await db.build.count()).toBe(0);
    expect(await onlyWebhookRow()).toMatchObject({ outcome: 'bad_request', refusal: 'invalid_request' });
  });

  it('a body over 1 MB is refused and recorded', async () => {
    await seedApp('foreman');
    const res = await deliver(app, { body: pushBody({ padding: 'x'.repeat(1_100_000) }) });
    expect(res.status).toBe(413);
    expect(await db.build.count()).toBe(0);
    await onlyWebhookRow();
  });

  it('a replayed delivery ID enqueues nothing and is recorded, even after the first build finished and across a restart', async () => {
    await seedApp('foreman');
    const delivery = randomUUID();
    const first = await deliver(app, { delivery });
    expect(first.status).toBe(202);
    expect(await db.build.count()).toBe(1);

    // Same process: the in-memory LRU.
    const again = await deliver(app, { delivery });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, replayed: true });

    // The build finishes, so the build service's own open-build idempotency no longer applies,
    // and the server restarts, so the LRU is empty: the audit table still catches it.
    await db.build.updateMany({ data: { state: 'succeeded', endedAt: new Date() } });
    const restarted = build();
    const replay = await deliver(restarted, { delivery });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ok: true, replayed: true });
    expect(await db.build.count()).toBe(1);
    const outcomes = (await webhookRows()).map((r) => r.after['outcome']);
    expect(outcomes).toEqual(['accepted', 'replayed', 'replayed']);
  });

  it('a delivery refused on our side can be redelivered with the same ID', async () => {
    await seedApp('foreman');
    const delivery = randomUUID();
    const bad = await deliver(app, { delivery, signature: sign(pushBody(), 'wrong-secret-0123456789') });
    expect(bad.status).toBe(401);
    const good = await deliver(app, { delivery });
    expect(good.status).toBe(202);
    expect(await db.build.count()).toBe(1);
  });

  it('with no secret configured, answers 503, enqueues nothing and records it', async () => {
    await seedApp('foreman');
    const unconfigured = build(loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' }));
    const res = await deliver(unconfigured);
    expect(res.status).toBe(503);
    expect(err(res).message).toMatch(/not configured/);
    expect(await db.build.count()).toBe(0);
    expect(await onlyWebhookRow()).toMatchObject({ outcome: 'not_configured' });
  });

  it('refuses a too-short secret at config load', () => {
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, GITHUB_WEBHOOK_SECRET: 'short' })).toThrow();
  });
});
