import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import pino from 'pino';
import type { GitHubPort } from '@shipyard/sequence/github';
import type { Refusal } from '@shipyard/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';
import { mcpRouter } from '../../src/mcp/index.js';
import { generateToken } from '../../src/tokens/tokens.js';

/**
 * `shipyard_build` and `shipyard_build_status` (SHP-T-7.13, SHP-REQ-144, SHP-REQ-145): out-of-scope
 * refusal, schema rejection of a bad SHA, a build → status round trip, idempotent re-enqueue of an
 * open build, and shipyard_status showing the build state of a waiting commit. Mirrors
 * `mcp.test.ts`'s client/transport setup and token issuing.
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
const logger = pino({ enabled: false });

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b1c2d3e4f5'.repeat(4);
const SHA_D = 'd'.repeat(40);
const SHA_E = 'e'.repeat(40);

let bus: Bus;
let server: Server;
let baseUrl: string;
let appIds: Map<string, string>;
const clients: Client[] = [];

class FakeGitHub implements Pick<GitHubPort, 'compare'> {
  compareResult: Awaited<ReturnType<GitHubPort['compare']>> = null;
  /** Set to make the next `compare` calls reject instead (SHP-T-7.20). */
  compareError: Error | null = null;
  /** Counts every `compare` call actually made, past the cache (SHP-T-7.20). */
  compareCalls = 0;

  compare(_repo: string, _base: string, _head: string): ReturnType<GitHubPort['compare']> {
    this.compareCalls += 1;
    if (this.compareError !== null) return Promise.reject(this.compareError);
    return Promise.resolve(this.compareResult);
  }
}
let fakeGithub: FakeGitHub;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

async function listen(): Promise<void> {
  const mcpTest = mcpRouter({ db, logger, config, bus }, { dryRunWaitSeconds: 1, github: fakeGithub });
  const app = createApp({ db, logger, config, bus, testRouter: mcpTest });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

function manifestYaml(name: string, buildSource: 'shipyard' | 'github'): string {
  const build = buildSource === 'shipyard' ? '\nbuild:\n  source: shipyard\n  releaseTargets:\n    web: release\n' : '';
  return (
    `name: ${name}\n` +
    `repo: matdemers1/${name}\n` +
    `defaultBranch: main\n` +
    `workflow: ci.yml\n` +
    `compose:\n  files:\n    - /data/${name}/compose.yml\n  project: ${name}\n` +
    `services:\n  web:\n    image: ghcr.io/matdemers1/${name}\n` +
    `health:\n  service: web\n  port: 8080\n  path: /health\n` +
    build
  );
}

/** `shipyard` builds its own images; `web` is built by GitHub CI (the default when unset). */
async function seedApps(): Promise<Map<string, string>> {
  const agent = await db.agent.create({ data: { publicKey: 'test-key', fingerprint: `fp-${randomUUID()}` } });
  const ids = new Map<string, string>();
  for (const [name, manifest] of [
    ['shipyard', manifestYaml('shipyard', 'shipyard')],
    ['web', manifestYaml('web', 'github')],
  ] as const) {
    const row = await db.app.create({
      data: {
        name,
        agentId: agent.id,
        manifestYaml: manifest,
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

async function tokenFor(label: string, apps: string[]): Promise<string> {
  const user = await db.user.create({ data: { email: `${label}-${randomUUID()}@example.com`, displayName: label, role: 'deployer' } });
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

// `/api/_test` carries the injected `fakeGithub`; the app's own `/mcp` builds its own real adapter.
async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'mcp-build-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/_test`), {
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
  const text = result.content[0]?.text ?? '';
  const parsed = JSON.parse(text) as { error: Refusal };
  expect(Object.keys(parsed.error).sort()).toEqual(['code', 'fix', 'gate', 'message']);
  return parsed.error;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function okOf<T>(result: ToolResult): T {
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0]?.text ?? '') as T;
}

const requester = (label: string) => ({ repo: 'matdemers1/shipyard', branch: 'main', label });

/** A recorded release for `appName` at `sha` — enough for `appStatuses` to call `compare`. */
async function seedRelease(appName: string, sha: string): Promise<void> {
  await db.deploy.create({
    data: {
      requestedSha: sha,
      requesterLabel: 'earlier',
      targets: {
        create: {
          appId: appIds.get(appName) ?? '',
          state: 'succeeded',
          dispatchedAt: new Date(),
          endedAt: new Date(),
          images: { create: [{ service: 'server', repo: `ghcr.io/matdemers1/${appName}`, sha, digest: `sha256:${'9'.repeat(64)}` }] },
        },
      },
    },
  });
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "build_log", "build_stage", "build", "target_image", "step", "outbox", "drift_event", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
  appIds = await seedApps();
  bus = new Bus();
  fakeGithub = new FakeGitHub();
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

describe('shipyard_build', () => {
  it('refuses an app outside the token scope', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const r = refusalOf(await call(client, 'shipyard_build', { app: 'shipyard', sha: SHA_A, requester: requester('x') }));
    expect(r.code).toBe('forbidden');
    expect(await db.build.count()).toBe(0);
  });

  it('rejects anything that is not a 40-hex SHA (schema)', async () => {
    const client = await connect(await tokenFor('a', ['shipyard']));
    const result = await call(client, 'shipyard_build', { app: 'shipyard', sha: 'main; rm -rf /', requester: requester('x') });
    expect(result.isError).toBe(true);
    expect(await db.build.count()).toBe(0);
  });

  it('rejects a build with no requester as a validation error', async () => {
    const client = await connect(await tokenFor('a', ['shipyard']));
    const result = await call(client, 'shipyard_build', { app: 'shipyard', sha: SHA_A });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/validation/i);
    expect(await db.build.count()).toBe(0);
  });

  it('refuses an app that is not built by Shipyard', async () => {
    const client = await connect(await tokenFor('a', ['web']));
    const r = refusalOf(await call(client, 'shipyard_build', { app: 'web', sha: SHA_A, requester: requester('x') }));
    expect(r.code).toBe('invalid_request');
    expect(r.message).toMatch(/not built by Shipyard/);
  });

  it('queues a build, then shipyard_build_status round-trips its state and stages', async () => {
    const client = await connect(await tokenFor('a', ['shipyard']));
    const accepted = okOf<{ buildId: string; state: string; created: boolean; message: string }>(
      await call(client, 'shipyard_build', { app: 'shipyard', sha: SHA_A, requester: requester('claude: build it') }),
    );
    expect(accepted.state).toBe('queued');
    expect(accepted.created).toBe(true);
    expect(accepted.buildId).toMatch(/^[0-9a-f-]{36}$/);
    expect(accepted.message).toMatch(/shipyard_build_status/);

    const row = await db.build.findUniqueOrThrow({ where: { id: accepted.buildId } });
    expect(row.requesterLabel).toBe('claude: build it');
    expect(row.trigger).toBe('mcp');

    const status = okOf<{ buildId: string; app: string; sha: string; state: string; stages: unknown[]; deployable: boolean }>(
      await call(client, 'shipyard_build_status', { buildId: accepted.buildId }),
    );
    expect(status.buildId).toBe(accepted.buildId);
    expect(status.app).toBe('shipyard');
    expect(status.sha).toBe(SHA_A);
    expect(status.state).toBe('queued');
    expect(status.deployable).toBe(false);
    expect(Array.isArray(status.stages)).toBe(true);
  });

  it('repeat build of the same open SHA returns the same buildId with created: false', async () => {
    const client = await connect(await tokenFor('a', ['shipyard']));
    const first = okOf<{ buildId: string; created: boolean }>(
      await call(client, 'shipyard_build', { app: 'shipyard', sha: SHA_A, requester: requester('a') }),
    );
    const second = okOf<{ buildId: string; created: boolean }>(
      await call(client, 'shipyard_build', { app: 'shipyard', sha: SHA_A, requester: requester('b') }),
    );
    expect(second.buildId).toBe(first.buildId);
    expect(second.created).toBe(false);
    expect(await db.build.count()).toBe(1);
  });
});

describe('shipyard_build_status', () => {
  it('rejects a non-uuid buildId at the schema', async () => {
    const client = await connect(await tokenFor('a', ['shipyard']));
    const result = await call(client, 'shipyard_build_status', { buildId: 'not-a-uuid' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/validation/i);
  });

  it('refuses an unknown build with not_found', async () => {
    const client = await connect(await tokenFor('a', ['shipyard']));
    const r = refusalOf(await call(client, 'shipyard_build_status', { buildId: randomUUID() }));
    expect(r.code).toBe('not_found');
  });

  it('refuses a build of an app outside the token scope, without leaking existence beyond the deploy-status pattern', async () => {
    const owner = await connect(await tokenFor('owner', ['shipyard']));
    const { buildId } = okOf<{ buildId: string }>(
      await call(owner, 'shipyard_build', { app: 'shipyard', sha: SHA_A, requester: requester('owner') }),
    );
    const outsider = await connect(await tokenFor('outsider', ['web']));
    const r = refusalOf(await call(outsider, 'shipyard_build_status', { buildId }));
    expect(r.code).toBe('forbidden');
  });
});

describe('shipyard_status: build state of waiting commits', () => {
  it('shows the build state for a commit waiting to deploy on a shipyard-built app', async () => {
    // A live release at SHA_B, and a commit SHA_A waiting ahead of it on main.
    await db.deploy.create({
      data: {
        requestedSha: SHA_B,
        requesterLabel: 'earlier',
        targets: {
          create: {
            appId: appIds.get('shipyard') ?? '',
            state: 'succeeded',
            dispatchedAt: new Date(),
            endedAt: new Date(),
            images: { create: [{ service: 'server', repo: 'ghcr.io/matdemers1/shipyard-server', sha: SHA_B, digest: `sha256:${'1'.repeat(64)}` }] },
          },
        },
      },
    });
    fakeGithub.compareResult = { status: 'ahead', aheadBy: 1, behindBy: 0, commits: [{ sha: SHA_A, message: 'a change' }] };

    const client = await connect(await tokenFor('a', ['shipyard']));
    // No build yet: the waiting commit's build is null.
    const before = okOf<{ apps: { name: string; buildSource: string; commits: { sha: string; build: unknown }[] }[] }>(
      await call(client, 'shipyard_status', { app: 'shipyard' }),
    );
    expect(before.apps[0]?.buildSource).toBe('shipyard');
    expect(before.apps[0]?.commits).toEqual([{ sha: SHA_A, message: 'a change', build: null }]);

    const { buildId, state } = okOf<{ buildId: string; state: string }>(
      await call(client, 'shipyard_build', { app: 'shipyard', sha: SHA_A, requester: requester('claude') }),
    );

    const after = okOf<{ apps: { commits: { sha: string; build: { state: string; buildId: string } | null }[] }[] }>(
      await call(client, 'shipyard_status', { app: 'shipyard' }),
    );
    expect(after.apps[0]?.commits).toEqual([{ sha: SHA_A, message: 'a change', build: { state, buildId } }]);
  });

  it('a GitHub-built app carries no build state on its waiting commits', async () => {
    await db.deploy.create({
      data: {
        requestedSha: SHA_B,
        requesterLabel: 'earlier',
        targets: {
          create: {
            appId: appIds.get('web') ?? '',
            state: 'succeeded',
            dispatchedAt: new Date(),
            endedAt: new Date(),
            images: { create: [{ service: 'web', repo: 'ghcr.io/matdemers1/web', sha: SHA_B, digest: `sha256:${'2'.repeat(64)}` }] },
          },
        },
      },
    });
    fakeGithub.compareResult = { status: 'ahead', aheadBy: 1, behindBy: 0, commits: [{ sha: SHA_A, message: 'unbuilt by shipyard' }] };

    const client = await connect(await tokenFor('a', ['web']));
    const status = okOf<{ apps: { buildSource: string; commits: { build: unknown }[] }[] }>(await call(client, 'shipyard_status', { app: 'web' }));
    expect(status.apps[0]?.buildSource).toBe('github');
    expect(status.apps[0]?.commits).toEqual([{ sha: SHA_A, message: 'unbuilt by shipyard', build: null }]);
  });
});

describe('shipyard_status: cached compare (SHP-T-7.20, SHP-REQ-145)', () => {
  it('two calls within 60 s make one compare per app', async () => {
    await seedRelease('shipyard', SHA_D);
    fakeGithub.compareResult = { status: 'ahead', aheadBy: 1, behindBy: 0, commits: [{ sha: SHA_A, message: 'a change' }] };

    const client = await connect(await tokenFor('a', ['shipyard']));
    const before = fakeGithub.compareCalls;
    await call(client, 'shipyard_status', { app: 'shipyard' });
    const afterFirst = fakeGithub.compareCalls;
    expect(afterFirst).toBe(before + 1);

    await call(client, 'shipyard_status', { app: 'shipyard' });
    const afterSecond = fakeGithub.compareCalls;
    expect(afterSecond).toBe(afterFirst);
  });

  it('a failing compare is not cached: the next call retries', async () => {
    await seedRelease('web', SHA_E);
    fakeGithub.compareError = new Error('GitHub is unreachable');

    const client = await connect(await tokenFor('a', ['web']));
    const before = fakeGithub.compareCalls;
    const failed = okOf<{ apps: { commits: unknown[] }[] }>(await call(client, 'shipyard_status', { app: 'web' }));
    // Per-app failure isolation: a thrown compare yields [] for that app, never a thrown tool call.
    expect(failed.apps[0]?.commits).toEqual([]);
    expect(fakeGithub.compareCalls).toBe(before + 1);

    fakeGithub.compareError = null;
    fakeGithub.compareResult = { status: 'ahead', aheadBy: 1, behindBy: 0, commits: [{ sha: SHA_A, message: 'retried' }] };
    const retried = okOf<{ apps: { commits: { sha: string }[] }[] }>(await call(client, 'shipyard_status', { app: 'web' }));
    expect(fakeGithub.compareCalls).toBe(before + 2);
    expect(retried.apps[0]?.commits).toEqual([{ sha: SHA_A, message: 'retried', build: null }]);
  });
});
