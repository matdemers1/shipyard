import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CATALOGUE,
  MCP_TOOLS,
  MaintenanceJob,
  Manifest,
  PollRequest,
  PollResponse,
  PruneRequest,
  ShipyardPruneInput,
  ShipyardVolumeBackupInput,
  StackManifest,
  VolumeArchive,
  VolumeBackupSettings,
  VolumeName,
  VolumeRestoreRequest,
  refusal,
} from '../src/index.js';

/** SHP-ADR-012, SHP-REQ-201..206: volume and prune jobs carry names and IDs, never commands or paths. */

const JOB = '01a1618d-cfae-7334-b900-4db7f8d33985';
const DRY = '01a16651-1b2c-7d3e-8f40-5a6b7c8d9e0f';
const req = { repo: 'D3Cloud-io/shipyard', branch: 'main', label: 'claude' };

describe('VolumeName', () => {
  it('refuses a name that starts with - so it can never read as a flag', () => {
    expect(VolumeName.safeParse('-v').success).toBe(false);
    expect(VolumeName.safeParse('forgejo_data').success).toBe(true);
  });
});

describe('MaintenanceJob', () => {
  const images = { dangling: true, unusedOlderThanHours: 168 };
  const buildCache = { olderThanHours: 168 };

  it('refuses a real prune that does not name its dry run (SHP-REQ-205)', () => {
    expect(MaintenanceJob.safeParse({ jobId: JOB, kind: 'prune', dryRun: false, images, buildCache }).success).toBe(false);
    expect(MaintenanceJob.safeParse({ jobId: JOB, kind: 'prune', dryRun: false, fromDryRunId: DRY, images, buildCache }).success).toBe(true);
    expect(MaintenanceJob.safeParse({ jobId: JOB, kind: 'prune', dryRun: true, images, buildCache }).success).toBe(true);
  });

  it('refuses an unknown key on every kind', () => {
    const owner = { kind: 'app', name: 'shipyard' };
    for (const job of [
      { jobId: JOB, kind: 'volume-backup', volume: 'v', owner, quiesce: false },
      { jobId: JOB, kind: 'volume-restore', volume: 'v', owner, archiveId: DRY },
      { jobId: JOB, kind: 'volume-delete', volume: 'v' },
      { jobId: JOB, kind: 'prune', dryRun: true, images, buildCache },
    ]) {
      expect(MaintenanceJob.safeParse(job).success).toBe(true);
      expect(MaintenanceJob.safeParse({ ...job, path: '/etc' }).success).toBe(false);
    }
  });

  it('rides the poll only as a maintenance job, and the agent can advertise it', () => {
    expect(PollRequest.safeParse({ waitSeconds: 1, capabilities: ['maintenance'] }).success).toBe(true);
    const job = { jobId: JOB, kind: 'volume-delete', volume: 'orphan' };
    expect(PollResponse.safeParse({ target: null, maintenance: job }).success).toBe(true);
    expect(PollResponse.safeParse({ target: null, maintenance: { ...job, command: 'rm' } }).success).toBe(false);
  });
});

describe('VolumeArchive', () => {
  it('has no path field: the agent resolves an archive by ID in its own ledger', () => {
    expect(Object.keys(VolumeArchive.shape)).not.toContain('path');
    const archive = {
      archiveId: JOB,
      volume: 'v',
      owner: null,
      createdAt: '2026-10-22T03:00:00Z',
      sizeBytes: 1,
      sha256: 'c'.repeat(64),
      quiesced: false,
    };
    expect(VolumeArchive.safeParse(archive).success).toBe(true);
    expect(VolumeArchive.safeParse({ ...archive, path: '/x' }).success).toBe(false);
  });
});

describe('REST and MCP bodies', () => {
  it('a restore names an archive by ID, never a path (SHP-REQ-202)', () => {
    expect(VolumeRestoreRequest.safeParse({ archiveId: JOB, confirmVolume: 'v' }).success).toBe(true);
    expect(VolumeRestoreRequest.safeParse({ path: '/x.tar.zst', confirmVolume: 'v' }).success).toBe(false);
  });

  it('PruneRequest defaults to a dry run and refuses a real prune without one', () => {
    expect(PruneRequest.parse({}).dryRun).toBe(true);
    expect(PruneRequest.safeParse({ dryRun: false }).success).toBe(false);
    expect(PruneRequest.safeParse({ dryRun: false, fromDryRunId: DRY }).success).toBe(true);
    const parsed = PruneRequest.parse({ images: {}, buildCache: {} });
    expect(parsed.images).toEqual({ dangling: true, unusedOlderThanHours: 168 });
    expect(parsed.buildCache).toEqual({ olderThanHours: 168 });
  });

  it('MCP has prune and volume backup but no restore or delete tool (SHP-ADR-012)', () => {
    expect(MCP_TOOLS.shipyard_prune).toBe(ShipyardPruneInput);
    expect(MCP_TOOLS.shipyard_volume_backup).toBe(ShipyardVolumeBackupInput);
    const tools = Object.keys(MCP_TOOLS);
    expect(tools.filter((t) => /restore|delete/.test(t))).toEqual([]);
    expect(ShipyardPruneInput.safeParse({ dryRun: false, requester: req }).success).toBe(false);
    expect(ShipyardVolumeBackupInput.safeParse({ volume: '-x', requester: req }).success).toBe(false);
  });
});

describe('volumeBackups in manifests', () => {
  const app = { name: 'd3auth', repo: 'matdemers1/d3-auth', workflow: 'ci.yml', compose: { files: ['/x/compose.yml'], project: 'd3auth' }, services: { app: { image: 'ghcr.io/matdemers1/d3-auth' } }, health: { service: 'app', port: 3000, path: '/health' } };
  const lifecycle = { kind: 'stack', name: 'plex', compose: { files: ['/x/docker-compose.yml'], project: 'plex' } };
  const digest = {
    ...lifecycle,
    updates: 'digest',
    services: { server: { image: 'codeberg.org/forgejo/forgejo', track: { semver: '17.x' } } },
  };

  it('defaults retain to 7 and the flags to false', () => {
    expect(VolumeBackupSettings.parse({})).toEqual({ retain: 7, quiesce: false, nightly: false, beforeUpdate: false });
    expect(VolumeBackupSettings.safeParse({ retain: 101 }).success).toBe(false);
  });

  it('both stack variants and the app manifest accept it, with or without it', () => {
    for (const [schema, base] of [
      [Manifest, app],
      [StackManifest, lifecycle],
      [StackManifest, digest],
    ] as const) {
      expect((schema as z.ZodType).safeParse(base).success, JSON.stringify(base)).toBe(true);
      const withIt = (schema as z.ZodType).safeParse({ ...base, volumeBackups: { nightly: true, retain: 3 } });
      expect(withIt.success, JSON.stringify(withIt)).toBe(true);
      expect((schema as z.ZodType).safeParse({ ...base, volumeBackups: { argv: ['tar'] } }).success).toBe(false);
    }
  });
});

describe('errors', () => {
  it('carries the volume refusals with their statuses and fixes', () => {
    expect(CATALOGUE.volume_in_use.httpStatus).toBe(409);
    expect(CATALOGUE.archive_not_found.httpStatus).toBe(404);
    expect(CATALOGUE.confirmation_mismatch.httpStatus).toBe(400);
    expect(CATALOGUE.volume_not_owned.httpStatus).toBe(409);
    expect(CATALOGUE.dry_run_required.httpStatus).toBe(409);
    expect(refusal('confirmation_mismatch', 'typed name differs').fix).toBe("Type the volume's name exactly to confirm.");
    expect(refusal('dry_run_required', 'no dry run').fix).toBe('Run a dry run first and prune from its list.');
  });
});
