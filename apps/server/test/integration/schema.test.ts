import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'truncate table "outbox", "step", "target_image", "deploy_target", "deploy", ' +
      '"api_token_app", "api_token", "session", "identity", "agent", "app", "user", "audit_event" cascade',
  );
}

async function makeAgent(): Promise<string> {
  const agent = await db.agent.create({
    data: { publicKey: 'base64-key', fingerprint: `fp-${randomUUID()}` },
  });
  return agent.id;
}

async function makeApp(agentId: string, name: string): Promise<string> {
  const app = await db.app.create({
    data: {
      name,
      agentId,
      manifestYaml: 'services: {}',
      manifestSha256: 'a'.repeat(64),
    },
  });
  return app.id;
}

async function makeDeploy(): Promise<string> {
  const deploy = await db.deploy.create({
    data: { requestedSha: 'a'.repeat(40), requesterLabel: 'test' },
  });
  return deploy.id;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('deploy_target_one_active_per_app partial unique index', () => {
  it('exists in pg_indexes with the expected WHERE clause', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where indexname = 'deploy_target_one_active_per_app'`,
      );
      expect(rows).toHaveLength(1);
      const indexdef = rows[0]?.indexdef ?? '';
      expect(indexdef).toContain('WHERE');
      for (const state of [
        'locked',
        'verifying',
        'backing_up',
        'migrating',
        'pulling',
        'swapping',
        'checking',
        'soaking',
        'rolling_back',
      ]) {
        expect(indexdef).toContain(state);
      }
      expect(indexdef).not.toContain('succeeded');
      expect(indexdef).not.toContain('queued');
    } finally {
      await client.end();
    }
  });

  it('allows two queued targets for the same app', async () => {
    const agentId = await makeAgent();
    const appId = await makeApp(agentId, `app-${randomUUID()}`);
    const deployId = await makeDeploy();

    await db.deployTarget.create({ data: { deployId, appId, state: 'queued' } });
    await db.deployTarget.create({ data: { deployId, appId, state: 'queued' } });

    const count = await db.deployTarget.count({ where: { appId } });
    expect(count).toBe(2);
  });

  it('rejects a second active target for the same app', async () => {
    const agentId = await makeAgent();
    const appId = await makeApp(agentId, `app-${randomUUID()}`);
    const deployId = await makeDeploy();

    await db.deployTarget.create({ data: { deployId, appId, state: 'swapping' } });

    await expect(db.deployTarget.create({ data: { deployId, appId, state: 'locked' } })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('allows a succeeded target alongside an active one for the same app', async () => {
    const agentId = await makeAgent();
    const appId = await makeApp(agentId, `app-${randomUUID()}`);
    const deployId = await makeDeploy();

    await db.deployTarget.create({ data: { deployId, appId, state: 'succeeded' } });
    await db.deployTarget.create({ data: { deployId, appId, state: 'migrating' } });

    const count = await db.deployTarget.count({ where: { appId } });
    expect(count).toBe(2);
  });

  it('allows active targets for two different apps', async () => {
    const agentId = await makeAgent();
    const appOneId = await makeApp(agentId, `app-${randomUUID()}`);
    const appTwoId = await makeApp(agentId, `app-${randomUUID()}`);
    const deployId = await makeDeploy();

    await db.deployTarget.create({ data: { deployId, appId: appOneId, state: 'soaking' } });
    await db.deployTarget.create({ data: { deployId, appId: appTwoId, state: 'checking' } });

    expect(await db.deployTarget.count({ where: { appId: appOneId } })).toBe(1);
    expect(await db.deployTarget.count({ where: { appId: appTwoId } })).toBe(1);
  });
});
