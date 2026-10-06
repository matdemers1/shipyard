import { BuildStage, refusal, type BuildJob, type DeployTargetState, type PollResponse } from '@shipyard/schema';
import type { Db } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { claimNextBuild, directAudit, recordBuildResult } from '../builds/service.js';
import { TERMINAL_STATES } from '../deploys/service.js';
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
 * deploy order) has succeeded. A rollout's members (SHP-REQ-151) are separate deploys tied by
 * `rollout_id`, and wait the same way on every member with a lower `rollout_position`. The
 * two-minute re-dispatch below applies only to a member that was already runnable, so it can never
 * hand a later member out early.
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
        -- A rollout member waits for every earlier member of its rollout to succeed (SHP-REQ-151).
        and (d."rollout_id" is null or not exists (
              select 1 from "deploy" pd
              join "deploy_target" pt on pt."deploy_id" = pd."id"
              where pd."rollout_id" = d."rollout_id"
                and pd."rollout_position" < d."rollout_position"
                and pt."state" <> 'succeeded'))
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

// ─── Builds (SHP-T-7.9) ──────────────────────────────────────────────────────

/**
 * A running build with no sign of life for this long is failed `interrupted` by the next poll, so
 * an agent that died mid-build cannot hold the one build slot (SHP-REQ-129) forever. "Sign of
 * life" is the latest of the build's dispatch/start, any stage starting or ending, any log chunk,
 * and `build.updated_at` — which every accepted `/build-progress` bumps, heartbeats included. A
 * building agent sends a heartbeat progress every 60 s (apps/agent/src/build.ts,
 * `BUILD_HEARTBEAT_MS`), even while it holds a stage back for a deploy, so thirty minutes of
 * silence means the agent is gone, not busy.
 */
export const BUILD_STALE_MINUTES = 30;

/** True while one of this agent's deploy targets is dispatched and not yet finished. */
export async function agentHasTargetInFlight(db: Db, agentId: string): Promise<boolean> {
  const row = await db.deployTarget.findFirst({
    where: { dispatchedAt: { not: null }, state: { notIn: [...TERMINAL_STATES] }, app: { agentId } },
    select: { id: true },
  });
  return row !== null;
}

/** Puts a claimed build back in the queue, for a poll that could not hand it over. */
export async function releaseBuild(deps: ServiceDeps, buildId: string): Promise<void> {
  const released = await deps.db.build.updateMany({
    where: { id: buildId, state: 'running' },
    data: { state: 'queued', dispatchedAt: null, startedAt: null },
  });
  if (released.count > 0) deps.bus.publish('work');
}

/**
 * The next build for `agentId`, claimed through the build service (strict FIFO, one running build
 * across the install — SHP-REQ-129, SHP-REQ-137), or null. The queue's head must be one of this
 * agent's apps: another agent's build is never handed out and stays queued. The service claims
 * without an owner filter, so a head that changed between the look and the claim is put back.
 */
export async function claimBuildFor(deps: ServiceDeps, agentId: string): Promise<BuildJob | null> {
  const { db } = deps;
  const [running, head] = await Promise.all([
    db.build.count({ where: { state: 'running' } }),
    db.build.findFirst({ where: { state: 'queued' }, orderBy: { queueSeq: 'asc' }, select: { app: { select: { agentId: true } } } }),
  ]);
  if (running > 0 || head?.app.agentId !== agentId) return null;
  const job = await claimNextBuild(deps);
  if (job === null) return null;
  const owner = await db.app.findUnique({ where: { name: job.app }, select: { agentId: true } });
  if (owner?.agentId !== agentId) {
    await releaseBuild(deps, job.buildId);
    return null;
  }
  return job;
}

const STALE_ACTOR = { type: 'system', label: 'shipyard: stale build sweep' } as const;

/**
 * Fails every running build that has shown no sign of life for `BUILD_STALE_MINUTES` with
 * `interrupted`, naming the stage it was in. Goes through `recordBuildResult` (guarded on
 * `running`, publishes `work` so the next queued build is dispatched, runs the build hooks), and
 * audits each as `build.interrupted`. One indexed query when nothing is stale. Returns the IDs.
 */
export async function sweepStaleBuilds(deps: ServiceDeps, now: Date = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - BUILD_STALE_MINUTES * 60_000);
  const stale = await deps.db.$queryRaw<{ id: string; app: string; stage: string | null }[]>`
    select b."id"::text as "id", a."name" as "app",
      (select s."stage"::text from "build_stage" s
        where s."build_id" = b."id" and s."state" = 'running'
        order by s."started_at" desc limit 1) as "stage"
    from "build" b
    join "app" a on a."id" = b."app_id"
    where b."state" = 'running'
      and greatest(
            b."updated_at",
            coalesce(b."dispatched_at", b."updated_at"),
            coalesce(b."started_at", b."updated_at"),
            coalesce((select max(greatest(s."started_at", coalesce(s."ended_at", s."started_at")))
                      from "build_stage" s where s."build_id" = b."id"), b."updated_at"),
            coalesce((select max(l."at") from "build_log" l where l."build_id" = b."id"), b."updated_at")
          ) < ${cutoff}`;
  const failed: string[] = [];
  for (const row of stale) {
    const stage = BuildStage.safeParse(row.stage);
    const why = refusal(
      'interrupted',
      `The agent stopped reporting on this build for over ${String(BUILD_STALE_MINUTES)} minutes${stage.success ? `, during ${stage.data}` : ''}.`,
      'Check the agent is running and can reach the server, then rebuild.',
    );
    const outcome = await recordBuildResult(deps, {
      buildId: row.id,
      state: 'failed',
      digests: {},
      refusal: why,
      ...(stage.success ? { failedStage: stage.data } : {}),
    });
    if (!outcome.accepted) continue;
    failed.push(row.id);
    await directAudit(deps.db, STALE_ACTOR)({
      action: 'build.interrupted',
      entityType: 'build',
      entityId: row.id,
      before: { state: 'running' },
      after: { state: 'failed', refusal: 'interrupted', app: row.app, ...(stage.success ? { failedStage: stage.data } : {}) },
    });
    deps.logger.warn({ buildId: row.id, app: row.app, stage: row.stage }, 'running build failed: the agent stopped reporting');
  }
  return failed;
}
