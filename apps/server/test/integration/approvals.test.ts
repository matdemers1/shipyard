import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { ACTIVE_STATES, type DeployAccepted, type DeployStatus, type Refusal } from '@shipyard/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { expireApprovals, pendingApprovalsRouter, type PendingApproval } from '../../src/approvals/index.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { claimTarget } from '../../src/agent/dispatch.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import type { ServiceDeps } from '../../src/deps.js';
import { waitForChange } from '../../src/deploys/service.js';
import { Bus } from '../../src/events.js';
import { generateToken } from '../../src/tokens/tokens.js';

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

let bus: Bus;
let deps: ServiceDeps;
let app: Express;
let server: Server;
let baseUrl: string;
let agentId: string;
let appIds: Map<string, string>;
const clients: Client[] = [];

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

function err(res: { body: unknown }): Refusal {
  return (res.body as { error: Refusal }).error;
}

async function signIn(role: Role): Promise<{ userId: string; email: string; cookie: string }> {
  const email = `${role}-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, displayName: role, role } });
  const session = await createSession(db, { userId: user.id, method: 'password' });
  return { userId: user.id, email, cookie: `${SESSION_COOKIE}=${session.token}` };
}

/** A deployer's token scoped to `apps`; returns the plaintext token. */
async function tokenFor(label: string, apps: string[]): Promise<string> {
  const user = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.com`, displayName: label, role: 'deployer' } });
  const { token, hash, prefix } = generateToken();
  await db.apiToken.create({
    data: { userId: user.id, label, tokenHash: hash, prefix, apps: { create: apps.map((a) => ({ appId: appIds.get(a) ?? '' })) } },
  });
  return token;
}

async function seedApps(): Promise<Map<string, string>> {
  const agent = await db.agent.create({ data: { publicKey: 'test-key', fingerprint: `fp-${randomUUID()}` } });
  agentId = agent.id;
  const ids = new Map<string, string>();
  for (const [name, approvalPolicy] of [
    ['d3auth', 'required'],
    ['web', 'none'],
  ] as const) {
    const row = await db.app.create({
      data: {
        name,
        agentId: agent.id,
        manifestYaml: `name: ${name}\napproval: ${approvalPolicy}\n`,
        manifestSha256: '0'.repeat(64),
        repo: `matdemers1/${name}`,
        defaultBranch: 'main',
        reportedAt: new Date(),
        approvalPolicy,
      },
    });
    ids.set(name, row.id);
  }
  return ids;
}

async function activeCount(appId: string): Promise<number> {
  return db.deployTarget.count({ where: { appId, state: { in: [...ACTIVE_STATES] } } });
}

const requester = (label: string) => ({ repo: 'matdemers1/d3-auth', branch: 'main', label });

/** A token (agent) deploy request over REST, as MCP's `shipyard_deploy` makes it. */
async function agentDeploy(token: string, appName: string, sha = SHA_A, label = 'claude: session A'): Promise<DeployAccepted> {
  const res = await request(app)
    .post('/api/deploys')
    .set('Authorization', `Bearer ${token}`)
    .send({ kind: 'deploy', app: appName, sha, requester: requester(label) });
  expect(res.status).toBe(201);
  return res.body as DeployAccepted;
}

async function targetOf(deployId: string) {
  return db.deployTarget.findFirstOrThrow({ where: { deployId } });
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'approvals-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as Transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function okOf(result: ToolResult): DeployStatus {
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0]?.text ?? '') as DeployStatus;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "approval", "target_image", "step", "outbox", "drift_event", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  appIds = await seedApps();
  bus = new Bus();
  deps = { db, logger, config, bus };
  // GET /approvals is mounted through the test seam (at /api/_test) until app.ts mounts it at /api.
  app = createApp({ db, logger, config, bus, testRouter: pendingApprovalsRouter(deps) });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('holding agent-requested deploys (SHP-REQ-060)', () => {
  it('a token deploy of an approval-required app waits, without the lock, for an hour', async () => {
    const token = await tokenFor('claude', ['d3auth']);
    const before = Date.now();
    const accepted = await agentDeploy(token, 'd3auth');
    expect(accepted.state).toBe('awaiting_approval');

    expect(await activeCount(appIds.get('d3auth') ?? '')).toBe(0);
    const target = await targetOf(accepted.deployId);
    expect(target.state).toBe('awaiting_approval');
    const approval = await db.approval.findUniqueOrThrow({ where: { deployId: accepted.deployId } });
    const ttl = approval.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
    // The agent's poll has nothing to take.
    expect(await claimTarget(db, agentId)).toBeNull();
  });

  it('a token rollback of an approval-required app is held too', async () => {
    const earlier = await db.deploy.create({
      data: { requestedSha: SHA_B, requesterLabel: 'earlier', targets: { create: { appId: appIds.get('d3auth') ?? '', state: 'succeeded', endedAt: new Date(), dispatchedAt: new Date() } } },
      select: { id: true },
    });
    const token = await tokenFor('claude', ['d3auth']);
    const res = await request(app)
      .post('/api/deploys')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'rollback', app: 'd3auth', toDeployId: earlier.id, requester: requester('claude: rollback') });
    expect(res.status).toBe(201);
    expect((res.body as DeployAccepted).state).toBe('awaiting_approval');
  });

  it('a console deployer deploy of the same app is not held; nor is a token deploy of an app with approval: none', async () => {
    const deployer = await signIn('deployer');
    const res = await request(app).post('/api/deploys').set('Cookie', deployer.cookie).send({ kind: 'deploy', app: 'd3auth', sha: SHA_A });
    expect(res.status).toBe(201);
    expect((res.body as DeployAccepted).state).toBe('locked');
    expect(await db.approval.count()).toBe(0);

    const token = await tokenFor('claude', ['web']);
    expect((await agentDeploy(token, 'web')).state).toBe('locked');
  });

  it('a dry run through a token is never held', async () => {
    const token = await tokenFor('claude', ['d3auth']);
    const res = await request(app)
      .post('/api/deploys')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'deploy', app: 'd3auth', sha: SHA_A, dryRun: true, requester: requester('claude') });
    expect((res.body as DeployAccepted).state).toBe('queued');
  });
});

describe('approve and deny (console only)', () => {
  it('approve moves the target to locked, where the poll picks it up, and is audited', async () => {
    const token = await tokenFor('claude', ['d3auth']);
    const { deployId } = await agentDeploy(token, 'd3auth');
    const deployer = await signIn('deployer');

    let work = 0;
    const orig = bus.publish.bind(bus);
    bus.publish = (topic) => {
      if (topic === 'work') work += 1;
      orig(topic);
    };

    const res = await request(app).post(`/api/deploys/${deployId}/approve`).set('Cookie', deployer.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deployId, state: 'locked' });
    expect(work).toBe(1);

    const target = await targetOf(deployId);
    expect(target.state).toBe('locked');
    expect(target.dispatchedAt).toBeNull();
    const approval = await db.approval.findUniqueOrThrow({ where: { deployId } });
    expect(approval.approvedAt).not.toBeNull();
    expect(approval.decidedByUserId).toBe(deployer.userId);
    expect(await claimTarget(db, agentId)).toBe(target.id);

    const audit = await db.auditEvent.findMany({ where: { action: 'deploy.approved', entityId: deployId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(deployer.userId);

    // Approving twice is refused.
    const again = await request(app).post(`/api/deploys/${deployId}/approve`).set('Cookie', deployer.cookie);
    expect(err(again).code).toBe('conflict');
  });

  it('approving a held deploy of an app that drifted while it waited is refused drift_unresolved (G3)', async () => {
    const token = await tokenFor('claude', ['d3auth']);
    const { deployId } = await agentDeploy(token, 'd3auth');
    const drifted = await db.app.update({ where: { name: 'd3auth' }, data: { driftedAt: new Date() } });
    await db.driftEvent.create({ data: { appId: drifted.id, observed: { server: 'sha256:b' }, recorded: { server: 'sha256:a' } } });
    const deployer = await signIn('deployer');
    const res = await request(app).post(`/api/deploys/${deployId}/approve`).set('Cookie', deployer.cookie);
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string; gate: string } }).error).toMatchObject({ code: 'drift_unresolved', gate: 'G3' });
    expect((await targetOf(deployId)).state).toBe('awaiting_approval');
  });

  it('approving while another deploy holds the app is refused locked, naming the holder, and stays awaiting', async () => {
    const token = await tokenFor('claude', ['d3auth']);
    const { deployId } = await agentDeploy(token, 'd3auth');
    const deployer = await signIn('deployer');
    const holder = await request(app).post('/api/deploys').set('Cookie', deployer.cookie).send({ kind: 'deploy', app: 'd3auth', sha: SHA_B });
    expect((holder.body as DeployAccepted).state).toBe('locked');

    const res = await request(app).post(`/api/deploys/${deployId}/approve`).set('Cookie', deployer.cookie);
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('locked');
    expect(err(res).message).toContain(`${deployer.email} (console)`);

    expect((await targetOf(deployId)).state).toBe('awaiting_approval');
    const approval = await db.approval.findUniqueOrThrow({ where: { deployId } });
    expect(approval.approvedAt).toBeNull();
    expect(approval.decidedByUserId).toBeNull();

    // Once the holder finishes, the same approval goes through.
    await db.deployTarget.updateMany({ where: { deployId: (holder.body as DeployAccepted).deployId }, data: { state: 'succeeded' } });
    const later = await request(app).post(`/api/deploys/${deployId}/approve`).set('Cookie', deployer.cookie);
    expect(later.status).toBe(200);
    expect((await targetOf(deployId)).state).toBe('locked');
  });

  it('deny cancels the deploy with an approval_required refusal naming the denier', async () => {
    const token = await tokenFor('claude', ['d3auth']);
    const { deployId } = await agentDeploy(token, 'd3auth');
    const admin = await signIn('admin');

    const res = await request(app).post(`/api/deploys/${deployId}/deny`).set('Cookie', admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deployId, state: 'cancelled' });

    const target = await targetOf(deployId);
    expect(target.state).toBe('cancelled');
    expect(target.endedAt).not.toBeNull();
    expect(target.refusal).toMatchObject({ code: 'approval_required', message: `denied by ${admin.email}` });
    expect((await db.approval.findUniqueOrThrow({ where: { deployId } })).deniedAt).not.toBeNull();
    expect(await db.auditEvent.count({ where: { action: 'deploy.denied', entityId: deployId } })).toBe(1);

    const approve = await request(app).post(`/api/deploys/${deployId}/approve`).set('Cookie', admin.cookie);
    expect(err(approve).code).toBe('conflict');
  });

  it('a viewer or a token cannot approve or deny', async () => {
    const token = await tokenFor('claude', ['d3auth']);
    const { deployId } = await agentDeploy(token, 'd3auth');
    const viewer = await signIn('viewer');

    for (const action of ['approve', 'deny']) {
      const v = await request(app).post(`/api/deploys/${deployId}/${action}`).set('Cookie', viewer.cookie);
      expect(v.status).toBe(403);
      expect(err(v).code).toBe('forbidden');
      const t = await request(app).post(`/api/deploys/${deployId}/${action}`).set('Authorization', `Bearer ${token}`);
      expect(t.status).toBe(403);
      expect(err(t).code).toBe('forbidden');
      const anon = await request(app).post(`/api/deploys/${deployId}/${action}`);
      expect(anon.status).toBe(401);
    }
    expect((await targetOf(deployId)).state).toBe('awaiting_approval');
  });

  it('an unknown or non-held deploy is not found', async () => {
    const deployer = await signIn('deployer');
    const res = await request(app).post(`/api/deploys/${randomUUID()}/approve`).set('Cookie', deployer.cookie);
    expect(err(res).code).toBe('not_found');
    const bad = await request(app).post('/api/deploys/not-a-uuid/deny').set('Cookie', deployer.cookie);
    expect(err(bad).code).toBe('not_found');
  });
});

describe('expiry after one hour (SHP-REQ-061) — the doneWhen', () => {
  it('an aged approval expires, and shipyard_deploy_status over MCP reports it cancelled and expired', async () => {
    const token = await tokenFor('claude', ['d3auth']);
    const client = await connect(token);

    // Requested through the real MCP tool: held, not locked.
    const requested = await call(client, 'shipyard_deploy', { app: 'd3auth', sha: SHA_A, requester: requester('claude: session A') });
    expect(requested.isError ?? false).toBe(false);
    const { deployId, state } = JSON.parse(requested.content[0]?.text ?? '') as DeployAccepted;
    expect(state).toBe('awaiting_approval');

    // A fresh one is not expired by a sweep.
    expect(await expireApprovals(deps)).toEqual([]);

    await db.approval.update({ where: { deployId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await expireApprovals(deps)).toEqual([deployId]);
    // Idempotent: a second sweep changes nothing.
    expect(await expireApprovals(deps)).toEqual([]);

    const target = await targetOf(deployId);
    expect(target.state).toBe('cancelled');
    expect(target.refusal).toMatchObject({ code: 'approval_required' });
    expect((target.refusal as { message: string }).message).toContain('expired');
    expect((await db.approval.findUniqueOrThrow({ where: { deployId } })).expiredAt).not.toBeNull();

    const status = okOf(await call(client, 'shipyard_deploy_status', { deployId }));
    expect(status.state).toBe('cancelled');
    expect(status.refusal?.code).toBe('approval_required');
    expect(status.refusal?.message).toContain('expired');
    expect(status.refusal?.message).toBe('approval expired after one hour; request the deploy again');
  });

  it('a shipyard_deploy_status wait in progress is woken by the expiry', async () => {
    const token = await tokenFor('claude', ['d3auth']);
    const client = await connect(token);
    const { deployId } = await agentDeploy(token, 'd3auth');
    await db.approval.update({ where: { deployId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const started = Date.now();
    const waiting = call(client, 'shipyard_deploy_status', { deployId, wait: 60 });
    // Let the wait arm before the sweep publishes.
    await new Promise((r) => setTimeout(r, 300));
    await expireApprovals(deps);
    const status = okOf(await waiting);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(status.state).toBe('cancelled');
    expect(status.refusal?.message).toContain('expired');
  });

  it('a REST wait is woken too, and an expired approval cannot be approved', async () => {
    const token = await tokenFor('claude', ['d3auth']);
    const { deployId } = await agentDeploy(token, 'd3auth');
    await db.approval.update({ where: { deployId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const waiting = waitForChange(deps, deployId, 30);
    await new Promise((r) => setTimeout(r, 100));
    await expireApprovals(deps);
    expect((await waiting)?.state).toBe('cancelled');
  });

  it('approve expires a past-due approval lazily rather than approving it', async () => {
    const token = await tokenFor('claude', ['d3auth']);
    const { deployId } = await agentDeploy(token, 'd3auth');
    await db.approval.update({ where: { deployId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const deployer = await signIn('deployer');

    const res = await request(app).post(`/api/deploys/${deployId}/approve`).set('Cookie', deployer.cookie);
    expect(res.status).toBe(409);
    expect(err(res).code).toBe('approval_required');
    expect(err(res).message).toContain('expired');
    expect((await targetOf(deployId)).state).toBe('cancelled');
    expect(await activeCount(appIds.get('d3auth') ?? '')).toBe(0);
  });
});

describe('GET /approvals (the home banner)', () => {
  it('lists pending approvals only, to any signed-in user including a viewer', async () => {
    const token = await tokenFor('claude', ['d3auth']);
    const pending = await agentDeploy(token, 'd3auth', SHA_A, 'claude: pending');
    const denied = await agentDeploy(token, 'd3auth', SHA_B, 'claude: denied');
    const expired = await agentDeploy(token, 'd3auth', SHA_B, 'claude: expired');
    const admin = await signIn('admin');
    await request(app).post(`/api/deploys/${denied.deployId}/deny`).set('Cookie', admin.cookie).expect(200);
    await db.approval.update({ where: { deployId: expired.deployId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const viewer = await signIn('viewer');
    const res = await request(app).get('/api/_test/approvals').set('Cookie', viewer.cookie);
    expect(res.status).toBe(200);
    const list = res.body as PendingApproval[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      deployId: pending.deployId,
      kind: 'deploy',
      app: 'd3auth',
      sha: SHA_A,
      requester: { label: 'claude: pending', repo: 'matdemers1/d3-auth', branch: 'main' },
    });
    const ttl = Date.parse(list[0]?.expiresAt ?? '') - Date.parse(list[0]?.requestedAt ?? '');
    expect(Math.abs(ttl - 60 * 60 * 1000)).toBeLessThan(5000);

    expect((await request(app).get('/api/_test/approvals')).status).toBe(401);
    expect((await request(app).get('/api/_test/approvals').set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });
});
