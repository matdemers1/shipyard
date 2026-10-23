import { refusal, type Refusal, type VolumeOwner } from '@shipyard/schema';
import type { Db } from '../db.js';

/**
 * The lock a volume restore takes on its owner (SHP-T-17.3; SHP-ADR-012, SHP-REQ-202).
 *
 * A restore stops the owning app or stack, replaces a volume's contents and starts it again: nothing
 * else may move that owner meanwhile. From the moment it is queued until it ends, a deploy of the
 * app, an update or rollback of the stack and a lifecycle action on either are refused `locked`,
 * naming the restore and who asked — and a restore is refused while one of those is in progress
 * (`requestVolumeRestore`), so the lock runs both ways, as SHP-T-16.3's does between stack updates
 * and actions.
 *
 * Its own module, importing nothing of the services, so `deploys`, `actions` and `stack-updates` can
 * read it without an import cycle through `maintenance/service.ts`.
 */

/** The states of a restore that hold its owner. */
export const RESTORE_HOLDING_STATES = ['queued', 'dispatched', 'running'] as const;

/** `locked` while a restore of one of `owner`'s volumes is queued, dispatched or running. */
export async function restoreLockRefusal(db: Db, owner: VolumeOwner): Promise<Refusal | null> {
  const holder = await db.maintenanceJob.findFirst({
    where: { kind: 'volume-restore', ownerKind: owner.kind, ownerName: owner.name, state: { in: [...RESTORE_HOLDING_STATES] } },
    select: { id: true, volume: true, state: true, step: true, requesterLabel: true },
    orderBy: { createdAt: 'asc' },
  });
  if (holder === null) return null;
  return refusal(
    'locked',
    `${owner.name} is having volume ${holder.volume ?? '(unknown)'} restored by ${holder.requesterLabel}: ${holder.step ?? holder.state} (maintenance job ${holder.id}).`,
    `Wait for maintenance job ${holder.id} to finish, then request again.`,
  );
}
