import { z } from 'zod';

import { AppName } from './primitives.js';
import { Refusal } from './errors.js';

/**
 * Volume backups, restores, deletes and prune (SHP-ADR-012, SHP-P-17): the jobs the server hands an
 * agent that advertises `maintenance`, their progress and result, the volume archive the agent
 * reports from its own ledger, the manifest setting that schedules backups, and the status shapes
 * the console and REST read.
 *
 * What reaches the host is a volume name, an app or stack name its own manifests define, and a
 * UUID the agent resolves in its own ledger — never a command and never a path (non-negotiables 1
 * and 7, SHP-D-080). Volume backup is a built-in step: the agent runs its own image with the volume
 * mounted read-only, so no manifest supplies an argv for it. Restore and delete are console-only —
 * admin, step-up and the volume's typed name — and have no MCP tool or token path; prune is for
 * operators and tokens.
 */

/** Docker's own volume-name rule; it never starts with `-`, so a name cannot read as a flag. */
export const VolumeName = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/, 'a Docker volume name: letters, digits, _ . -, starting alphanumeric, at most 255')
  .meta({ id: 'VolumeName', description: 'A Docker named volume' });
export type VolumeName = z.infer<typeof VolumeName>;

/** The Deployed app or Operated stack a volume belongs to (SHP-REQ-201, SHP-REQ-202). */
export const VolumeOwner = z
  .strictObject({
    kind: z.enum(['app', 'stack']),
    name: AppName,
  })
  .meta({ id: 'VolumeOwner', description: 'The app or adopted stack that owns a volume' });
export type VolumeOwner = z.infer<typeof VolumeOwner>;

/**
 * Volume backups for an app or stack, in its manifest (SHP-REQ-201, SHP-REQ-206, SHP-ADR-012).
 * Optional on the app manifest and on both stack manifest variants; absent means no volume is
 * backed up on a schedule, though the console and `shipyard_volume_backup` can still take one.
 */
export const VolumeBackupSettings = z
  .strictObject({
    /** Volumes to back up; omitted means every named volume the app's or stack's containers mount. */
    volumes: z.array(VolumeName).min(1).max(50).optional(),
    /** Archives kept per volume; the agent removes the oldest beyond this after a backup (SHP-REQ-206). */
    retain: z.int().min(1).max(100).default(7),
    /** Stop the owner's containers for the archive so it is consistent, then start them again. */
    quiesce: z.boolean().default(false),
    /** Back the volumes up each night, on the agent's own schedule. */
    nightly: z.boolean().default(false),
    /**
     * Back the volumes up before an update or deploy. Only meaningful on a stack with
     * `updates: digest` and on an app deploy; ignored on a lifecycle-only stack, which Shipyard
     * never updates.
     */
    beforeUpdate: z.boolean().default(false),
  })
  .meta({ id: 'VolumeBackupSettings', description: 'Which volumes to back up, how many archives to keep, and when (SHP-ADR-012)' });
export type VolumeBackupSettings = z.infer<typeof VolumeBackupSettings>;

/** Hours a prune waits before touching something unused; null skips that kind (SHP-REQ-205). */
const PruneAgeHours = z.int().min(24).max(8760).nullable();

/** What a prune looks at in the image store; `null` hours leaves unused images alone. */
const PruneImagesJob = z.strictObject({
  dangling: z.boolean(),
  unusedOlderThanHours: PruneAgeHours,
});

/** What a prune looks at in the build cache; `null` hours leaves the cache alone. */
const PruneBuildCacheJob = z.strictObject({
  olderThanHours: PruneAgeHours,
});

/**
 * A job for the agent (SHP-ADR-012). A restore names an archive by ID and the agent finds it in
 * its own ledger (SHP-REQ-202, SHP-D-080). A real prune names the dry run it follows and removes
 * only what that dry run listed and is still eligible (SHP-REQ-205).
 */
export const MaintenanceJob = z
  .discriminatedUnion('kind', [
    z.strictObject({
      jobId: z.uuid(),
      kind: z.literal('volume-backup'),
      volume: VolumeName,
      owner: VolumeOwner,
      quiesce: z.boolean(),
    }),
    z.strictObject({
      jobId: z.uuid(),
      kind: z.literal('volume-restore'),
      volume: VolumeName,
      owner: VolumeOwner,
      archiveId: z.uuid(),
    }),
    z.strictObject({
      jobId: z.uuid(),
      kind: z.literal('volume-delete'),
      volume: VolumeName,
    }),
    z
      .strictObject({
        jobId: z.uuid(),
        kind: z.literal('prune'),
        dryRun: z.boolean(),
        /** The dry run a real prune follows; required when `dryRun` is false. */
        fromDryRunId: z.uuid().optional(),
        images: PruneImagesJob,
        buildCache: PruneBuildCacheJob,
      })
      .refine((v) => v.dryRun || v.fromDryRunId !== undefined, {
        message: 'a prune that is not a dry run needs fromDryRunId',
        path: ['fromDryRunId'],
      }),
  ])
  .meta({ id: 'MaintenanceJob', description: 'Back up, restore or delete a volume, or prune images and build cache' });
export type MaintenanceJob = z.infer<typeof MaintenanceJob>;

/**
 * One volume archive in the agent's own ledger (SHP-REQ-201). There is deliberately no path: the
 * server mirrors what the agent reports for display and for choosing a restore, and a restore
 * names `archiveId` so the agent resolves the file itself (SHP-D-080).
 */
export const VolumeArchive = z
  .strictObject({
    archiveId: z.uuid(),
    volume: VolumeName,
    /** The app or stack the volume belonged to when archived; null for an orphan. */
    owner: VolumeOwner.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    sizeBytes: z.int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, '64 lowercase hex characters'),
    /** Whether the owner's containers were stopped while the archive was taken. */
    quiesced: z.boolean(),
  })
  .meta({ id: 'VolumeArchive', description: 'A volume archive in the agent ledger; never carries a path' });
export type VolumeArchive = z.infer<typeof VolumeArchive>;

/** Something a prune would remove (SHP-REQ-205), listed by a dry run. */
export const PruneItem = z
  .strictObject({
    kind: z.enum(['image', 'build-cache']),
    /** An image ID (`sha256:...`) or a build cache record ID. */
    id: z.union([z.string().regex(/^sha256:[0-9a-f]{64}$/, 'an image ID'), z.string().regex(/^[a-z0-9]{1,64}$/, 'a cache record ID')]),
    /** A `repo:tag`, display only. */
    ref: z.string().max(500).nullable(),
    sizeBytes: z.int().min(0),
    createdAt: z.iso.datetime({ offset: true }).nullable(),
    reason: z.enum(['dangling', 'unused', 'old-cache']),
  })
  .meta({ id: 'PruneItem', description: 'An image or build cache record a prune would remove' });
export type PruneItem = z.infer<typeof PruneItem>;

export const MaintenanceStep = z
  .enum(['queued', 'stopping', 'archiving', 'restoring', 'starting', 'checking', 'deleting', 'listing', 'pruning', 'retaining'])
  .meta({ id: 'MaintenanceStep', description: 'Where a running maintenance job is' });
export type MaintenanceStep = z.infer<typeof MaintenanceStep>;

export const MaintenanceProgress = z
  .strictObject({
    jobId: z.uuid(),
    step: MaintenanceStep,
  })
  .meta({ id: 'MaintenanceProgress', description: 'A running maintenance job moved to a new step' });
export type MaintenanceProgress = z.infer<typeof MaintenanceProgress>;

/** What a prune found or removed; `reclaimedBytes` is null for a dry run. */
const PruneOutcome = z.strictObject({
  items: z.array(PruneItem).max(5000),
  reclaimableBytes: z.int().min(0),
  reclaimedBytes: z.int().min(0).nullable(),
});

export const MaintenanceResult = z
  .strictObject({
    jobId: z.uuid(),
    state: z.enum(['succeeded', 'failed', 'refused']),
    refusal: Refusal.optional(),
    /** The archive a backup took. */
    archive: VolumeArchive.optional(),
    /** Archives the retention limit removed after a backup (SHP-REQ-206). */
    removedArchives: z.array(z.uuid()).max(100).optional(),
    prune: PruneOutcome.optional(),
    /** The agent's own log of the job, redacted and capped at 64 KiB. */
    output: z.string().max(65536, 'output is truncated to 64KiB').optional(),
  })
  .meta({ id: 'MaintenanceResult', description: 'The terminal result of a maintenance job' });
export type MaintenanceResult = z.infer<typeof MaintenanceResult>;

export const MaintenanceState = z
  .enum(['queued', 'dispatched', 'running', 'succeeded', 'failed', 'refused', 'cancelled'])
  .meta({ id: 'MaintenanceState', description: 'Where a maintenance job is' });
export type MaintenanceState = z.infer<typeof MaintenanceState>;

export const MaintenanceStatus = z
  .strictObject({
    id: z.uuid(),
    kind: z.enum(['volume-backup', 'volume-restore', 'volume-delete', 'prune']),
    state: MaintenanceState,
    step: MaintenanceStep.nullable(),
    /** The volume a volume job names; null for a prune. */
    volume: VolumeName.nullable(),
    owner: VolumeOwner.nullable(),
    requester: z.strictObject({ kind: z.enum(['user', 'token', 'system']), label: z.string().max(200) }),
    createdAt: z.iso.datetime({ offset: true }),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    finishedAt: z.iso.datetime({ offset: true }).nullable(),
    archive: VolumeArchive.nullable(),
    removedArchives: z.array(z.uuid()),
    prune: PruneOutcome.nullable(),
    refusal: Refusal.nullable(),
    output: z.string().max(65536).nullable(),
  })
  .meta({ id: 'MaintenanceStatus', description: 'A volume or prune job and its outcome' });
export type MaintenanceStatus = z.infer<typeof MaintenanceStatus>;

export const MaintenancePage = z
  .strictObject({
    items: z.array(MaintenanceStatus),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'MaintenancePage', description: 'Maintenance jobs, newest first' });
export type MaintenancePage = z.infer<typeof MaintenancePage>;
