import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { HOST_FIXTURE } from './host.js';
import { DAY, HOUR, MINUTE, ago } from './seed.js';

/**
 * Volume archives and maintenance jobs (SHP-T-17.6, SHP-ADR-012) on the baseline host: two archives
 * of the Deployed app's database volume in the agent's ledger — one quiesced, one a live copy — so
 * Host shows "Archives · 2" and the restore sheet has something to pick; and a few finished jobs
 * for Activity's Maintenance chip and Needs you: a backup that worked, a nightly backup the server
 * refused, a prune that freed space and an orphan delete the agent refused `volume_in_use`.
 *
 * Written the way the agent's report (`mirrorVolumeArchives`) and the maintenance service leave the
 * rows. They cascade from the agent: put the baseline back with `reseedWorld` afterwards.
 */

const MB = 1024 * 1024;

export const VOLUME_FIXTURE = {
  /** Owned by the Deployed app `bindery`, through `bindery-postgres-1`. */
  owned: 'bindery_pgdata',
  ownedApp: HOST_FIXTURE.deployedApp,
  /** Nothing mounts it and no app or stack claims it: Delete… for an admin. */
  orphan: HOST_FIXTURE.orphanVolume,
  /** Mounted only by the Observed `forgejo` project. */
  observed: 'forgejo_data',
  newestArchive: '0f5e7a10-3c1b-4b0e-9d8e-4a1b2c3d4e01',
  olderArchive: '0f5e7a10-3c1b-4b0e-9d8e-4a1b2c3d4e02',
  failedBackupMessage: 'The agent that runs this has not polled the server recently.',
  failedBackupFix: 'Check the agent is running and can reach the server, then retry.',
  deleteRefusedMessage: 'A container mounts it now: kardashev-db-1 (stopped).',
  deleteRefusedFix: 'Remove kardashev-db-1 first, then delete again, or keep the volume. Nothing was deleted.',
} as const;

const sha = (n: number): string => n.toString(16).padStart(64, '0');

export async function seedVolumeArchives(db: Db, agentId: string, now: number = Date.now()): Promise<void> {
  const owner = { ownerKind: 'app', ownerName: VOLUME_FIXTURE.ownedApp };
  await db.volumeArchive.createMany({
    data: [
      { archiveId: VOLUME_FIXTURE.newestArchive, agentId, volume: VOLUME_FIXTURE.owned, ...owner, createdAt: ago(3 * HOUR, now), sizeBytes: BigInt(2355 * MB), sha256: sha(1), quiesced: true, seenAt: new Date(now) },
      { archiveId: VOLUME_FIXTURE.olderArchive, agentId, volume: VOLUME_FIXTURE.owned, ...owner, createdAt: ago(4 * DAY, now), sizeBytes: BigInt(2210 * MB), sha256: sha(2), quiesced: false, seenAt: new Date(now) },
    ],
  });
}

/** Finished jobs for Activity and a refused nightly backup for Needs you. */
export async function seedMaintenanceJobs(db: Db, agentId: string, adminLabel: string, now: number = Date.now()): Promise<void> {
  const base = { agentId, requesterKind: 'user', requesterLabel: `${adminLabel} (console)` };
  const done = (created: Date) => ({ createdAt: created, dispatchedAt: created, startedAt: created, finishedAt: new Date(created.getTime() + MINUTE) });
  const backupId = randomUUID();
  await db.maintenanceJob.create({
    data: {
      ...base,
      id: backupId,
      kind: 'volume-backup',
      state: 'succeeded',
      step: 'retaining',
      volume: VOLUME_FIXTURE.owned,
      ownerKind: 'app',
      ownerName: VOLUME_FIXTURE.ownedApp,
      job: { jobId: backupId, kind: 'volume-backup', volume: VOLUME_FIXTURE.owned, owner: { kind: 'app', name: VOLUME_FIXTURE.ownedApp }, quiesce: true },
      result: {
        archive: {
          archiveId: VOLUME_FIXTURE.newestArchive,
          volume: VOLUME_FIXTURE.owned,
          owner: { kind: 'app', name: VOLUME_FIXTURE.ownedApp },
          createdAt: ago(3 * HOUR, now).toISOString(),
          sizeBytes: 2355 * MB,
          sha256: sha(1),
          quiesced: true,
        },
        removedArchives: [],
      },
      ...done(ago(3 * HOUR, now)),
    },
  });
  const nightlyId = randomUUID();
  await db.maintenanceJob.create({
    data: {
      ...base,
      id: nightlyId,
      requesterKind: 'system',
      requesterLabel: 'shipyard: nightly backup',
      kind: 'volume-backup',
      state: 'refused',
      volume: 'foreman_pgdata',
      ownerKind: 'app',
      ownerName: 'foreman',
      job: { jobId: nightlyId, kind: 'volume-backup', volume: 'foreman_pgdata', owner: { kind: 'app', name: 'foreman' }, quiesce: false },
      refusal: { code: 'agent_offline', gate: 'none', message: VOLUME_FIXTURE.failedBackupMessage, fix: VOLUME_FIXTURE.failedBackupFix },
      ...done(ago(2 * HOUR, now)),
    },
  });
  const pruneId = randomUUID();
  await db.maintenanceJob.create({
    data: {
      ...base,
      id: pruneId,
      kind: 'prune',
      state: 'succeeded',
      step: 'pruning',
      job: { jobId: pruneId, kind: 'prune', dryRun: false, fromDryRunId: randomUUID(), images: { dangling: true, unusedOlderThanHours: 168 }, buildCache: { olderThanHours: 168 } },
      result: { prune: { items: [], reclaimableBytes: 3200 * MB, reclaimedBytes: 3200 * MB } },
      ...done(ago(90 * MINUTE, now)),
    },
  });
  const deleteId = randomUUID();
  await db.maintenanceJob.create({
    data: {
      ...base,
      id: deleteId,
      kind: 'volume-delete',
      state: 'refused',
      volume: VOLUME_FIXTURE.orphan,
      job: { jobId: deleteId, kind: 'volume-delete', volume: VOLUME_FIXTURE.orphan },
      refusal: { code: 'volume_in_use', gate: 'none', message: VOLUME_FIXTURE.deleteRefusedMessage, fix: VOLUME_FIXTURE.deleteRefusedFix },
      ...done(ago(HOUR, now)),
    },
  });
}
