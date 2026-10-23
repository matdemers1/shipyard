import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Express } from 'express';
import pino from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionJob, ActionResult, ActionStatus, LogLine, LogsChunk, LogsJob, PollResponse, Refusal } from '@shipyard/schema';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { generateToken } from '../../src/tokens/tokens.js';
import {
  agentPost,
  container,
  enrol,
  makeKey,
  poll,
  seedApp,
  seedSnapshot,
  seedStack,
  until,
  type Key,
} from './agent-work-fixtures.js';

/**
 * `shipyard_action` and `shipyard_logs` (SHP-T-15.5; SHP-ADR-010, SHP-ADR-011; SHP-REQ-184,
 * SHP-REQ-188, SHP-REQ-193). A session over MCP can start, restart or recreate inside its token's
 * scope and sees the final state the agent reports; stop is not offered at all. It reads a
 * redacted tail only when the token was issued with logs allowed. A fake agent polls with the
 * `actions` and `logs` capabilities and answers, as in `actions.test.ts` and `logs.test.ts`.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

const WEB = container('web-1', { tier: 'shipped', app: 'web', compose: { project: 'web', service: 'web' } });
const WATCHTOWER = container('watchtower', { compose: { project: 'watchtower', service: 'watchtower' } });
const REQUESTER = { label: 'claude: mcp-actions test', repo: 'matdemers1/shipyard', branch: 'main' };

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

async function listen(): Promise<void> {
  // 127.0.0.1 explicitly: see test/setup/loopback.ts for why an unqualified listen can be dialled wrong.
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

/** A token scoped to `apps`, owned by a user of `role`; `canReadLogs` is the token's own flag. */
async function tokenFor(label: string, apps: string[], role: 'operator' | 'viewer' = 'operator', canReadLogs = false): Promise<string> {
  const user = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.com`, displayName: label, role } });
  const { token, hash, prefix } = generateToken();
  await db.apiToken.create({
    data: {
      userId: user.id,
      label,
      tokenHash: hash,
      prefix,
      canReadLogs,
      apps: { create: apps.map((a) => ({ appId: appIds.get(a) ?? '' })) },
    },
  });
  return token;
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'mcp-actions-test', version: '0.0.0' });
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

function actionOf(r: PollResponse): ActionJob | undefined {
  return 'action' in r ? r.action : undefined;
}

function logsOf(r: PollResponse): LogsJob | undefined {
  return 'logs' in r ? r.logs : undefined;
}

/** The fake agent: waits for the next lifecycle action it is handed and answers it. */
async function agentAnswers(state: ActionResult['state'], output?: string): Promise<ActionJob> {
  let job: ActionJob | undefined;
  await until(async () => {
    job = actionOf(await poll(app, key, ['actions', 'logs']));
    return job !== undefined;
  });
  if (job === undefined) throw new Error('no action was handed to the agent');
  const progress = await agentPost(app, key, `/api/agent/actions/${job.actionId}/progress`, { actionId: job.actionId, state: 'running' });
  expect(progress.status).toBe(200);
  const body: ActionResult = { actionId: job.actionId, state, ...(output === undefined ? {} : { output }) };
  const result = await agentPost(app, key, `/api/agent/actions/${job.actionId}/result`, body);
  expect(result.status).toBe(200);
  return job;
}

function line(text: string, at = '2026-10-22T12:00:00.000Z'): LogLine {
  return { at, stream: 'stdout', text };
}

/** The fake agent: waits for the next log read it is handed and sends `batches` as chunks, the last one `done`. */
async function agentSends(batches: LogLine[][]): Promise<LogsJob> {
  let job: LogsJob | undefined;
  await until(async () => {
    job = logsOf(await poll(app, key, ['actions', 'logs']));
    return job !== undefined;
  });
  if (job === undefined) throw new Error('no log read was handed to the agent');
  for (const [seq, lines] of batches.entries()) {
    const chunk: LogsChunk = { logsId: job.logsId, seq, lines, done: seq === batches.length - 1 };
    const res = await agentPost(app, key, `/api/agent/logs/${job.logsId}/chunks`, chunk);
    expect(res.status).toBe(200);
  }
  return job;
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "action", "stack", "host_sample", "host_snapshot", "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "agent_nonce", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  key = makeKey();
  agentId = await enrol(db, key);
  appIds = new Map<string, string>([
    ['web', await seedApp(db, 'web', agentId)],
    ['api', await seedApp(db, 'api', agentId)],
  ]);
  await seedStack(db, 'pg-stack', agentId);
  await seedSnapshot(db, agentId, [WEB, WATCHTOWER]);
  // The server only queues work for an agent it has heard advertise the capability.
  bus = new Bus();
  app = createApp({ db, logger, config, bus });
  await poll(app, key, ['actions', 'logs']);
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
  it('lists both: shipyard_action writes, shipyard_logs is read-only, and stop is not a verb', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const { tools } = await client.listTools();
    const action = tools.find((t) => t.name === 'shipyard_action');
    const logs = tools.find((t) => t.name === 'shipyard_logs');
    expect(action?.annotations?.readOnlyHint).toBe(false);
    expect(action?.annotations?.destructiveHint).toBe(false);
    expect(logs?.annotations?.readOnlyHint).toBe(true);
    expect(action?.description).toContain('Stop is console-only');
    expect(JSON.stringify(action?.inputSchema)).not.toContain('"stop"');
    expect(JSON.stringify(action?.inputSchema)).toContain('"recreate"');
    expect(JSON.stringify(logs?.inputSchema)).toContain('"maximum":500');
  });
});

describe('shipyard_action', () => {
  it('queues a restart and, with the agent answering, returns its id and the final state succeeded (SHP-REQ-184)', async () => {
    const client = await connect(await tokenFor('claude', ['web']));
    const answered = agentAnswers('succeeded', 'restarted web');
    const result = await call(client, 'shipyard_action', { name: 'web', verb: 'restart', service: 'web', requester: REQUESTER });
    const job = await answered;
    expect(result.isError ?? false).toBe(false);
    const body = result.structuredContent as { action: ActionStatus; finished: boolean };
    expect(body.finished).toBe(true);
    expect(body.action).toMatchObject({
      id: job.actionId,
      target: { kind: 'app', name: 'web' },
      verb: 'restart',
      service: 'web',
      state: 'succeeded',
      output: 'restarted web',
      requesterLabel: 'claude: mcp-actions test (token claude)',
    });
    expect(job).toMatchObject({ target: { kind: 'app', name: 'web' }, verb: 'restart', service: 'web' });
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
    expect(await db.auditEvent.count({ where: { action: 'action.request', entityId: job.actionId } })).toBe(1);
  });

  it('returns a failed action with its refusal rather than an error', async () => {
    const client = await connect(await tokenFor('claude', ['api']));
    const answered = agentAnswers('failed');
    const result = await call(client, 'shipyard_action', { name: 'api', verb: 'recreate', requester: REQUESTER });
    await answered;
    const body = result.structuredContent as { action: ActionStatus; finished: boolean };
    expect(body.finished).toBe(true);
    expect(body.action.state).toBe('failed');
    expect(body.action.refusal?.code).toBe('action_failed');
  });

  it('rejects stop at the input schema and queues nothing (SHP-REQ-188)', async () => {
    const client = await connect(await tokenFor('claude', ['web']));
    for (const verb of ['stop', 'exec']) {
      const result = await call(client, 'shipyard_action', { name: 'web', verb, requester: REQUESTER });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/validation/i);
    }
    expect(await db.action.count()).toBe(0);
  });

  it('refuses a name outside the token scope, an adopted stack included (a token cannot name one)', async () => {
    const client = await connect(await tokenFor('claude', ['api']));
    for (const name of ['web', 'pg-stack']) {
      const refusal = refusalOf(await call(client, 'shipyard_action', { name, verb: 'restart', requester: REQUESTER }));
      expect(refusal.code).toBe('forbidden');
      expect(refusal.message).toContain(name);
    }
    expect(await db.action.count()).toBe(0);
  });

  it('refuses a viewer-owned token (forbidden), the same as the console would', async () => {
    const client = await connect(await tokenFor('claude', ['web'], 'viewer'));
    const refusal = refusalOf(await call(client, 'shipyard_action', { name: 'web', verb: 'restart', requester: REQUESTER }));
    expect(refusal.code).toBe('forbidden');
    expect(await db.action.count()).toBe(0);
  });

  it('refuses an Observed compose project as not_adopted', async () => {
    // A token can only be scoped to something that was once an app; this one has since been retired,
    // and the compose project of that name is what the host still shows.
    appIds.set('watchtower', await seedApp(db, 'watchtower', agentId));
    const token = await tokenFor('claude', ['watchtower']);
    await db.app.update({ where: { name: 'watchtower' }, data: { retiredAt: new Date() } });
    const client = await connect(token);
    const refusal = refusalOf(await call(client, 'shipyard_action', { name: 'watchtower', verb: 'restart', requester: REQUESTER }));
    expect(refusal.code).toBe('not_adopted');
    expect(await db.action.count()).toBe(0);
  });

  it('refuses locked while a deploy holds the app, naming the holder', async () => {
    const deploy = await db.deploy.create({ data: { requestedSha: 'a'.repeat(40), requesterLabel: 'claude: web release' } });
    await db.deployTarget.create({ data: { deployId: deploy.id, appId: appIds.get('web') ?? '', state: 'swapping', currentStep: 'swap' } });
    const client = await connect(await tokenFor('claude', ['web']));
    const refusal = refusalOf(await call(client, 'shipyard_action', { name: 'web', verb: 'restart', requester: REQUESTER }));
    expect(refusal.code).toBe('locked');
    expect(refusal.message).toContain('claude: web release');
    expect(await db.action.count()).toBe(0);
  });
});

describe('shipyard_logs', () => {
  it('is refused for a token issued without logs allowed, before any name is checked (SHP-REQ-193)', async () => {
    const client = await connect(await tokenFor('claude', ['web']));
    for (const name of ['web-1', 'no-such-container']) {
      const refusal = refusalOf(await call(client, 'shipyard_logs', { container: name }));
      expect(refusal.code).toBe('forbidden');
      expect(refusal.message).toBe("This token can't read logs.");
      expect(refusal.fix).toBe('Issue a token with logs allowed in Settings › Claude & tokens.');
    }
    expect(await db.auditEvent.count({ where: { action: 'logs.view' } })).toBe(0);
  });

  it('is refused when the token may read logs but its owner no longer can', async () => {
    const client = await connect(await tokenFor('claude', ['web'], 'viewer', true));
    expect(refusalOf(await call(client, 'shipyard_logs', { container: 'web-1' })).code).toBe('forbidden');
  });

  it('returns the lines the agent sends, in order, for a container named as the Host view shows it', async () => {
    const client = await connect(await tokenFor('claude', ['web'], 'operator', true));
    const sent = agentSends([[line('first'), line('second')], [line('token=[redacted]')], [line('last')]]);
    const result = await call(client, 'shipyard_logs', { container: 'web-1', tail: 50 });
    const job = await sent;
    expect(result.isError ?? false).toBe(false);
    expect(job).toMatchObject({ containerId: WEB.id, tail: 50, follow: false });
    const body = result.structuredContent as { container: { id: string; name: string }; lines: LogLine[]; note: string };
    expect(body.container).toEqual({ id: WEB.id, name: 'web-1' });
    expect(body.lines.map((l) => l.text)).toEqual(['first', 'second', 'token=[redacted]', 'last']);
    expect(body.note).toBe('Redacted on the host; never stored.');
    // The view is audited as for a person, with the window and never a line (SHP-REQ-192).
    const audit = await db.auditEvent.findMany({ where: { action: 'logs.view' } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]?.after)).not.toContain('second');
  });

  it('takes a full 64-hex ID as it is and defaults the tail to 100', async () => {
    const client = await connect(await tokenFor('claude', ['web'], 'operator', true));
    const sent = agentSends([[line('serving')]]);
    const result = await call(client, 'shipyard_logs', { container: WEB.id });
    const job = await sent;
    expect(job).toMatchObject({ containerId: WEB.id, tail: 100 });
    expect((result.structuredContent as { container: { name: string } }).container.name).toBe('web-1');
  });

  it("refuses a token an Observed container, even by its ID (SHP-ADR-011: tokens read only their scope)", async () => {
    const client = await connect(await tokenFor('claude', ['web'], 'operator', true));
    expect(refusalOf(await call(client, 'shipyard_logs', { container: WATCHTOWER.id })).code).toBe('forbidden');
  });

  it('refuses a container the host does not report (unknown_container), by name and by ID', async () => {
    const client = await connect(await tokenFor('claude', ['web'], 'operator', true));
    for (const name of ['ghost', 'f'.repeat(64)]) {
      expect(refusalOf(await call(client, 'shipyard_logs', { container: name })).code).toBe('unknown_container');
    }
  });

  it('bounds the tail at 500: 500 is handed to the agent, 501 and 0 are rejected', async () => {
    const client = await connect(await tokenFor('claude', ['web'], 'operator', true));
    const sent = agentSends([[line('x')]]);
    await call(client, 'shipyard_logs', { container: 'web-1', tail: 500 });
    expect((await sent).tail).toBe(500);
    for (const tail of [501, 0, 2000]) {
      const result = await call(client, 'shipyard_logs', { container: 'web-1', tail });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/validation/i);
    }
  });

  it('rejects a follow flag: it is a tail only', async () => {
    const client = await connect(await tokenFor('claude', ['web'], 'operator', true));
    const result = await call(client, 'shipyard_logs', { container: 'web-1', follow: true });
    expect(result.isError).toBe(true);
  });
});
