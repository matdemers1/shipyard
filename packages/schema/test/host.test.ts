import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AgentReport } from '../src/agent.js';
import { ContainerTier, HostContainer, HostInventory, HostResponse, HostSnapshot } from '../src/host.js';

const HEX64 = 'a'.repeat(64);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const AT = '2026-10-21T12:00:00.000Z';

const container = {
  id: HEX64,
  name: 'bindery-api-1',
  image: 'ghcr.io/matdemers1/bindery/api:sha-0123456789abcdef0123456789abcdef01234567',
  imageId: IMAGE_ID,
  digest: DIGEST,
  state: 'running',
  health: 'healthy',
  restartCount: 0,
  createdAt: AT,
  startedAt: AT,
  compose: { project: 'bindery', service: 'api' },
  tier: 'shipped',
  app: 'bindery',
  ports: [{ privatePort: 8000, publicPort: null, protocol: 'tcp', ip: null }],
  mounts: [{ type: 'volume', volume: 'bindery_data', source: null, destination: '/data', readOnly: false }],
  stats: { cpuPercent: 1.5, memoryBytes: 104857600, memoryLimitBytes: null },
};

const inventory = {
  sampledAt: AT,
  containers: [
    container,
    { ...container, id: 'd'.repeat(64), name: 'plex', digest: null, compose: null, tier: 'observed', app: null, stats: null, state: 'exited', startedAt: null, health: 'none' },
  ],
  volumes: [
    { name: 'bindery_data', driver: 'local', sizeBytes: 2048, mountedBy: ['bindery-api-1'], composeProject: 'bindery', orphan: false, createdAt: AT },
    { name: 'old', driver: 'local', sizeBytes: null, mountedBy: [], composeProject: null, orphan: true, createdAt: null },
  ],
  images: [{ id: IMAGE_ID, repoTags: [], repoDigests: [], sizeBytes: 10, createdAt: AT, containers: 0, dangling: true }],
  networks: [{ id: 'e'.repeat(12), name: 'bindery_default', driver: 'bridge', scope: 'local', internal: false, containers: 3, composeProject: 'bindery' }],
  builderCache: { bytes: 4096, reclaimableBytes: 1024 },
  disk: {
    dataRoot: { path: '/DATA', freeBytes: 1, totalBytes: 2 },
    dockerRoot: null,
  },
};

const report = {
  agentVersion: '1.0.0',
  composeVersion: '5.0.0',
  engineApiVersion: '1.47',
  patExpiresAt: null,
  apps: [],
};

/** Every property name anywhere in a JSON Schema document. */
function propertyNames(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, out);
  } else if (schema !== null && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        for (const name of Object.keys(value)) out.add(name);
      }
      propertyNames(value, out);
    }
  }
  return out;
}

describe('HostInventory (SHP-T-14.3, SHP-ADR-009)', () => {
  it('parses a full inventory with shipped and observed containers, an orphan volume and a dangling image', () => {
    const result = HostInventory.safeParse(inventory);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
  });

  it('has exactly the three tiers, in order of trust', () => {
    expect(ContainerTier.options).toEqual(['shipped', 'operated', 'observed']);
  });

  it.each(['env', 'Env', 'command', 'cmd', 'entrypoint', 'labels', 'Labels', 'config'])(
    'refuses a container carrying %s (SHP-REQ-177)',
    (field) => {
      expect(HostContainer.safeParse({ ...container, [field]: ['SECRET=x'] }).success).toBe(false);
    },
  );

  it('has no field anywhere for environment, command, entrypoint or labels (SHP-REQ-177)', () => {
    const names = propertyNames(z.toJSONSchema(HostResponse, { io: 'input' }));
    const forbidden = [...names].filter((n) => /env|command|cmd|entrypoint|label|args/i.test(n));
    expect(forbidden).toEqual([]);
    // Sanity: the walk does see the schema's real fields.
    expect(names).toContain('restartCount');
    expect(names).toContain('composeProject');
  });

  it('refuses a container ID that is not 64 hex characters', () => {
    expect(HostContainer.safeParse({ ...container, id: 'abc' }).success).toBe(false);
  });
});

describe('AgentReport.host (SHP-T-14.3)', () => {
  it('still parses a report from the current agent, which sends no host', () => {
    expect(AgentReport.safeParse(report).success).toBe(true);
  });

  it('parses a report carrying an inventory', () => {
    const result = AgentReport.safeParse({ ...report, host: inventory });
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
  });

  it('refuses a report whose inventory carries a field the schema does not name', () => {
    expect(AgentReport.safeParse({ ...report, host: { ...inventory, env: {} } }).success).toBe(false);
  });
});

describe('HostSnapshot and HostResponse (SHP-T-14.3)', () => {
  const snapshot = {
    agent: { id: '01a1618d-cfae-7334-b900-4db7f8d33985', fingerprint: 'SHA256:abc' },
    reportedAt: AT,
    inventory,
    samples: { 'bindery-api-1': [{ at: AT, cpuPercent: 1.5, memoryBytes: 100 }] },
  };

  it('parses a snapshot with samples keyed by container name', () => {
    const result = HostSnapshot.safeParse(snapshot);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
  });

  it('parses an empty response, before any agent reported an inventory', () => {
    expect(HostResponse.safeParse({ hosts: [] }).success).toBe(true);
  });

  it('parses a response with one host', () => {
    expect(HostResponse.safeParse({ hosts: [snapshot] }).success).toBe(true);
  });
});
