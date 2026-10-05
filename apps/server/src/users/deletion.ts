import type { ServiceDeps } from '../deps.js';

/**
 * Deleting your own account (SHP-T-11.3, SHP-ADR-004): **remove the user and revoke their tokens.**
 *
 * Asking disables the account at once — every sign-in path already refuses a disabled user — ends
 * every session it has, native and console, revokes every API token it made, and forgets its push
 * registrations. An admin re-enabling it inside the grace period cancels the whole thing.
 *
 * Once the grace period passes, the hourly purge removes what is the person: password, authenticator,
 * linked D3 Auth identities, sessions and the email address. The row stays, with its display name,
 * because deploys, approvals, freezes and the audit trail point at it — who approved a release is
 * a fact about the release, and it outlives the account that did it.
 */

/** At least the contract's day; a week, so a regret on Monday can still be helped by an admin. */
export const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const DELETION_PURGE_INTERVAL_MS = 60 * 60 * 1000;

export type DeletionRequest =
  | { readonly kind: 'scheduled'; readonly graceUntil: Date; readonly tokensRevoked: number }
  | { readonly kind: 'last_admin' }
  | { readonly kind: 'gone' };

export async function requestDeletion(db: ServiceDeps['db'], userId: string, now = new Date()): Promise<DeletionRequest> {
  return db.$transaction(async (tx) => {
    // The same lock as demoting or disabling an admin (src/users/index.ts): two admins deleting
    // themselves at once serialize, and the second finds itself the last.
    await tx.$queryRaw`SELECT id FROM "user" WHERE role = 'admin' AND disabled_at IS NULL FOR UPDATE`;
    const user = await tx.user.findFirst({ where: { id: userId, disabledAt: null, deletedAt: null } });
    if (user === null) return { kind: 'gone' } as const;
    if (user.role === 'admin') {
      const others = await tx.user.count({ where: { role: 'admin', disabledAt: null, deletedAt: null, id: { not: userId } } });
      if (others === 0) return { kind: 'last_admin' } as const;
    }
    const graceUntil = new Date(now.getTime() + DELETION_GRACE_MS);
    await tx.user.update({ where: { id: userId }, data: { disabledAt: now, deleteAfter: graceUntil } });
    // Push registrations go with their sessions (cascade), and the identity-owned ones explicitly.
    await tx.relayRegistration.deleteMany({ where: { userId } });
    await tx.session.deleteMany({ where: { userId } });
    const tokens = await tx.apiToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    return { kind: 'scheduled', graceUntil, tokensRevoked: tokens.count } as const;
  });
}

/** The address a purged account is left with, so the real one can be invited again. */
export const tombstoneEmail = (userId: string) => `deleted-${userId}@deleted.invalid`;

/**
 * Purges every account whose grace period has passed; `now` is the test clock. One transaction per
 * account, each with its own audit event, so one bad row cannot hold up the rest.
 */
export async function purgeDeletedAccounts(deps: Pick<ServiceDeps, 'db' | 'logger'>, now = new Date()): Promise<number> {
  const due = await deps.db.user.findMany({
    where: { deleteAfter: { lte: now }, deletedAt: null, disabledAt: { not: null } },
    select: { id: true },
  });
  for (const { id } of due) {
    await deps.db.$transaction(async (tx) => {
      await tx.relayRegistration.deleteMany({ where: { userId: id } });
      await tx.session.deleteMany({ where: { userId: id } });
      await tx.identity.deleteMany({ where: { userId: id } });
      await tx.user.update({
        where: { id },
        data: { email: tombstoneEmail(id), passwordHash: null, totpSecret: null, totpEnabledAt: null, deleteAfter: null, deletedAt: now },
      });
      await tx.auditEvent.create({
        data: {
          actorType: 'system',
          actorLabel: 'account deletion',
          action: 'user.purged',
          entityType: 'user',
          entityId: id,
          after: { deletedAt: now.toISOString() },
        },
      });
    });
  }
  if (due.length > 0) deps.logger.info({ count: due.length }, 'deleted accounts purged');
  return due.length;
}

/** Starts the hourly purge; the stopper waits for a run in flight. */
export function startDeletionPurge(
  deps: Pick<ServiceDeps, 'db' | 'logger'>,
  intervalMs = DELETION_PURGE_INTERVAL_MS,
): { stop: () => Promise<void> } {
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();
  const tick = (): void => {
    inFlight = purgeDeletedAccounts(deps).catch((err: unknown) => {
      deps.logger.error({ err }, 'account purge failed');
    });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
