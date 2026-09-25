import type { DeployTargetState, PollResponse } from '@shipyard/schema';
import type { Db } from '../db.js';
import { expectedDigestsFor } from '../groups/service.js';

/**
 * Work dispatch for the agent's long poll (SHP-REQ-040, SHP-D-041). A target is runnable when
 * nobody has taken it yet (`dispatched_at IS NULL`) and it is either a real deploy holding its
 * app's lock (`locked`) or a dry run (`queued` on a `dry_run` deploy — a dry run never locks,
 * SHP-REQ-050). Claiming is one statement: `FOR UPDATE SKIP LOCKED` means two concurrent polls
 * can never take the same target, and neither waits on the other.
 *
 * A group deploy's members (SHP-REQ-078) all sit in `locked` from the start, holding their apps;
 * one is runnable only once every earlier member of the same deploy (by `created_at`, which is
 * deploy order) has succeeded. The two-minute re-dispatch below applies only to a member that was
 * already runnable, so it can never hand a later member out early.
 */

export type PollTarget = NonNullable<PollResponse['target']>;

/** Ranks the active states in the order the engine moves through them; progress never goes back. */
export const PROGRESS_RANK: Partial<Record<DeployTargetState, number>> = {
  queued: 0,
  awaiting_approval: 0,
  locked: 1,
  verifying: 2,
  backing_up: 3,
  migrating: 4,
  pulling: 5,
  swapping: 6,
  checking: 7,
  soaking: 8,
  rolling_back: 9,
};

/** Claims the oldest runnable target for apps owned by `agentId`, or returns null. */
export async function claimTarget(db: Db, agentId: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    update "deploy_target" set "dispatched_at" = now(), "updated_at" = now()
    where "id" = (
      select t."id" from "deploy_target" t
      join "app" a on a."id" = t."app_id"
      join "deploy" d on d."id" = t."deploy_id"
      where a."agent_id" = ${agentId}::uuid
        -- Never dispatched, or dispatched two minutes ago and never started: the poll response
        -- was lost (a proxy drop, an agent restart), and the agent reports its first state within
        -- seconds of starting. Without this, a lost response would hold the app's lock forever.
        and (t."dispatched_at" is null
             or (t."started_at" is null and t."dispatched_at" < now() - interval '2 minutes'))
        and (t."state" = 'locked' or (t."state" = 'queued' and d."dry_run"))
        -- A group member waits for every earlier member of its deploy to succeed.
        and (d."group_name" is null or not exists (
              select 1 from "deploy_target" p
              where p."deploy_id" = t."deploy_id"
                and p."id" <> t."id"
                and (p."created_at", p."id") < (t."created_at", t."id")
                and p."state" <> 'succeeded'))
      order by t."created_at", t."id"
      for update of t skip locked
      limit 1
    )
    returning "id"::text as "id"`;
  return rows[0]?.id ?? null;
}

/** Puts a claimed target back, for a poll whose client went away before it could be answered. */
export async function releaseTarget(db: Db, targetId: string): Promise<void> {
  await db.deployTarget.updateMany({ where: { id: targetId, startedAt: null }, data: { dispatchedAt: null } });
}

/** The poll's view of a claimed target. */
export async function describeTarget(db: Db, targetId: string): Promise<PollTarget> {
  const row = await db.deployTarget.findUniqueOrThrow({
    where: { id: targetId },
    select: {
      id: true,
      deployId: true,
      rollbackToDeployId: true,
      app: { select: { name: true } },
      deploy: { select: { kind: true, requestedSha: true, dryRun: true, requesterLabel: true } },
    },
  });
  // A group promotion carries the digests its canary soaked (SHP-REQ-079).
  const expectDigests = await expectedDigestsFor(db, targetId);
  return {
    targetId: row.id,
    deployId: row.deployId,
    kind: row.deploy.kind,
    app: row.app.name,
    sha: row.deploy.requestedSha,
    dryRun: row.deploy.dryRun,
    ...(row.rollbackToDeployId === null ? {} : { toDeployId: row.rollbackToDeployId }),
    ...(expectDigests === undefined ? {} : { expectDigests }),
    requesterLabel: row.deploy.requesterLabel.slice(0, 200),
  };
}

/** The last `n` lines of `text`. */
export function lastLines(text: string, n = 50): string {
  const lines = text.split('\n');
  return lines.length <= n ? text : lines.slice(lines.length - n).join('\n');
}
