import { describe, expect, it } from 'vitest';
import type { StackManifest } from '@shipyard/schema';
import {
  approvalHolds,
  digestsFor,
  isStackUpdateTerminal,
  parseServicesMirror,
  parseStackManifest,
  stackUpdatePermissionRefusal,
  toStackUpdateStatus,
  type StackUpdateRow,
} from '../../src/stack-updates/service.js';

/** SHP-T-16.3: the pure parts of stack updates (SHP-ADR-010; SHP-REQ-195, SHP-REQ-199, SHP-REQ-200). */

const user = { type: 'user' as const, id: 'u1', label: 'matt@example.com' };
const token = { type: 'token' as const, id: 't1', label: 'token claude' };
const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const D3 = `sha256:${'3'.repeat(64)}`;

const manifest = {
  kind: 'stack',
  name: 'forgejo',
  compose: { files: ['/DATA/AppData/forgejo/docker-compose.yml'], project: 'forgejo' },
  updates: 'digest',
  services: {
    server: { image: 'codeberg.org/forgejo/forgejo', track: { semver: '11.x' } },
    db: { image: 'postgres', track: 'pinned' },
    cache: { image: 'redis', track: { tag: '7' } },
  },
  soakSeconds: 60,
  approval: 'tokens',
} satisfies StackManifest;

function stack(services: Record<string, { running: string | null; candidate: { tag: string; digest: string } | null }> = {}) {
  return {
    name: 'forgejo',
    manifest,
    services: Object.fromEntries(Object.entries(services).map(([k, v]) => [k, { ...v, checkedAt: null, error: null }])),
  };
}

describe('stackUpdatePermissionRefusal', () => {
  it('lets a deployer, operator or admin update', () => {
    for (const role of ['deployer', 'operator', 'admin'] as const) {
      expect(stackUpdatePermissionRefusal({ actor: user, role, tokenStacks: undefined }, 'forgejo')).toBeNull();
    }
  });

  it('refuses a viewer, a token whose owner is one, and an anonymous caller', () => {
    expect(stackUpdatePermissionRefusal({ actor: user, role: 'viewer', tokenStacks: undefined }, 'forgejo')).toMatchObject({ code: 'forbidden' });
    expect(stackUpdatePermissionRefusal({ actor: token, role: 'viewer', tokenStacks: new Set(['forgejo']) }, 'forgejo')).toMatchObject({ code: 'forbidden' });
    expect(stackUpdatePermissionRefusal({ actor: undefined, role: undefined, tokenStacks: undefined }, 'forgejo')).toMatchObject({ code: 'unauthenticated' });
  });

  it('lets a token act only on a stack its scope names', () => {
    expect(stackUpdatePermissionRefusal({ actor: token, role: 'deployer', tokenStacks: new Set(['forgejo']) }, 'forgejo')).toBeNull();
    expect(stackUpdatePermissionRefusal({ actor: token, role: 'deployer', tokenStacks: new Set(['immich']) }, 'forgejo')).toMatchObject({ code: 'forbidden' });
    expect(stackUpdatePermissionRefusal({ actor: token, role: 'deployer', tokenStacks: undefined }, 'forgejo')).toMatchObject({ code: 'forbidden' });
  });
});

describe('approvalHolds (SHP-REQ-199)', () => {
  it('holds by policy: tokens holds only a token, always holds everyone, never no one', () => {
    expect(approvalHolds('tokens', 'token')).toBe(true);
    expect(approvalHolds('tokens', 'user')).toBe(false);
    expect(approvalHolds('always', 'user')).toBe(true);
    expect(approvalHolds('always', 'token')).toBe(true);
    expect(approvalHolds('never', 'token')).toBe(false);
    expect(approvalHolds('never', 'user')).toBe(false);
  });
});

describe('digestsFor (SHP-REQ-195)', () => {
  it('defaults to the reported candidates of unpinned services', () => {
    const chosen = digestsFor(
      stack({
        server: { running: D1, candidate: { tag: '11.0.2', digest: D2 } },
        cache: { running: D1, candidate: null },
        db: { running: D1, candidate: { tag: '16', digest: D3 } },
      }),
      undefined,
    );
    expect(chosen).toEqual({ digests: { server: D2 } });
  });

  it('refuses when no service has a candidate', () => {
    const chosen = digestsFor(stack({ server: { running: D1, candidate: null } }), undefined);
    expect(chosen).toMatchObject({ refusal: { code: 'conflict' } });
  });

  it('takes explicit digests only for tracked, unpinned services', () => {
    expect(digestsFor(stack(), { server: D2, cache: D3 })).toEqual({ digests: { server: D2, cache: D3 } });
    expect(digestsFor(stack(), { web: D2 })).toMatchObject({ refusal: { code: 'digest_not_tracked' } });
    expect(digestsFor(stack(), { db: D2 })).toMatchObject({ refusal: { code: 'digest_not_tracked' } });
    expect(digestsFor(stack(), {})).toMatchObject({ refusal: { code: 'invalid_request' } });
  });

  it('is not fooled by a service named code', () => {
    const coded = { ...manifest, services: { code: { image: 'gitea/gitea', track: { tag: 'latest' } } } } satisfies StackManifest;
    expect(digestsFor({ name: 'forgejo', manifest: coded, services: {} }, { code: D1 })).toEqual({ digests: { code: D1 } });
  });
});

describe('the stored mirror and rows', () => {
  it('parses a digest manifest and a services mirror, and tolerates junk', () => {
    expect(parseStackManifest(JSON.stringify(manifest))?.updates).toBe('digest');
    expect(parseStackManifest('{}')).toBeNull();
    expect(parseStackManifest('not json')).toBeNull();
    expect(parseServicesMirror({ server: { running: D1, candidate: null, checkedAt: null, error: null } })).toHaveProperty('server');
    expect(parseServicesMirror(null)).toEqual({});
    expect(parseServicesMirror({ server: { running: 'latest' } })).toEqual({});
  });

  it('renders a row as StackUpdateStatus, with approvedBy only for an approval (SHP-REQ-200)', () => {
    const now = new Date('2026-10-23T00:00:00.000Z');
    const row: StackUpdateRow = {
      id: '00000000-0000-4000-8000-000000000001',
      stackId: '00000000-0000-4000-8000-000000000002',
      stackName: 'forgejo',
      agentId: '00000000-0000-4000-8000-000000000003',
      kind: 'update',
      state: 'succeeded',
      step: 'soaking',
      digests: { server: D2 },
      toUpdateId: null,
      images: [{ service: 'server', tag: '11.0.2', digest: D2 }],
      previous: [{ service: 'server', tag: '11.0.1', digest: D1 }],
      soakSeconds: 60,
      requesterLabel: 'matt@example.com (console)',
      decidedByLabel: 'admin@example.com',
      refusal: null,
      dispatchedAt: now,
      startedAt: now,
      endedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    expect(toStackUpdateStatus(row)).toEqual({
      id: row.id,
      stack: 'forgejo',
      kind: 'update',
      state: 'succeeded',
      step: 'soaking',
      digests: { server: D2 },
      images: [{ service: 'server', tag: '11.0.2', digest: D2 }],
      previous: [{ service: 'server', tag: '11.0.1', digest: D1 }],
      toUpdateId: null,
      requesterLabel: 'matt@example.com (console)',
      approvedBy: 'admin@example.com',
      createdAt: now.toISOString(),
      startedAt: now.toISOString(),
      endedAt: now.toISOString(),
      refusal: null,
    });
    expect(toStackUpdateStatus({ ...row, state: 'denied', images: null, previous: null, step: 'bogus' })).toMatchObject({ approvedBy: null, images: [], previous: [], step: null });
    expect(isStackUpdateTerminal('rolled_back')).toBe(true);
    expect(isStackUpdateTerminal('awaiting_approval')).toBe(false);
  });
});
