import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import pino from 'pino';
import { HostResponse, type HostContainer, type HostInventory } from '@shipyard/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { storeHostInventory } from '../../src/host/index.js';
import { MCP_HOST_SAMPLES_PER_CONTAINER } from '../../src/mcp/tools.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * `shipyard_host` (SHP-T-14.6, SHP-ADR-009, SHP-REQ-179, SHP-REQ-181): the latest host snapshot with
 * the time the agent reported it, to a token scoped to an unrelated app; empty before any report;
 * no input; and it writes nothing. Mirrors `mcp.test.ts`'s client setup and token issuing.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

let bus: Bus;
let server: Server;
let baseUrl: string;
let agentId: string;
let appIds: Map<string, string>;
const clients: Client[] = [];

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

async function listen(): Promise<void> {
  const app = createApp({ db, logger, config, bus });
  // 127.0.0.1 explicitly: see test/setup/loopback.ts for why an unqualified listen can be dialled wrong.
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function seedApps(...names: string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const name of names) {
    const row = await db.app.create({
      data: {
        name,
        agentId,
        manifestYaml: `name: ${name}\n`,
        manifestSha256: '0'.repeat(64),
        repo: `matdemers1/${name}`,
        defaultBranch: 'main',
        reportedAt: new Date(),
      },
    });
    ids.set(name, row.id);
  }
  return ids;
}

/** A token scoped to `apps` only; the host is not one of them. */
async function tokenFor(label: string, apps: string[]): Promise<string> {
  const user = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.com`, displayName: label, role: 'viewer' } });
  const { token, hash, prefix } = generateToken();
  await db.apiToken.create({
    data: {
      userId: user.id,
      label,
      tokenHash: hash,
      prefix,
      apps: { create: apps.map((a) => ({ appId: appIds.get(a) ?? '' })) },
    },
  });
  return token;
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'mcp-host-test', version: '0.0.0' });
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

function hex(seed: string, length: number): string {
  return Buffer.from(seed.repeat(64)).toString('hex').slice(0, length);
}

function container(name: string, extra: Partial<HostContainer> = {}): HostContainer {
  return {
    id: hex(name, 64),
    name,
    image: `${name}:latest`,
    imageId: `sha256:${hex(`${name}-image`, 64)}`,
    digest: `sha256:${'a'.repeat(64)}`,
    state: 'running',
    health: 'none',
    restartCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    startedAt: '2026-10-01T00:00:01.000Z',
    compose: null,
    tier: 'observed',
    app: null,
    ports: [],
    mounts: [],
    stats: { cpuPercent: 1.5, memoryBytes: 64 * 1024 * 1024, memoryLimitBytes: null },
    ...extra,
  };
}

const INVENTORY: HostInventory = {
  sampledAt: '2026-10-22T12:00:00.000Z',
  containers: [
    container('web-1', { tier: 'shipped', app: 'web', compose: { project: 'web', service: 'web' } }),
    container('pg', { tier: 'operated', app: 'pg-stack', compose: { project: 'pg-stack', service: 'pg' } }),
    container('watchtower'),
  ],
  volumes: [],
  images: [],
  networks: [],
  builderCache: { bytes: 0, reclaimableBytes: 0 },
  disk: { dataRoot: { path: '/DATA', freeBytes: 10, totalBytes: 100 }, dockerRoot: null },
};

/** The rows `shipyard_host` must never touch, counted before and after a call. */
async function counts(): Promise<Record<'snapshots' | 'samples' | 'audit' | 'deploys', number>> {
  return {
    snapshots: await db.hostSnapshot.count(),
    samples: await db.hostSample.count(),
    audit: await db.auditEvent.count(),
    deploys: await db.deploy.count(),
  };
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "host_sample", "host_snapshot", "target_image", "step", "outbox", "drift_event", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  agentId = (await db.agent.create({ data: { publicKey: 'test-key', fingerprint: `fp-${randomUUID()}` } })).id;
  appIds = await seedApps('other');
  bus = new Bus();
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

describe('shipyard_host', () => {
  it('returns { hosts: [] } until an agent has reported an inventory', async () => {
    const client = await connect(await tokenFor('a', ['other']));
    const result = await call(client, 'shipyard_host', {});
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toEqual({ hosts: [] });
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({ hosts: [] });
  });

  it('returns the latest snapshot with reportedAt to a token scoped to an unrelated app', async () => {
    const reportedAt = new Date('2026-10-22T12:00:05.000Z');
    await storeHostInventory(db, agentId, INVENTORY, reportedAt);
    const fingerprint = (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).fingerprint;

    const client = await connect(await tokenFor('a', ['other']));
    const result = await call(client, 'shipyard_host', {});
    expect(result.isError ?? false).toBe(false);

    const body = HostResponse.parse(result.structuredContent);
    expect(body.hosts).toHaveLength(1);
    const host = body.hosts[0];
    expect(host?.agent).toEqual({ id: agentId, fingerprint });
    expect(host?.reportedAt).toBe(reportedAt.toISOString());
    expect(host?.inventory).toEqual(INVENTORY);
    expect(host?.inventory.containers.map((c) => [c.name, c.tier])).toEqual([
      ['web-1', 'shipped'],
      ['pg', 'operated'],
      ['watchtower', 'observed'],
    ]);
    // The text content is the same JSON the structured content carries.
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
  });

  it('sends only the newest MCP_HOST_SAMPLES_PER_CONTAINER samples per container, oldest first', async () => {
    await storeHostInventory(db, agentId, INVENTORY);
    const start = Date.now() - 30 * 60_000;
    await db.hostSample.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({ agentId, containerName: 'busy', at: new Date(start + i * 60_000), cpuPercent: i, memoryBytes: BigInt(i) })),
    });
    const client = await connect(await tokenFor('a', ['other']));
    const body = HostResponse.parse((await call(client, 'shipyard_host', {})).structuredContent);
    const busy = body.hosts[0]?.samples['busy'] ?? [];
    expect(busy).toHaveLength(MCP_HOST_SAMPLES_PER_CONTAINER);
    expect(busy.map((s) => s.cpuPercent)).toEqual(Array.from({ length: MCP_HOST_SAMPLES_PER_CONTAINER }, (_, i) => 20 - MCP_HOST_SAMPLES_PER_CONTAINER + i));
  });

  it('also serves a token that is scoped to no app at all', async () => {
    await storeHostInventory(db, agentId, INVENTORY);
    const client = await connect(await tokenFor('none', []));
    const body = HostResponse.parse((await call(client, 'shipyard_host', {})).structuredContent);
    expect(body.hosts).toHaveLength(1);
  });

  it('changes nothing: no snapshot, sample, audit or deploy row is written, and reported_at stays (SHP-REQ-181)', async () => {
    await storeHostInventory(db, agentId, INVENTORY, new Date('2026-10-22T12:00:05.000Z'));
    const client = await connect(await tokenFor('a', ['other']));
    // Connecting may itself record the token's use; the call is measured from here.
    const before = await counts();
    const snapshotBefore = await db.hostSnapshot.findUniqueOrThrow({ where: { agentId } });

    await call(client, 'shipyard_host', {});
    await call(client, 'shipyard_host', {});

    expect(await counts()).toEqual(before);
    const snapshotAfter = await db.hostSnapshot.findUniqueOrThrow({ where: { agentId } });
    expect(snapshotAfter.reportedAt.toISOString()).toBe(snapshotBefore.reportedAt.toISOString());
    expect(snapshotAfter.inventory).toEqual(snapshotBefore.inventory);
  });

  it('rejects any argument: the input is strict and nothing reaches the agent', async () => {
    await storeHostInventory(db, agentId, INVENTORY);
    const client = await connect(await tokenFor('a', ['other']));
    const before = await counts();
    for (const args of [{ app: 'x' }, { agent: 'x' }, { command: 'ls' }]) {
      const result = await call(client, 'shipyard_host', args);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/validation/i);
    }
    expect(await counts()).toEqual(before);
  });

  it('is listed read-only, with the console tier words in its description', async () => {
    const client = await connect(await tokenFor('a', ['other']));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'shipyard_host');
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    for (const word of ['Shipped', 'Operated', 'Observed', 'reportedAt']) {
      expect(tool?.description).toContain(word);
    }
    expect(tool?.inputSchema.properties ?? {}).toEqual({});
  });
});
