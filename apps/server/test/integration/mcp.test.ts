import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import pino from 'pino';
import type { DeployStatus, Refusal } from '@shipyard/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { mcpRouter } from '../../src/mcp/index.js';
import { generateToken } from '../../src/tokens/tokens.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b1c2d3e4f5'.repeat(4);
const TOOLS = ['shipyard_deploy', 'shipyard_deploy_status', 'shipyard_dry_run', 'shipyard_rollback', 'shipyard_status'];

let bus: Bus;
let server: Server;
let baseUrl: string;
let appIds: Map<string, string>;
const clients: Client[] = [];

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

async function listen(): Promise<void> {
  const mcpTest = mcpRouter({ db, logger, config, bus }, { dryRunWaitSeconds: 1 });
  const app = createApp({ db, logger, config, bus, testRouter: mcpTest });
  // 127.0.0.1 explicitly: see test/setup/loopback.ts for why an unqualified listen can be dialled wrong.
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function seedApps(...names: string[]): Promise<Map<string, string>> {
  const agent = await db.agent.create({ data: { publicKey: 'test-key', fingerprint: `fp-${randomUUID()}` } });
  const ids = new Map<string, string>();
  for (const name of names) {
    const row = await db.app.create({
      data: {
        name,
        agentId: agent.id,
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

/** A deployer with a token scoped to `apps`; returns the plaintext token. */
async function tokenFor(label: string, apps: string[], role: 'deployer' | 'viewer' = 'deployer'): Promise<string> {
  const user = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.com`, displayName: label, role } });
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

async function connect(token: string, path = '/mcp'): Promise<Client> {
  const client = new Client({ name: 'mcp-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${path}`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  // The SDK's optional fields don't satisfy exactOptionalPropertyTypes; the shape is the same.
  await client.connect(transport as Transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function refusalOf(result: ToolResult): Refusal {
  expect(result.isError).toBe(true);
  const text = result.content[0]?.text ?? '';
  const parsed = JSON.parse(text) as { error: Refusal };
  expect(Object.keys(parsed.error).sort()).toEqual(['code', 'fix', 'gate', 'message']);
  expect(result.structuredContent).toEqual(parsed);
  return parsed.error;
}

// The type parameter names what the JSON text is expected to hold, for the assertions that follow.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function okOf<T>(result: ToolResult): T {
  expect(result.isError ?? false).toBe(false);
  const parsed = JSON.parse(result.content[0]?.text ?? '') as T;
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

const requester = (label: string) => ({ repo: 'matdemers1/web', branch: 'main', label });

/** A succeeded deploy of `app`, as the agent's result writes it. */
async function seedSucceeded(app: string): Promise<string> {
  const deploy = await db.deploy.create({
    data: {
      requestedSha: SHA_B,
      requesterLabel: 'earlier',
      targets: {
        create: {
          appId: appIds.get(app) ?? '',
          state: 'succeeded',
          schemaRevision: '20260920_add_widgets',
          endedAt: new Date(),
          images: {
            create: [
              { service: 'api', repo: 'ghcr.io/matdemers1/web-api', sha: SHA_B, digest: `sha256:${'1'.repeat(64)}` },
              { service: 'web', repo: 'ghcr.io/matdemers1/web', sha: SHA_B, digest: `sha256:${'2'.repeat(64)}` },
            ],
          },
        },
      },
    },
    select: { id: true },
  });
  return deploy.id;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "target_image", "step", "outbox", "drift_event", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  appIds = await seedApps('web', 'billing');
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

describe('two sessions race (the doneWhen)', () => {
  it('session A gets the lock at once; session B is refused, naming session A', async () => {
    const a = await connect(await tokenFor('a', ['web']));
    const b = await connect(await tokenFor('b', ['web']));

    const accepted = okOf<{ deployId: string; state: string }>(
      await call(a, 'shipyard_deploy', { app: 'web', sha: SHA_A, requester: requester('claude: session A') }),
    );
    expect(accepted.state).toBe('locked');
    expect(accepted.deployId).toMatch(/^[0-9a-f-]{36}$/);

    const r = refusalOf(await call(b, 'shipyard_deploy', { app: 'web', sha: SHA_B, requester: requester('claude: session B') }));
    expect(r.code).toBe('locked');
    expect(r.message).toContain('claude: session A');

    // The requester is recorded with the deploy (SHP-REQ-045), and the request audited.
    const row = await db.deploy.findUniqueOrThrow({ where: { id: accepted.deployId } });
    expect(row).toMatchObject({ requesterLabel: 'claude: session A', requesterRepo: 'matdemers1/web', requesterBranch: 'main' });
    expect(row.requesterTokenId).not.toBeNull();
    const audit = await db.auditEvent.findMany({ where: { action: 'deploy.requested', entityId: accepted.deployId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorType).toBe('token');

    // Status shows the holder and step.
    const status = okOf<{ apps: { name: string; lock: { holder: string } | null }[]; note: string }>(
      await call(b, 'shipyard_status', { app: 'web' }),
    );
    expect(status.apps[0]?.lock?.holder).toBe('claude: session A');
    expect(status.note).toContain('does not track CI');
  });
});

describe('the endpoint', () => {
  it('lists exactly the five tools', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(40);
  });

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
  };

  it('refuses a request with no token with 401 and WWW-Authenticate: Bearer', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(initialize),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(((await res.json()) as { error: Refusal }).error.code).toBe('unauthenticated');
  });

  it('refuses a session cookie without a token', async () => {
    const user = await db.user.create({ data: { email: `u-${randomUUID()}@example.com`, displayName: 'u', role: 'admin' } });
    const session = await createSession(db, { userId: user.id, method: 'password' });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        cookie: `${SESSION_COOKIE}=${session.token}`,
      },
      body: JSON.stringify(initialize),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('answers GET and DELETE with 405', async () => {
    const token = await tokenFor('a', ['web']);
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${baseUrl}/mcp`, { method, headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(405);
    }
  });
});

describe('shipyard_deploy and shipyard_rollback', () => {
  it('refuses an app outside the token scope', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const r = refusalOf(await call(client, 'shipyard_deploy', { app: 'billing', sha: SHA_A, requester: requester('x') }));
    expect(r.code).toBe('forbidden');
    expect(await db.deploy.count()).toBe(0);
  });

  it('rejects a deploy with no requester as a validation error, and records nothing', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const result = await call(client, 'shipyard_deploy', { app: 'web', sha: SHA_A });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/validation/i);
    expect(result.content[0]?.text).toContain('requester');
    expect(await db.deploy.count()).toBe(0);
  });

  it('rejects anything that is not a 40-hex SHA', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const result = await call(client, 'shipyard_deploy', { app: 'web', sha: 'main; rm -rf /', requester: requester('x') });
    expect(result.isError).toBe(true);
    expect(await db.deploy.count()).toBe(0);
  });

  it('refuses a group deploy', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const r = refusalOf(await call(client, 'shipyard_deploy', { group: 'core', sha: SHA_A, requester: requester('x') }));
    expect(r.code).toBe('invalid_request');
    expect(r.message).toMatch(/group/i);
  });

  it('refuses a rollback to a bogus deploy', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    for (const toDeployId of ['bogus', randomUUID()]) {
      const r = refusalOf(await call(client, 'shipyard_rollback', { app: 'web', toDeployId, requester: requester('x') }));
      expect(r.code).toBe('rollback_target_invalid');
    }
  });

  it('accepts a rollback to an earlier successful deploy and returns at once', async () => {
    const earlier = await seedSucceeded('web');
    const client = await connect(await tokenFor('a', ['web']));
    const accepted = okOf<{ deployId: string; state: string }>(
      await call(client, 'shipyard_rollback', { app: 'web', toDeployId: earlier, requester: requester('claude: rb') }),
    );
    expect(accepted.state).toBe('locked');
    const row = await db.deploy.findUniqueOrThrow({ where: { id: accepted.deployId }, include: { targets: true } });
    expect(row.kind).toBe('rollback');
    expect(row.requesterLabel).toBe('claude: rb');
    expect(row.targets[0]?.rollbackToDeployId).toBe(earlier);
  });
});

describe('shipyard_deploy_status', () => {
  it('returns within the wait when nothing changes', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const { deployId } = okOf<{ deployId: string }>(
      await call(client, 'shipyard_deploy', { app: 'web', sha: SHA_A, requester: requester('x') }),
    );
    const started = Date.now();
    const status = okOf<DeployStatus>(await call(client, 'shipyard_deploy_status', { deployId, wait: 2 }));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(4000);
    expect(status.state).toBe('locked');
  });

  it('returns early when the target changes and deploy:<id> is published', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const { deployId } = okOf<{ deployId: string }>(
      await call(client, 'shipyard_deploy', { app: 'web', sha: SHA_A, requester: requester('x') }),
    );
    setTimeout(() => {
      void db.deployTarget
        .updateMany({ where: { deployId }, data: { state: 'pulling', currentStep: 'pull' } })
        .then(() => {
          bus.publish(`deploy:${deployId}`);
        });
    }, 300);
    const started = Date.now();
    const status = okOf<DeployStatus>(await call(client, 'shipyard_deploy_status', { deployId, wait: 30 }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(status.state).toBe('pulling');
    expect(status.currentStep).toBe('pull');
  });

  it('reports every image SHA and digest and the schema revision once succeeded', async () => {
    const deployId = await seedSucceeded('web');
    const client = await connect(await tokenFor('a', ['web']));
    const status = okOf<DeployStatus>(await call(client, 'shipyard_deploy_status', { deployId, wait: 5 }));
    expect(status.state).toBe('succeeded');
    expect(status.schemaRevision).toBe('20260920_add_widgets');
    expect(status.images).toEqual([
      { service: 'api', sha: SHA_B, digest: `sha256:${'1'.repeat(64)}`, migration: null },
      { service: 'web', sha: SHA_B, digest: `sha256:${'2'.repeat(64)}`, migration: null },
    ]);

    const live = okOf<{ apps: { live: { sha: string; digests: Record<string, string>; schemaRevision: string } }[] }>(
      await call(client, 'shipyard_status', {}),
    );
    expect(live.apps[0]?.live).toMatchObject({ sha: SHA_B, schemaRevision: '20260920_add_widgets' });
    expect(Object.keys(live.apps[0]?.live.digests ?? {}).sort()).toEqual(['api', 'web']);
  });

  it('refuses a deploy of an app outside the scope, and an unknown deploy', async () => {
    const deployId = await seedSucceeded('billing');
    const client = await connect(await tokenFor('a', ['web']));
    expect(refusalOf(await call(client, 'shipyard_deploy_status', { deployId })).code).toBe('forbidden');
    expect(refusalOf(await call(client, 'shipyard_deploy_status', { deployId: randomUUID() })).code).toBe('not_found');
    expect(refusalOf(await call(client, 'shipyard_deploy_status', { deployId: 'nope' })).code).toBe('not_found');
  });

  it('rejects a wait over 90 seconds', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const result = await call(client, 'shipyard_deploy_status', { deployId: randomUUID(), wait: 91 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/validation/i);
  });
});

describe('shipyard_status', () => {
  it('lists only the apps in the token scope', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const all = okOf<{ apps: { name: string; live: unknown; lock: unknown; drift: unknown; lastResult: unknown }[] }>(
      await call(client, 'shipyard_status', {}),
    );
    expect(all.apps.map((a) => a.name)).toEqual(['web']);
    expect(all.apps[0]).toMatchObject({ live: null, lock: null, drift: null, lastResult: null });
    expect(refusalOf(await call(client, 'shipyard_status', { app: 'billing' })).code).toBe('forbidden');
  });
});

describe('shipyard_dry_run (1 s cap via the test mount)', () => {
  it('answers "still running" with the deploy id when no agent picks it up, within its cap', async () => {
    const client = await connect(await tokenFor('a', ['web']), '/api/_test');
    const started = Date.now();
    const result = okOf<{ deployId: string; finished: boolean; state: string; message: string }>(
      await call(client, 'shipyard_dry_run', { app: 'web', sha: SHA_A }),
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.finished).toBe(false);
    expect(result.state).toBe('queued');
    expect(result.message).toMatch(/still running/i);
    const row = await db.deploy.findUniqueOrThrow({ where: { id: result.deployId } });
    expect(row.dryRun).toBe(true);
    expect(row.requesterLabel).toBe('token a (dry run)');
  });

  it('returns every gate once the agent finishes, without taking the lock', async () => {
    const client = await connect(await tokenFor('a', ['web']), '/api/_test');
    // The dry run never locks: a real deploy can hold the app at the same time.
    okOf(await call(client, 'shipyard_deploy', { app: 'web', sha: SHA_B, requester: requester('holder') }));

    const gates = [
      { gate: 'G5', pass: true, reason: 'CI green on build.yml' },
      { gate: 'G6', pass: false, reason: 'SHA is not on main' },
    ];
    const finish = setInterval(() => {
      void db.deployTarget.findFirst({ where: { deploy: { dryRun: true } }, select: { deployId: true } }).then(async (t) => {
        if (t === null) return;
        clearInterval(finish);
        await db.deployTarget.updateMany({
          where: { deployId: t.deployId },
          data: { state: 'refused', endedAt: new Date(), result: { gates } },
        });
        bus.publish(`deploy:${t.deployId}`);
      });
    }, 50);
    try {
      const result = okOf<{ finished: boolean; state: string; gates: unknown }>(
        await call(client, 'shipyard_dry_run', { app: 'web', sha: SHA_A }),
      );
      expect(result.finished).toBe(true);
      expect(result.state).toBe('refused');
      expect(result.gates).toEqual(gates);
    } finally {
      clearInterval(finish);
    }
  });
});
