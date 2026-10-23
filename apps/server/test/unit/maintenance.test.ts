import { describe, expect, it } from 'vitest';
import { destructiveRefusal, isMaintenanceTerminal, maintenanceInScope, toMaintenanceStatus, type MaintenanceRow } from '../../src/maintenance/service.js';

/** SHP-T-17.3: the pure parts of volume maintenance (SHP-ADR-012; SHP-REQ-202, SHP-REQ-203, SHP-REQ-204). */

const user = { type: 'user' as const, id: 'u1', label: 'matt@example.com' };
const token = { type: 'token' as const, id: 't1', label: 'token claude' };
const ID = '11111111-1111-4111-8111-111111111111';
const ARCHIVE = {
  archiveId: '22222222-2222-4222-8222-222222222222',
  volume: 'web_data',
  owner: { kind: 'app', name: 'web' },
  createdAt: '2026-10-22T03:00:00.000Z',
  sizeBytes: 10,
  sha256: 'a'.repeat(64),
  quiesced: false,
} as const;

function row(extra: Partial<MaintenanceRow> = {}): MaintenanceRow {
  const at = new Date('2026-10-22T03:00:00.000Z');
  return {
    id: ID,
    agentId: '33333333-3333-4333-8333-333333333333',
    kind: 'volume-backup',
    state: 'queued',
    step: null,
    volume: 'web_data',
    ownerKind: 'app',
    ownerName: 'web',
    job: {},
    dryRunOf: null,
    requesterKind: 'system',
    requesterLabel: 'shipyard: nightly backup',
    result: null,
    refusal: null,
    createdAt: at,
    dispatchedAt: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: at,
    ...extra,
  };
}

describe('destructiveRefusal (SHP-REQ-202, SHP-REQ-203, SHP-REQ-204)', () => {
  it('refuses a token whatever its role, anyone but an admin, and nobody', () => {
    expect(destructiveRefusal({ actor: token, role: 'admin' }, 'restore')).toMatchObject({ code: 'forbidden', message: expect.stringContaining('console-only') as string });
    expect(destructiveRefusal({ actor: user, role: 'deployer' }, 'delete')?.code).toBe('forbidden');
    expect(destructiveRefusal({ actor: user, role: 'operator' }, 'restore')?.code).toBe('forbidden');
    expect(destructiveRefusal({ actor: undefined, role: undefined }, 'restore')?.code).toBe('unauthenticated');
    expect(destructiveRefusal({ actor: { type: 'agent', label: 'agent' }, role: undefined }, 'restore')?.code).toBe('forbidden');
    expect(destructiveRefusal({ actor: user, role: 'admin' }, 'restore')).toBeNull();
  });
});

describe('maintenanceInScope', () => {
  const apps = new Set(['web']);
  const stacks = new Set(['forgejo']);
  it('lets a user read everything, a token only its owners and every prune', () => {
    expect(maintenanceInScope({ actor: user, tokenApps: undefined, tokenStacks: undefined }, { kind: 'volume-delete', owner: null })).toBe(true);
    const caller = { actor: token, tokenApps: apps, tokenStacks: stacks };
    expect(maintenanceInScope(caller, { kind: 'volume-backup', owner: { kind: 'app', name: 'web' } })).toBe(true);
    expect(maintenanceInScope(caller, { kind: 'volume-backup', owner: { kind: 'stack', name: 'forgejo' } })).toBe(true);
    expect(maintenanceInScope(caller, { kind: 'volume-backup', owner: { kind: 'stack', name: 'web' } })).toBe(false);
    expect(maintenanceInScope(caller, { kind: 'volume-restore', owner: { kind: 'app', name: 'api' } })).toBe(false);
    expect(maintenanceInScope(caller, { kind: 'volume-delete', owner: null })).toBe(false);
    expect(maintenanceInScope(caller, { kind: 'prune', owner: null })).toBe(true);
  });
});

describe('toMaintenanceStatus', () => {
  it('reads the stored result, refusal and owner, and tolerates junk', () => {
    const status = toMaintenanceStatus(
      row({ state: 'succeeded', step: 'retaining', result: { archive: ARCHIVE, removedArchives: [ID], output: 'ok' }, finishedAt: new Date('2026-10-22T03:01:00.000Z') }),
    );
    expect(status).toMatchObject({
      kind: 'volume-backup',
      state: 'succeeded',
      step: 'retaining',
      owner: { kind: 'app', name: 'web' },
      requester: { kind: 'system', label: 'shipyard: nightly backup' },
      archive: ARCHIVE,
      removedArchives: [ID],
      prune: null,
      output: 'ok',
      finishedAt: '2026-10-22T03:01:00.000Z',
    });
    const junk = toMaintenanceStatus(row({ step: 'nonsense', result: { archive: { path: '/etc' } }, refusal: { nope: true }, ownerKind: 'thing' }));
    expect(junk).toMatchObject({ step: null, archive: null, refusal: null, owner: null });
  });

  it('knows which states are terminal', () => {
    expect(['queued', 'dispatched', 'running'].map((s) => isMaintenanceTerminal(s as 'queued'))).toEqual([false, false, false]);
    expect(['succeeded', 'failed', 'refused', 'cancelled'].map((s) => isMaintenanceTerminal(s as 'failed'))).toEqual([true, true, true, true]);
  });
});
