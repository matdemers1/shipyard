import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { getDeployStatus } from '../../src/deploys/service.js';

/**
 * SHP-T-3.3: `DeployStatus.images` carries each image's `migration` label (SHP-REQ-057, SHP-D-068)
 * — from `target_image.migration_label` for a real deploy, and from the target's stored `result`
 * JSON for a dry run, which never writes `target_image` (SHP-REQ-050).
 */

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
loadConfig({ DATABASE_URL: databaseUrl, SESSION_SECRET: 'test-session-secret' });
pino({ enabled: false });

const SHA_A = 'a'.repeat(40);

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'truncate table "target_image", "step", "outbox", "deploy_target", "deploy", "audit_event", "api_token_app", "api_token", "app", "agent", "session", "user" cascade',
  );
});

afterAll(async () => {
  await db.$disconnect();
});

async function seedApp(name: string): Promise<string> {
  const agent = await db.agent.create({ data: { publicKey: 'test-key', fingerprint: `fp-${randomUUID()}` } });
  const app = await db.app.create({
    data: { name, agentId: agent.id, manifestYaml: `name: ${name}\n`, manifestSha256: '0'.repeat(64), reportedAt: new Date() },
  });
  return app.id;
}

describe('DeployStatus.images carries a migration label', () => {
  it('a real deploy reads migration from target_image.migration_label', async () => {
    const appId = await seedApp('web');
    const deploy = await db.deploy.create({
      data: {
        kind: 'deploy',
        requestedSha: SHA_A,
        dryRun: false,
        requesterLabel: 'tester',
        targets: {
          create: {
            app: { connect: { id: appId } },
            state: 'succeeded',
            result: { gates: [] },
            endedAt: new Date(),
          },
        },
      },
      include: { targets: true },
    });
    const target = deploy.targets[0];
    if (target === undefined) throw new Error('target missing');
    await db.targetImage.create({
      data: {
        targetId: target.id,
        service: 'server',
        repo: 'ghcr.io/example/web-server',
        sha: SHA_A,
        digest: `sha256:${'1'.repeat(64)}`,
        migrationLabel: 'contract',
      },
    });
    await db.targetImage.create({
      data: {
        targetId: target.id,
        service: 'worker',
        repo: 'ghcr.io/example/web-worker',
        sha: SHA_A,
        digest: `sha256:${'2'.repeat(64)}`,
      },
    });

    const status = await getDeployStatus(db, deploy.id);
    expect(status).not.toBeNull();
    const images = [...(status?.images ?? [])].sort((a, b) => a.service.localeCompare(b.service));
    expect(images).toEqual([
      { service: 'server', sha: SHA_A, digest: `sha256:${'1'.repeat(64)}`, migration: 'contract' },
      { service: 'worker', sha: SHA_A, digest: `sha256:${'2'.repeat(64)}`, migration: null },
    ]);
  });

  it('a dry run reads its verified images and labels from the stored result JSON', async () => {
    const appId = await seedApp('web');
    const deploy = await db.deploy.create({
      data: {
        kind: 'deploy',
        requestedSha: SHA_A,
        dryRun: true,
        requesterLabel: 'tester',
        targets: {
          create: {
            app: { connect: { id: appId } },
            state: 'succeeded',
            result: {
              gates: [{ gate: 'G5', pass: true, reason: 'ok' }],
              images: [
                { service: 'server', sha: SHA_A, digest: `sha256:${'3'.repeat(64)}`, migration: 'contract' },
                { service: 'worker', sha: SHA_A, digest: `sha256:${'4'.repeat(64)}`, migration: null },
              ],
            },
            endedAt: new Date(),
          },
        },
      },
      include: { targets: true },
    });

    const status = await getDeployStatus(db, deploy.id);
    expect(status).not.toBeNull();
    const images = [...(status?.images ?? [])].sort((a, b) => a.service.localeCompare(b.service));
    expect(images).toEqual([
      { service: 'server', sha: SHA_A, digest: `sha256:${'3'.repeat(64)}`, migration: 'contract' },
      { service: 'worker', sha: SHA_A, digest: `sha256:${'4'.repeat(64)}`, migration: null },
    ]);
    // A dry run never writes target_image (SHP-REQ-050).
    const targetId = deploy.targets[0]?.id ?? '';
    const rows = await db.targetImage.findMany({ where: { targetId } });
    expect(rows).toHaveLength(0);
  });

  it('malformed result images are dropped rather than failing the status read', async () => {
    const appId = await seedApp('web');
    const deploy = await db.deploy.create({
      data: {
        kind: 'deploy',
        requestedSha: SHA_A,
        dryRun: true,
        requesterLabel: 'tester',
        targets: {
          create: {
            app: { connect: { id: appId } },
            state: 'queued',
            result: { gates: [], images: [{ service: 'server' }, 'not-an-image', null] },
          },
        },
      },
      include: { targets: true },
    });

    const status = await getDeployStatus(db, deploy.id);
    expect(status?.images).toEqual([]);
  });
});
