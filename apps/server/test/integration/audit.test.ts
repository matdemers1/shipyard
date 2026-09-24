import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { Router } from 'express';
import pino, { type Logger } from 'pino';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL must be set for integration tests');
}

const db: Db = createDb(databaseUrl);
const config = loadConfig({ DATABASE_URL: databaseUrl });

async function makeUser(): Promise<string> {
  const user = await db.user.create({
    data: { email: `test-${randomUUID()}@example.com`, displayName: 'Test User' },
  });
  return user.id;
}

function buildApp(onUnauditedMutation?: (info: { method: string; path: string; requestId: string }) => void): {
  app: Express;
  logger: Logger;
} {
  const logger = pino({ enabled: false });
  const testRouter = Router();

  testRouter.post('/audited', (req, res, next) => {
    const body = req.body as { actorId: string };
    req.actor = { type: 'user', id: body.actorId, label: 'test user' };
    req
      .audit({ action: 'test.create', entityType: 'thing', entityId: 'thing-1' })
      .then(() => {
        res.status(201).json({ ok: true });
      })
      .catch(next);
  });

  testRouter.post('/unaudited', (_req, res) => {
    res.status(201).json({ ok: true });
  });

  testRouter.get('/reader', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const app = createApp({
    db,
    logger,
    config,
    testRouter,
    ...(onUnauditedMutation === undefined ? {} : { onUnauditedMutation }),
  });
  return { app, logger };
}

beforeEach(async () => {
  await db.$executeRawUnsafe('truncate table "audit_event" cascade');
  await db.$executeRawUnsafe('truncate table "user" cascade');
});

afterAll(async () => {
  await db.$disconnect();
});

describe('req.audit', () => {
  it('writes an audit_event row with the actor, action, requestId and ip', async () => {
    const userId = await makeUser();
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/_test/audited')
      .set('x-request-id', 'req-abc-123')
      .send({ actorId: userId });

    expect(res.status).toBe(201);

    const rows = await db.auditEvent.findMany({ where: { entityType: 'thing', entityId: 'thing-1' } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.actorType).toBe('user');
    expect(row?.actorUserId).toBe(userId);
    expect(row?.actorLabel).toBe('test user');
    expect(row?.action).toBe('test.create');
    expect(row?.requestId).toBe('req-abc-123');
    expect(row?.ip).toBeTruthy();
  });
});

describe('the unaudited-mutation guard', () => {
  it('fires when a mutating request succeeds without writing an audit row', async () => {
    const calls: { method: string; path: string; requestId: string }[] = [];
    const { app } = buildApp((info) => {
      calls.push(info);
    });

    const res = await request(app).post('/api/_test/unaudited');

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/unaudited');
  });

  it('never fires for a GET', async () => {
    const calls: unknown[] = [];
    const { app } = buildApp((info) => {
      calls.push(info);
    });

    const res = await request(app).get('/api/_test/reader');

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('does not fire when the mutation did write an audit row', async () => {
    const userId = await makeUser();
    const calls: unknown[] = [];
    const { app } = buildApp((info) => {
      calls.push(info);
    });

    const res = await request(app).post('/api/_test/audited').send({ actorId: userId });

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(0);
  });
});
