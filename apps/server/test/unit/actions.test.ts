import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_FRESH_MS, capabilityRefusal, recordCapabilities } from '../../src/agent/capabilities.js';
import { REQUESTER_LABEL_MAX, actionPermissionRefusal, actionRequesterLabel } from '../../src/actions/service.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db.js';
import { Bus } from '../../src/events.js';

/** SHP-T-15.4: the pure parts of lifecycle actions and the agent's advertised capabilities. */

const user = { type: 'user' as const, id: 'u1', label: 'matt@example.com' };
const token = { type: 'token' as const, id: 't1', label: 'token claude' };
const WEB = { kind: 'app' as const, name: 'web' };
const PG = { kind: 'stack' as const, name: 'pg-stack' };

describe('actionPermissionRefusal', () => {
  it('lets a deployer, operator or admin act', () => {
    for (const role of ['deployer', 'operator', 'admin'] as const) {
      expect(actionPermissionRefusal({ actor: user, role, tokenApps: undefined }, 'stop', WEB)).toBeNull();
    }
  });

  it('refuses a viewer, and a token whose owner is one (SHP-REQ-184)', () => {
    expect(actionPermissionRefusal({ actor: user, role: 'viewer', tokenApps: undefined }, 'restart', WEB)).toMatchObject({ code: 'forbidden' });
    expect(actionPermissionRefusal({ actor: token, role: 'viewer', tokenApps: new Set(['web']) }, 'restart', WEB)).toMatchObject({ code: 'forbidden' });
  });

  it('refuses a stop from an API token, pointing at the console (SHP-REQ-188)', () => {
    const r = actionPermissionRefusal({ actor: token, role: 'admin', tokenApps: new Set(['web']) }, 'stop', WEB);
    expect(r).toMatchObject({ code: 'forbidden', fix: 'Stop it from the console.' });
    expect(actionPermissionRefusal({ actor: token, role: 'admin', tokenApps: new Set(['web']) }, 'restart', WEB)).toBeNull();
  });

  it('refuses a token not scoped to the target', () => {
    expect(actionPermissionRefusal({ actor: token, role: 'admin', tokenApps: new Set(['api']) }, 'restart', WEB)).toMatchObject({ code: 'forbidden' });
  });

  it('reads a token scope by kind: an app through its apps, a stack through its stacks', () => {
    const scoped = { actor: token, role: 'deployer' as const, tokenApps: new Set(['web']), tokenStacks: new Set(['pg-stack']) };
    expect(actionPermissionRefusal(scoped, 'restart', PG)).toBeNull();
    expect(actionPermissionRefusal(scoped, 'restart', WEB)).toBeNull();
    expect(actionPermissionRefusal(scoped, 'restart', { kind: 'stack', name: 'web' })).toMatchObject({ code: 'forbidden' });
    expect(actionPermissionRefusal(scoped, 'restart', { kind: 'app', name: 'pg-stack' })).toMatchObject({ code: 'forbidden' });
  });

  it('refuses anonymous and agent callers', () => {
    expect(actionPermissionRefusal({ actor: undefined, role: undefined, tokenApps: undefined }, 'start', WEB)).toMatchObject({ code: 'unauthenticated' });
    expect(actionPermissionRefusal({ actor: { type: 'agent', label: 'agent' }, role: undefined, tokenApps: undefined }, 'start', WEB)).toMatchObject({ code: 'forbidden' });
  });
});

describe('actionRequesterLabel', () => {
  it('names the console user or the token, with the caller-given label in front', () => {
    expect(actionRequesterLabel(user)).toBe('matt@example.com (console)');
    expect(actionRequesterLabel(token)).toBe('token claude');
    expect(actionRequesterLabel(token, 'claude: shipyard restart')).toBe('claude: shipyard restart (token claude)');
  });

  it('is cut to the job limit', () => {
    expect(actionRequesterLabel(user, 'x'.repeat(500))).toHaveLength(REQUESTER_LABEL_MAX);
  });
});

describe('capabilityRefusal', () => {
  it('is agent_offline before a poll, agent_too_old without the capability, null with it', () => {
    const bus = new Bus();
    expect(capabilityRefusal(bus, 'a1', 'actions')).toMatchObject({ code: 'agent_offline' });
    recordCapabilities(bus, 'a1', undefined);
    expect(capabilityRefusal(bus, 'a1', 'actions')).toMatchObject({ code: 'agent_too_old' });
    recordCapabilities(bus, 'a1', ['build', 'actions']);
    expect(capabilityRefusal(bus, 'a1', 'actions')).toBeNull();
    expect(capabilityRefusal(bus, 'a1', 'logs')).toMatchObject({ code: 'agent_too_old' });
  });

  it('forgets an agent that stopped polling', () => {
    const bus = new Bus();
    recordCapabilities(bus, 'a1', ['logs'], 1_000);
    expect(capabilityRefusal(bus, 'a1', 'logs', 1_000 + CAPABILITY_FRESH_MS)).toBeNull();
    expect(capabilityRefusal(bus, 'a1', 'logs', 1_000 + CAPABILITY_FRESH_MS + 1)).toMatchObject({ code: 'agent_offline' });
  });

  it('is per bus (per server process)', () => {
    const a = new Bus();
    recordCapabilities(a, 'a1', ['logs']);
    expect(capabilityRefusal(new Bus(), 'a1', 'logs')).toMatchObject({ code: 'agent_offline' });
  });
});

describe('the log chunk body limit', () => {
  // No database: an unsigned request is refused by the signature check before anything is read.
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused_test' });
  const app = createApp({ db: {} as Db, logger: pino({ enabled: false }), config });
  const path = '/api/agent/logs/33333333-3333-4333-8333-333333333333/chunks';
  const bodyOf = (bytes: number): string => JSON.stringify({ padding: 'x'.repeat(bytes) });

  it('parses a ~1.5 MB chunk (reaching the signature check)', async () => {
    const res = await request(app).post(path).set('content-type', 'application/json').send(bodyOf(1536 * 1024));
    expect(res.status).toBe(401);
  });

  it('refuses a malformed chunk with 400 and logs no part of it (SHP-REQ-191)', async () => {
    const lines: string[] = [];
    const captured = createApp({ db: {} as Db, logger: pino({ level: 'trace' }, { write: (s: string) => { lines.push(s); } }), config });
    const res = await request(captured).post(path).set('content-type', 'application/json').send('{"lines": [SECRET_MARKER_PASSWORD');
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid_request');
    expect(lines.join('')).not.toContain('SECRET_MARKER_PASSWORD');
    // The same on the report path, through the global error handler.
    const report = await request(captured).post('/api/agent/report').set('content-type', 'application/json').send('{"apps": SECRET_MARKER_PASSWORD');
    expect(report.status).toBe(400);
    expect(lines.join('')).toContain('entity.parse.failed');
    expect(lines.join('')).not.toContain('SECRET_MARKER_PASSWORD');
  });

  it('refuses a chunk over 2 MB with 413', async () => {
    const res = await request(app).post(path).set('content-type', 'application/json').send(bodyOf(2 * 1024 * 1024 + 1024));
    expect(res.status).toBe(413);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid_request');
  });
});
