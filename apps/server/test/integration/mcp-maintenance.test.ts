import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  HostContainer,
  HostInventory,
  HostVolume,
  MaintenanceJob,
  MaintenanceStatus,
  Manifest,
  PollResponse,
  Refusal,
  StackManifest,
  VolumeArchive,
} from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db, type Prisma } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { agentPost, container, enrol, hex64, issueToken, makeKey, poll, signIn, until, type Key } from './agent-work-fixtures.js';

/**
 * `shipyard_volume_backup`, `shipyard_prune` and `shipyard_maintenance_status` (SHP-T-17.4; SHP-ADR-012;
 * SHP-REQ-201, SHP-REQ-204, SHP-REQ-205). A token scoped to a volume's owning app or stack queues a
 * backup and gets the archive back; any other token, an Observed volume and an offline agent are
 * refused. A prune is a dry run by default that lists, then removes exactly that list; a real prune
 * without a dry run is refused. A job's status is readable inside the token's scope. No tool offers a
 * volume restore or delete.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

const REQUESTER = { label: 'claude: mcp-maintenance test', repo: 'matdemers1/shipyard', branch: 'main' };
const IMAGE = { kind: 'image', id: `sha256:${'a'.repeat(64)}`, ref: 'old:1', sizeBytes: 2048, createdAt: null, reason: 'dangling' } as const;
const UNUSED = { kind: 'image', id: `sha256:${'b'.repeat(64)}`, ref: 'old:2', sizeBytes: 1024, createdAt: null, reason: 'unused' } as const;
const CACHE = { kind: 'build-cache', id: 'abc123', ref: null, sizeBytes: 512, createdAt: null, reason: 'old-cache' } as const;

let bus: Bus;
let app: Express;
let server: Server;
let baseUrl: string;
let key: Key;
let agentId: string;
let cookie: string;
const clients: Client[] = [];

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

function appManifest(name: string): Manifest {
  return {
    name,
    repo: `matdemers1/${name}`,
    defaultBranch: 'main',
    workflow: 'ci.yml',
    compose: { files: [`/DATA/apps/${name}/docker-compose.yml`], project: name },
    services: { server: { image: `ghcr.io/matdemers1/${name}/server` } },
    health: { service: 'server', path: '/health', port: 3000 },
    soakSeconds: 60,
    approval: 'none',
    diskFloorGb: 5,
    retainImages: 3,
  };
}

function stackManifest(name: string): StackManifest {
  return { kind: 'stack', name, compose: { files: [`/DATA/AppData/${name}/docker-compose.yml`], project: name }, updates: 'none' };
}

function volume(name: string, mountedBy: string[]): HostVolume {
  return { name, driver: 'local', sizeBytes: 1000, mountedBy, composeProject: null, orphan: mountedBy.length === 0, createdAt: null };
}

async function seedOwnersAndSnapshot(): Promise<void> {
  await db.app.create({
    data: { name: 'web', agentId, manifestYaml: JSON.stringify(appManifest('web')), manifestSha256: '0'.repeat(64), reportedAt: new Date() },
  });
  await db.stack.create({
    data: { name: 'forgejo', agentId, manifestJson: JSON.stringify(stackManifest('forgejo')), manifestSha256: '0'.repeat(64), composeProject: 'forgejo', reportedAt: new Date() },
  });
  const containers: HostContainer[] = [
    container('web-server-1', { compose: { project: 'web', service: 'server' }, tier: 'shipped', app: 'web' }),
    container('forgejo-server-1', { compose: { project: 'forgejo', service: 'server' }, tier: 'operated', app: 'forgejo' }),
    container('plex-1', { compose: { project: 'plex', service: 'plex' } }),
  ];
  const inventory: HostInventory = {
    sampledAt: '2026-10-22T12:00:00.000Z',
    containers,
    volumes: [volume('web_data', ['web-server-1']), volume('forgejo_data', ['forgejo-server-1']), volume('plex_config', ['plex-1'])],
    images: [],
    networks: [],
    builderCache: { bytes: 0, reclaimableBytes: 0 },
    disk: { dataRoot: { path: '/DATA', freeBytes: 50, totalBytes: 100 }, dockerRoot: null },
  };
  const now = new Date();
  await db.hostSnapshot.create({
    data: { agentId, inventory: JSON.parse(JSON.stringify(inventory)) as Prisma.InputJsonValue, sampledAt: now, reportedAt: now },
  });
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

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'mcp-maintenance-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as Transport);
  clients.push(client);
  return client;
}

/** A client whose token is scoped to the named apps (and, by name, adopted stacks). */
async function clientFor(...scope: string[]): Promise<Client> {
  return connect((await issueToken(app, cookie, scope)).token);
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function refusalOf(result: ToolResult): Refusal {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: Refusal }).error;
}

// The type parameter is the shape the caller expects of the tool's structured result.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function okOf<T>(result: ToolResult): T {
  expect(result.isError ?? false).toBe(false);
  expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
  return result.structuredContent as unknown as T;
}

function jobOf(r: PollResponse): MaintenanceJob | undefined {
  return 'maintenance' in r ? r.maintenance : undefined;
}

/** The fake agent: claims the one queued job once it exists, then reports `state` with `extra`. */
async function agentRuns(state: 'succeeded' | 'failed' | 'refused', extra: Record<string, unknown> = {}): Promise<MaintenanceJob> {
  await until(async () => (await db.maintenanceJob.count({ where: { state: 'queued' } })) > 0);
  const job = jobOf(await poll(app, key, ['maintenance']));
  if (job === undefined) throw new Error('no job was handed out');
  const res = await agentPost(app, key, `/api/agent/maintenance/${job.jobId}/result`, { jobId: job.jobId, state, ...extra });
  expect(res.status).toBe(200);
  return job;
}

function archive(volumeName: string): VolumeArchive {
  return {
    archiveId: randomUUID(),
    volume: volumeName,
    owner: { kind: 'app', name: 'web' },
    createdAt: '2026-10-22T03:00:00.000Z',
    sizeBytes: 4096,
    sha256: hex64(randomUUID()),
    quiesced: false,
  };
}

const PRUNE_RESULT = { items: [IMAGE, UNUSED, CACHE], reclaimableBytes: 3584, reclaimedBytes: null };

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "maintenance_job", "volume_archive", "stack_update", "action", "api_token_stack", "stack", "host_sample", "host_snapshot", "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "native_refresh", "app", "agent", "session", "user" cascade',
  );
  key = makeKey();
  agentId = await enrol(db, key);
  await seedOwnersAndSnapshot();
  bus = new Bus();
  app = createApp({ db, logger, config, bus });
  cookie = (await signIn(db, 'deployer')).cookie;
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
  it('annotates the three tools, says volumes are never pruned, and offers no restore or delete (SHP-REQ-204)', async () => {
    const { tools } = await (await clientFor('web')).listTools();
    const backup = tools.find((t) => t.name === 'shipyard_volume_backup');
    const prune = tools.find((t) => t.name === 'shipyard_prune');
    const status = tools.find((t) => t.name === 'shipyard_maintenance_status');
    expect(backup?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(prune?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(status?.annotations?.readOnlyHint).toBe(true);
    expect(prune?.description).toMatch(/volumes are not pruned/);
    expect(JSON.stringify(status?.inputSchema)).toContain('"maximum":90');
    expect(JSON.stringify(prune?.inputSchema)).toContain('"default":true');

    // No maintenance tool name, and no argument of any of them, reaches a restore or a volume delete.
    const maintenance = tools.filter((t) => ['shipyard_volume_backup', 'shipyard_prune', 'shipyard_maintenance_status'].includes(t.name));
    expect(maintenance).toHaveLength(3);
    expect(tools.map((t) => t.name).filter((n) => /restore|delete/i.test(n))).toEqual([]);
    for (const t of maintenance) expect(JSON.stringify(t.inputSchema)).not.toMatch(/restore|delete|archiveId|confirmVolume/i);
  });
});

describe('shipyard_volume_backup (SHP-REQ-201)', () => {
  it('a token scoped to the owning app queues a backup and gets the archive back', async () => {
    await poll(app, key, ['maintenance']);
    const client = await clientFor('web');
    const pending = call(client, 'shipyard_volume_backup', { volume: 'web_data', requester: REQUESTER });
    const job = await agentRuns('succeeded', { archive: archive('web_data'), output: 'archived 4096 bytes' });
    expect(job).toMatchObject({ kind: 'volume-backup', volume: 'web_data', owner: { kind: 'app', name: 'web' } });

    const out = okOf<{ job: MaintenanceStatus; message: string }>(await pending);
    expect(out.job).toMatchObject({ kind: 'volume-backup', state: 'succeeded', volume: 'web_data', requester: { kind: 'token' } });
    expect(out.job.requester.label).toContain(REQUESTER.label);
    expect(out.job.archive?.sizeBytes).toBe(4096);
    expect(out.message).toContain('Backed up web_data');
    expect(out.message).toContain('2026-10-22T03:00:00.000Z');
    expect(out.message).toContain('4.0 KiB');
    expect(await db.volumeArchive.count({ where: { volume: 'web_data' } })).toBe(1);
  });

  it('a token scoped to the owning stack backs up the stack\'s volume', async () => {
    await poll(app, key, ['maintenance']);
    const client = await clientFor('forgejo');
    const pending = call(client, 'shipyard_volume_backup', { volume: 'forgejo_data', requester: REQUESTER });
    await agentRuns('succeeded', { archive: { ...archive('forgejo_data'), owner: { kind: 'stack', name: 'forgejo' } } });
    expect(okOf<{ job: MaintenanceStatus }>(await pending).job).toMatchObject({ state: 'succeeded', owner: { kind: 'stack', name: 'forgejo' } });
  });

  it('refuses a token scoped to another owner, queueing nothing', async () => {
    await poll(app, key, ['maintenance']);
    const refusal = refusalOf(await call(await clientFor('forgejo'), 'shipyard_volume_backup', { volume: 'web_data', requester: REQUESTER }));
    expect(refusal.code).toBe('forbidden');
    expect(refusal.message).toContain('web');
    expect(await db.maintenanceJob.count()).toBe(0);
  });

  it('refuses an Observed volume (volume_not_owned)', async () => {
    await poll(app, key, ['maintenance']);
    const refusal = refusalOf(await call(await clientFor('web'), 'shipyard_volume_backup', { volume: 'plex_config', requester: REQUESTER }));
    expect(refusal.code).toBe('volume_not_owned');
    expect(await db.maintenanceJob.count()).toBe(0);
  });

  it('refuses when the agent is not polling (agent_offline), and a bad volume name', async () => {
    const client = await clientFor('web');
    expect(refusalOf(await call(client, 'shipyard_volume_backup', { volume: 'web_data', requester: REQUESTER })).code).toBe('agent_offline');
    await poll(app, key, ['actions']);
    expect(refusalOf(await call(client, 'shipyard_volume_backup', { volume: 'web_data', requester: REQUESTER })).code).toBe('agent_too_old');
    // A name that could read as a flag never reaches the service: the tool's input schema rejects it.
    const bad = await call(client, 'shipyard_volume_backup', { volume: '-rf', requester: REQUESTER }).catch((e: unknown) => e);
    expect(bad instanceof Error || (bad as ToolResult).isError === true).toBe(true);
    expect(await db.maintenanceJob.count()).toBe(0);
  });

  it('passes a refusal from the agent through', async () => {
    await poll(app, key, ['maintenance']);
    const client = await clientFor('web');
    const pending = call(client, 'shipyard_volume_backup', { volume: 'web_data', requester: REQUESTER });
    await agentRuns('refused', { refusal: { code: 'insufficient_disk', gate: 'none', message: 'No room for the archive.', fix: 'Free some disk.' } });
    expect(refusalOf(await pending)).toMatchObject({ code: 'insufficient_disk' });
  });
});

describe('shipyard_prune (SHP-REQ-205)', () => {
  it('a dry run lists the items grouped by reason, with the reclaimable total and how to remove them', async () => {
    await poll(app, key, ['maintenance']);
    const client = await clientFor('web');
    const pending = call(client, 'shipyard_prune', { requester: REQUESTER });
    const job = await agentRuns('succeeded', { prune: PRUNE_RESULT });
    expect(job).toMatchObject({ kind: 'prune', dryRun: true });

    const out = okOf<{
      job: MaintenanceStatus;
      groups: { reason: string; count: number; sizeBytes: number; items: unknown[] }[];
      reclaimableBytes: number;
      message: string;
    }>(await pending);
    expect(out.job).toMatchObject({ kind: 'prune', state: 'succeeded', id: job.jobId });
    expect(out.groups.map((g) => [g.reason, g.count, g.sizeBytes])).toEqual([
      ['dangling', 1, 2048],
      ['unused', 1, 1024],
      ['old-cache', 1, 512],
    ]);
    expect(out.reclaimableBytes).toBe(3584);
    expect(out.message).toContain(`dryRun: false`);
    expect(out.message).toContain(`fromDryRunId: ${job.jobId}`);
    expect(out.message).toMatch(/never pruned/);
  });

  it('refuses dryRun: false without fromDryRunId (invalid_request), queueing nothing', async () => {
    await poll(app, key, ['maintenance']);
    const refusal = refusalOf(await call(await clientFor('web'), 'shipyard_prune', { dryRun: false, requester: REQUESTER }));
    expect(refusal.code).toBe('invalid_request');
    expect(refusal.message).toContain('fromDryRunId');
    expect(await db.maintenanceJob.count()).toBe(0);
  });

  it('refuses a prune whose fromDryRunId is not a succeeded dry run (dry_run_required)', async () => {
    await poll(app, key, ['maintenance']);
    const refusal = refusalOf(await call(await clientFor('web'), 'shipyard_prune', { dryRun: false, fromDryRunId: randomUUID(), requester: REQUESTER }));
    expect(refusal.code).toBe('dry_run_required');
    expect(await db.maintenanceJob.count()).toBe(0);
  });

  it('a prune from the dry run carries its list and returns reclaimedBytes; any token may', async () => {
    await poll(app, key, ['maintenance']);
    const dryClient = await clientFor('web');
    const dryPending = call(dryClient, 'shipyard_prune', { requester: REQUESTER });
    const dry = await agentRuns('succeeded', { prune: PRUNE_RESULT });
    await dryPending;

    // A token for an unrelated stack may prune too: the list is host-wide (SHP-ADR-012).
    const other = await clientFor('forgejo');
    const pending = call(other, 'shipyard_prune', { dryRun: false, fromDryRunId: dry.jobId, requester: REQUESTER });
    const real = await agentRuns('succeeded', {
      prune: { items: [IMAGE, UNUSED, CACHE], reclaimableBytes: 3584, reclaimedBytes: 3584 },
    });
    expect(real).toMatchObject({ kind: 'prune', dryRun: false, fromDryRunId: dry.jobId });

    const out = okOf<{ job: MaintenanceStatus; reclaimedBytes: number; message: string }>(await pending);
    expect(out.job).toMatchObject({ kind: 'prune', state: 'succeeded' });
    expect(out.reclaimedBytes).toBe(3584);
    expect(out.message).toContain('3.5 KiB');
    expect((await db.maintenanceJob.findUniqueOrThrow({ where: { id: real.jobId } })).dryRunOf).toBe(dry.jobId);
  });

  it('refuses when the agent is not polling (agent_offline)', async () => {
    expect(refusalOf(await call(await clientFor('web'), 'shipyard_prune', { requester: REQUESTER })).code).toBe('agent_offline');
  });
});

describe('shipyard_maintenance_status', () => {
  async function queuedBackup(): Promise<string> {
    await poll(app, key, ['maintenance']);
    const res = await request(app).post('/api/volumes/web_data/backup').set('Cookie', cookie).send({});
    expect(res.status).toBe(202);
    return (res.body as MaintenanceStatus).id;
  }

  it('reads a backup inside the token\'s scope, and a prune for any token', async () => {
    const jobId = await queuedBackup();
    const web = await clientFor('web');
    expect(okOf<MaintenanceStatus>(await call(web, 'shipyard_maintenance_status', { jobId }))).toMatchObject({ id: jobId, kind: 'volume-backup', state: 'queued' });

    // wait returns when it runs out for a job that has not finished.
    const started = Date.now();
    expect(okOf<MaintenanceStatus>(await call(web, 'shipyard_maintenance_status', { jobId, wait: 1 })).state).toBe('queued');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    await agentRuns('succeeded', { archive: archive('web_data') });
    expect(okOf<MaintenanceStatus>(await call(web, 'shipyard_maintenance_status', { jobId, wait: 5 })).state).toBe('succeeded');

    const prunePending = call(web, 'shipyard_prune', { requester: REQUESTER });
    const prune = await agentRuns('succeeded', { prune: PRUNE_RESULT });
    await prunePending;
    const other = await clientFor('forgejo');
    expect(okOf<MaintenanceStatus>(await call(other, 'shipyard_maintenance_status', { jobId: prune.jobId })).prune?.items).toHaveLength(3);
  });

  it('refuses a token outside the backup\'s owner, and an unknown job', async () => {
    const jobId = await queuedBackup();
    const other = await clientFor('forgejo');
    expect(refusalOf(await call(other, 'shipyard_maintenance_status', { jobId })).code).toBe('forbidden');
    expect(refusalOf(await call(other, 'shipyard_maintenance_status', { jobId: randomUUID() })).code).toBe('not_found');
  });
});
