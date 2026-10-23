import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Express } from 'express';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Refusal, StackManifest, StackUpdateStatus } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db, type Prisma } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { generateToken } from '../../src/tokens/tokens.js';
import { enrol, makeKey, poll, seedApp, seedStack, type Key } from './agent-work-fixtures.js';

/**
 * `shipyard_stack_update` and `shipyard_stack_update_status` (SHP-T-16.4; SHP-ADR-010; SHP-REQ-199,
 * SHP-REQ-200). A token scoped to an adopted `updates: digest` stack queues an update to the reported
 * candidates, held for a deployer's approval by default; the policy `never` queues it at once. A token
 * scoped only to apps, or to another stack, is refused; a stack adopted with `updates: none` is
 * refused. The update's status is readable by id, inside the same scope.
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
const REQUESTER = { label: 'claude: mcp-stack-updates test', repo: 'matdemers1/shipyard', branch: 'main' };

let bus: Bus;
let app: Express;
let server: Server;
let baseUrl: string;
let key: Key;
let agentId: string;
let appIds: Map<string, string>;
const clients: Client[] = [];

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

function manifestFor(name: string, approval: 'tokens' | 'always' | 'never'): StackManifest {
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

async function seedUpdate(stackId: string, name: string, state: StackUpdateStatus['state'], extra: Partial<Prisma.StackUpdateUncheckedCreateInput> = {}): Promise<string> {
  const row = await db.stackUpdate.create({
    data: { stackId, stackName: name, agentId, state, requesterLabel: 'seed', digests: { server: D2 }, ...extra },
  });
  return row.id;
}

async function listen(): Promise<void> {
  // 127.0.0.1 explicitly: see test/setup/loopback.ts for why an unqualified listen can be dialled wrong.
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

/** A token scoped to `apps` and the adopted `stacks` it names, owned by an operator. */
async function tokenFor(label: string, apps: string[], stacks: string[] = []): Promise<string> {
  const user = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.com`, displayName: label, role: 'operator' } });
  const { token, hash, prefix } = generateToken();
  const stackRows = await db.stack.findMany({ where: { name: { in: stacks } }, select: { id: true } });
  expect(stackRows).toHaveLength(stacks.length);
  await db.apiToken.create({
    data: {
      userId: user.id,
      label,
      tokenHash: hash,
      prefix,
      apps: { create: apps.map((a) => ({ appId: appIds.get(a) ?? '' })) },
      stacks: { create: stackRows.map((r) => ({ stackId: r.id })) },
    },
  });
  return token;
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'mcp-stack-updates-test', version: '0.0.0' });
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

function refusalOf(result: ToolResult): Refusal {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: Refusal }).error;
}

function updateOf(result: ToolResult): { update: StackUpdateStatus; message: string } {
  expect(result.isError ?? false).toBe(false);
  expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
  return result.structuredContent as unknown as { update: StackUpdateStatus; message: string };
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "stack_update", "action", "api_token_stack", "stack", "host_sample", "host_snapshot", "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  key = makeKey();
  agentId = await enrol(db, key);
  appIds = new Map<string, string>([['web', await seedApp(db, 'web', agentId)]]);
  await seedDigestStack('forgejo');
  await seedDigestStack('grafana', 'never');
  await seedDigestStack('plex');
  await seedStack(db, 'immich', agentId);
  bus = new Bus();
  app = createApp({ db, logger, config, bus });
  // The server only queues work for an agent it has heard advertise the capability.
  await poll(app, key, ['stack-updates']);
  await listen();
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

describe('tools/list', () => {
  it('lists both: shipyard_stack_update writes, the status tool is read-only', async () => {
    const client = await connect(await tokenFor('a', ['web'], ['forgejo']));
    const { tools } = await client.listTools();
    const update = tools.find((t) => t.name === 'shipyard_stack_update');
    const status = tools.find((t) => t.name === 'shipyard_stack_update_status');
    expect(update?.annotations?.readOnlyHint).toBe(false);
    expect(update?.annotations?.destructiveHint).toBe(false);
    expect(status?.annotations?.readOnlyHint).toBe(true);
    expect(update?.description).toContain('Needs you');
    expect(JSON.stringify(update?.inputSchema)).not.toContain('digests');
    expect(JSON.stringify(status?.inputSchema)).toContain('"maximum":90');
  });
});

describe('shipyard_stack_update', () => {
  it('holds a token\'s update for approval at the reported candidate, kept with its requester (SHP-REQ-199, SHP-REQ-200)', async () => {
    const client = await connect(await tokenFor('claude', [], ['forgejo']));
    const { update, message } = updateOf(await call(client, 'shipyard_stack_update', { stack: 'forgejo', requester: REQUESTER }));
    expect(update).toMatchObject({
      stack: 'forgejo',
      kind: 'update',
      state: 'awaiting_approval',
      digests: { server: D2 },
      images: [],
      previous: [],
      requesterLabel: 'claude: mcp-stack-updates test (token claude)',
      approvedBy: null,
      refusal: null,
    });
    expect(message).toContain('Needs you');
    const row = await db.stackUpdate.findUniqueOrThrow({ where: { id: update.id } });
    expect(row).toMatchObject({ agentId, state: 'awaiting_approval', requesterRepo: REQUESTER.repo, requesterBranch: REQUESTER.branch });
    expect(row.requesterTokenId).not.toBeNull();
    expect(row.heldAt).not.toBeNull();
    const audit = await db.auditEvent.findMany({ where: { action: 'stack_update.request', entityId: update.id } });
    expect(audit).toHaveLength(1);
  });

  it('queues at once when the stack\'s approval policy is never', async () => {
    const client = await connect(await tokenFor('claude', [], ['grafana']));
    const { update, message } = updateOf(await call(client, 'shipyard_stack_update', { stack: 'grafana', requester: REQUESTER }));
    expect(update).toMatchObject({ stack: 'grafana', state: 'queued', digests: { server: D2 } });
    expect(message).toContain('Queued');
  });

  it('refuses a token scoped only to apps, or to another stack, and records nothing', async () => {
    const appOnly = await connect(await tokenFor('apps', ['web']));
    const refusal = refusalOf(await call(appOnly, 'shipyard_stack_update', { stack: 'forgejo', requester: REQUESTER }));
    expect(refusal.code).toBe('forbidden');
    const other = await connect(await tokenFor('other', ['web'], ['plex']));
    expect(refusalOf(await call(other, 'shipyard_stack_update', { stack: 'forgejo', requester: REQUESTER })).code).toBe('forbidden');
    expect(await db.stackUpdate.count()).toBe(0);
  });

  it('refuses a stack adopted with updates: none', async () => {
    const client = await connect(await tokenFor('claude', [], ['immich']));
    const refusal = refusalOf(await call(client, 'shipyard_stack_update', { stack: 'immich', requester: REQUESTER }));
    expect(refusal.code).toBe('updates_disabled');
    expect(await db.stackUpdate.count()).toBe(0);
  });

  it('refuses a second update while one is queued, and takes no digests or requesterless call', async () => {
    const client = await connect(await tokenFor('claude', [], ['grafana']));
    updateOf(await call(client, 'shipyard_stack_update', { stack: 'grafana', requester: REQUESTER }));
    expect(refusalOf(await call(client, 'shipyard_stack_update', { stack: 'grafana', requester: REQUESTER })).code).toBe('locked');
    const extra = await call(client, 'shipyard_stack_update', { stack: 'grafana', requester: REQUESTER, digests: { server: D3 } });
    expect(extra.isError).toBe(true);
    expect(extra.content[0]?.text).toMatch(/validation/i);
    const bare = await call(client, 'shipyard_stack_update', { stack: 'grafana' });
    expect(bare.content[0]?.text).toContain('requester');
    expect(await db.stackUpdate.count()).toBe(1);
  });
});

describe('shipyard_stack_update_status', () => {
  it('reads an update by id inside the token\'s scope, with the images before and after (SHP-REQ-200)', async () => {
    const stackId = (await db.stack.findFirstOrThrow({ where: { name: 'forgejo' } })).id;
    const images = [{ service: 'server', tag: '11.0.2', digest: D2 }];
    const previous = [{ service: 'server', tag: '11.0.1', digest: D1 }];
    const id = await seedUpdate(stackId, 'forgejo', 'succeeded', { images, previous, endedAt: new Date() });
    const client = await connect(await tokenFor('claude', [], ['forgejo']));
    const result = await call(client, 'shipyard_stack_update_status', { updateId: id });
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({ id, stack: 'forgejo', state: 'succeeded', images, previous, digests: { server: D2 } });
    // A finished update answers at once even with a wait.
    const started = Date.now();
    const waited = await call(client, 'shipyard_stack_update_status', { updateId: id, wait: 30 });
    expect((waited.structuredContent as { state: string }).state).toBe('succeeded');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('follows the update the other tool queued', async () => {
    const client = await connect(await tokenFor('claude', [], ['forgejo']));
    const { update } = updateOf(await call(client, 'shipyard_stack_update', { stack: 'forgejo', requester: REQUESTER }));
    const status = await call(client, 'shipyard_stack_update_status', { updateId: update.id });
    expect(status.structuredContent).toMatchObject({ id: update.id, state: 'awaiting_approval' });
  });

  it('refuses an update of a stack outside the scope, an app-only token, an unknown id and a bad id', async () => {
    const stackId = (await db.stack.findFirstOrThrow({ where: { name: 'plex' } })).id;
    const id = await seedUpdate(stackId, 'plex', 'queued');
    const scoped = await connect(await tokenFor('forgejo-only', [], ['forgejo']));
    expect(refusalOf(await call(scoped, 'shipyard_stack_update_status', { updateId: id, wait: 5 })).code).toBe('forbidden');
    const appOnly = await connect(await tokenFor('apps', ['web']));
    expect(refusalOf(await call(appOnly, 'shipyard_stack_update_status', { updateId: id })).code).toBe('forbidden');
    expect(refusalOf(await call(scoped, 'shipyard_stack_update_status', { updateId: randomUUID() })).code).toBe('not_found');
    const bad = await call(scoped, 'shipyard_stack_update_status', { updateId: 'not-a-uuid' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toMatch(/validation/i);
  });
});
