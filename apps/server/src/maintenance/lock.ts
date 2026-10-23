import { refusal, type Refusal, type VolumeOwner } from '@shipyard/schema';
import type { Prisma } from '../db.js';

/** The client or a transaction: the guard runs inside the caller's insert transaction. */
type DbClient = Prisma.TransactionClient;

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
export async function restoreLockRefusal(db: DbClient, owner: VolumeOwner): Promise<Refusal | null> {
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

/** The advisory-lock key that serialises taking `owner`'s lock between a restore and a deploy. */
export function ownerLockKey(owner: VolumeOwner): string {
  return `shipyard:owner:${owner.kind}:${owner.name}`;
}

/**
 * Takes the transaction-scoped advisory lock on each owner, in a fixed order so two callers never
 * deadlock. Held until the caller's transaction ends.
 *
 * Why (SHP-T-17.3): a deploy holds an app through the one-active-target unique index, a restore
 * through its `maintenance_job` row — two tables, so no index can refuse the second. A
 * check-then-insert on each side would let a deploy and a restore that race both pass their checks
 * and both insert. Both sides insert under this lock instead (the deploy paths through
 * `assertNoRestore`, the restore through `queueJob`), and check again after taking it, so one of
 * the two always sees the other. `claimTarget` and `claimMaintenance` also refuse to hand out a
 * deploy target and a restore of the same app together — belt and braces for rows written before
 * this lock existed.
 */
export async function lockOwners(tx: DbClient, owners: readonly VolumeOwner[]): Promise<void> {
  const keys = [...new Set(owners.map(ownerLockKey))].sort();
  for (const key of keys) {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${key}))`;
  }
}

/** Thrown inside an insert transaction to roll it back with the restore's `locked` refusal. */
export class RestoreLockedError extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
    this.name = 'RestoreLockedError';
  }
}

/**
 * Inside the transaction that is about to take these apps' deploy lock: takes their owner locks,
 * then throws `RestoreLockedError` when a restore of any of them is queued, dispatched or running
 * (SHP-REQ-202). Every path that puts a deploy target into `locked` calls it.
 */
export async function assertNoRestore(tx: DbClient, appNames: readonly string[]): Promise<void> {
  const owners = appNames.map((name) => ({ kind: 'app' as const, name }));
  await lockOwners(tx, owners);
  for (const owner of owners) {
    const held = await restoreLockRefusal(tx, owner);
    if (held !== null) throw new RestoreLockedError(held);
  }
}
