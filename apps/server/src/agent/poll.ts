import type { Request, Response, Router } from 'express';
import type { z } from 'zod';
import {
  ACTIVE_STATES,
  BuildProgress,
  BuildResult,
  PollRequest,
  StepJournal,
  TargetProgress,
  TargetResult,
  refusal,
  type BuildJob,
  type DeployTargetState,
  type PollResponse,
} from '@shipyard/schema';
import type { Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { TERMINAL_STATES } from '../deploys/service.js';
import { sendRefusal } from '../errors.js';
import { enqueueDeployment } from '../outbox/index.js';
import { readGroupMeta, stopGroupAfter } from '../groups/service.js';
import { recordBuildProgress, recordBuildResult } from '../builds/service.js';
import {
  PROGRESS_RANK,
  agentHasTargetInFlight,
  claimBuildFor,
  claimTarget,
  describeTarget,
  lastLines,
  releaseBuild,
  releaseTarget,
  sweepStaleBuilds,
} from './dispatch.js';
import { verifyAgentRequest } from './verify.js';

/**
 * The agent's work channel (SHP-T-2.4; SHP-REQ-040, SHP-REQ-033, SHP-D-041, SHP-D-081).
 *
 * - `POST /poll` — a long poll of at most 25 s. Every poll is a heartbeat. It answers as soon as a
 *   runnable target for one of this agent's apps is queued (`bus.publish('work')`).
 * - `POST /progress` — the running target's state and step, forward only.
 * - `POST /steps` — the agent's local journal lines, synced when the server is reachable.
 * - `POST /result` — the terminal result, exactly once.
 * - Builds (SHP-T-7.9): a poll that advertises `capabilities: ['build']` is handed the next queued
 *   build — only when no deploy target was claimed, none of this agent's targets is in flight, no
 *   build is running anywhere, and the queue's head is one of this agent's apps
 *   (SHP-REQ-129, SHP-REQ-130). `POST /build-progress` records a stage (or a heartbeat) and answers
 *   `{ cancel }`; `POST /build-result` records the end once. Every poll first fails any running
 *   build silent for `BUILD_STALE_MINUTES` with `interrupted`.
 *
 * The server only records what the agent reports: the agent re-verifies every target itself and
 * alone decides a health-failure rollback (SHP-D-002, SHP-D-081).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SUCH_TARGET = refusal('not_found', 'No such target dispatched to this agent.', 'Poll for work and report only targets you were given.');
const NO_SUCH_BUILD = refusal('not_found', 'No such build dispatched to this agent.', 'Poll for work and report only builds you were given.');
const ACTIVE: readonly DeployTargetState[] = ACTIVE_STATES;

function parse<T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | null {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendRefusal(
      res,
      refusal(
        'invalid_request',
        'The agent request failed validation.',
        parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
      ),
    );
    return null;
  }
  return parsed.data;
}

const TARGET_SELECT = {
  id: true,
  deployId: true,
  appId: true,
  state: true,
  startedAt: true,
  dispatchedAt: true,
  result: true,
  app: { select: { name: true, agentId: true, services: true } },
  deploy: { select: { dryRun: true, groupName: true } },
} satisfies Prisma.DeployTargetSelect;

/** The target, if it exists, was dispatched, and belongs to an app this agent owns. */
async function ownTarget(deps: ServiceDeps, req: Request, targetId: string) {
  if (!UUID_RE.test(targetId) || req.agent?.id === undefined || req.agent.id === null) return null;
  const row = await deps.db.deployTarget.findUnique({ where: { id: targetId }, select: TARGET_SELECT });
  if (row === null || row.dispatchedAt === null || row.app.agentId !== req.agent.id) return null;
  return row;
}

/** The build, if it exists, was dispatched, and belongs to an app this agent owns. */
async function ownBuild(deps: ServiceDeps, req: Request, buildId: string, stage?: BuildProgress['stage']) {
  if (!UUID_RE.test(buildId) || req.agent?.id === undefined || req.agent.id === null) return null;
  const row = await deps.db.build.findUnique({
    where: { id: buildId },
    select: {
      id: true,
      state: true,
      dispatchedAt: true,
      cancelRequestedAt: true,
      app: { select: { name: true, agentId: true } },
      stages: { where: { stage: stage ?? 'fetch' }, select: { state: true } },
    },
  });
  if (row === null || row.dispatchedAt === null || row.app.agentId !== req.agent.id) return null;
  return row;
}

/** service → image repository, from the manifest mirror the agent reported. */
function repoOf(services: Prisma.JsonValue | null, service: string): string {
  if (typeof services !== 'object' || services === null || Array.isArray(services)) return '';
  const entry = (services as Record<string, unknown>)[service];
  if (typeof entry !== 'object' || entry === null) return '';
  const image = (entry as { image?: unknown }).image;
  return typeof image === 'string' ? image : '';
}

export function mountPoll(router: Router, deps: ServiceDeps): void {
  const { db, bus, logger } = deps;
  const verified = verifyAgentRequest(deps);

  router.post('/poll', verified, async (req, res) => {
    const body = parse(PollRequest, req, res);
    const agentId = req.agent?.id;
    if (body === null || agentId === undefined || agentId === null) return;

    await db.agent.update({ where: { id: agentId }, data: { lastHeartbeatAt: new Date() } });
    // A build whose agent went silent must not hold the one build slot forever (SHP-REQ-129).
    try {
      await sweepStaleBuilds(deps);
    } catch (err) {
      logger.error({ err }, 'stale build sweep failed');
    }
    const wantsBuild = body.capabilities?.includes('build') === true;

    const gone = new AbortController();
    const onClose = (): void => {
      gone.abort();
    };
    res.on('close', onClose);
    const deadline = Date.now() + body.waitSeconds * 1000;
    try {
      for (;;) {
        // Arm the wait before looking, so a publish between the look and the wait is not lost.
        const stop = new AbortController();
        const remaining = deadline - Date.now();
        const woken = remaining > 0 ? bus.wait('work', remaining, AbortSignal.any([gone.signal, stop.signal])) : null;
        let claimed: string | null;
        try {
          claimed = await claimTarget(db, agentId);
        } catch (err) {
          stop.abort();
          throw err;
        }
        if (claimed !== null) {
          stop.abort();
          if (gone.signal.aborted) {
            // The agent hung up (a shutdown); hand the target to the next poll instead of losing it.
            await releaseTarget(db, claimed);
            bus.publish('work');
            return;
          }
          const target = await describeTarget(db, claimed);
          await req.audit({
            action: 'deploy.dispatched',
            entityType: 'deploy',
            entityId: target.deployId,
            after: { targetId: target.targetId, app: target.app, kind: target.kind, dryRun: target.dryRun },
          });
          logger.info({ deployId: target.deployId, targetId: target.targetId, app: target.app }, 'target dispatched to agent');
          const response: PollResponse = { target };
          res.json(response);
          return;
        }
        // Deploys first. A build only when this agent can take one and nothing of its is deploying:
        // no build stage may start while a deploy is in flight on the host (SHP-REQ-130).
        let job: BuildJob | null = null;
        if (wantsBuild) {
          try {
            job = (await agentHasTargetInFlight(db, agentId)) ? null : await claimBuildFor(deps, agentId);
          } catch (err) {
            stop.abort();
            throw err;
          }
        }
        if (job !== null) {
          stop.abort();
          if (gone.signal.aborted) {
            await releaseBuild(deps, job.buildId);
            return;
          }
          await req.audit({
            action: 'build.dispatched',
            entityType: 'build',
            entityId: job.buildId,
            after: { app: job.app, sha: job.sha },
          });
          logger.info({ buildId: job.buildId, app: job.app, sha: job.sha }, 'build dispatched to agent');
          const response: PollResponse = { target: null, build: job };
          res.json(response);
          return;
        }
        if (woken === null) break;
        await woken;
        stop.abort();
        if (gone.signal.aborted) return;
      }
      // An empty poll only bumps last_heartbeat_at, every 25 s, forever: bookkeeping, not an event
      // worth an audit row. Work handed out, progress and results are audited.
      req.noAuditNeeded('heartbeat');
      const response: PollResponse = { target: null };
      res.json(response);
    } finally {
      res.off('close', onClose);
    }
  });

  router.post('/build-progress', verified, async (req, res) => {
    const body = parse(BuildProgress, req, res);
    if (body === null) return;
    const build = await ownBuild(deps, req, body.buildId, body.stage);
    if (build === null) {
      sendRefusal(res, NO_SUCH_BUILD);
      return;
    }
    const touch = async (): Promise<void> => {
      // The stale sweep reads this: an accepted report is a sign of life.
      await db.build.updateMany({ where: { id: build.id, state: 'running' }, data: { updatedAt: new Date() } });
    };
    // A heartbeat: `running` for a stage the server already has, with no log. It only says "still
    // here" — the stage is not reopened, nothing is recorded but the time.
    const heartbeat = body.state === 'running' && (body.log === undefined || body.log === '') && build.stages.length > 0;
    if (heartbeat) {
      if (build.state === 'running') await touch();
      req.noAuditNeeded('build heartbeat');
      res.json({ cancel: build.state !== 'running' || build.cancelRequestedAt !== null });
      return;
    }
    const outcome = await recordBuildProgress(deps, body);
    if (outcome.accepted) {
      await touch();
      await req.audit({
        action: 'build.progress',
        entityType: 'build',
        entityId: build.id,
        after: { app: build.app.name, stage: body.stage, state: body.state },
      });
    } else {
      req.noAuditNeeded('progress for a build that has ended');
    }
    res.json({ cancel: outcome.cancel });
  });

  router.post('/build-result', verified, async (req, res) => {
    const body = parse(BuildResult, req, res);
    if (body === null) return;
    const build = await ownBuild(deps, req, body.buildId);
    if (build === null) {
      sendRefusal(res, NO_SUCH_BUILD);
      return;
    }
    const outcome = await recordBuildResult(deps, body);
    if (outcome.accepted) {
      await req.audit({
        action: 'build.result',
        entityType: 'build',
        entityId: build.id,
        before: { state: build.state },
        after: {
          app: build.app.name,
          state: body.state,
          digests: body.digests,
          ...(body.refusal === undefined ? {} : { refusal: body.refusal.code }),
          ...(body.failedStage === undefined ? {} : { failedStage: body.failedStage }),
        },
      });
      logger.info({ buildId: build.id, app: build.app.name, state: body.state }, 'build result recorded');
    } else {
      req.noAuditNeeded('a result for a build that has already ended');
    }
    res.json({ accepted: outcome.accepted, state: outcome.state });
  });

  router.post('/progress', verified, async (req, res) => {
    const body = parse(TargetProgress, req, res);
    if (body === null) return;
    const target = await ownTarget(deps, req, body.targetId);
    if (target === null) {
      sendRefusal(res, NO_SUCH_TARGET);
      return;
    }
    if (TERMINAL_STATES.includes(target.state)) {
      sendRefusal(res, refusal('conflict', 'This target has already finished.', 'Report progress only for a running target.'));
      return;
    }

    // A dry run never locks (SHP-REQ-050): its state stays `queued`, off the one-active-per-app
    // index, and only its step moves. A real deploy moves forward through the active states; a
    // regression or a terminal state is ignored here (the result sets the terminal state).
    const fromRank = PROGRESS_RANK[target.state] ?? -1;
    const toRank = PROGRESS_RANK[body.state] ?? -1;
    const advance = !target.deploy.dryRun && ACTIVE.includes(body.state) && toRank > fromRank;
    const step = body.step ?? body.state;
    await db.deployTarget.update({
      where: { id: target.id },
      data: {
        ...(advance ? { state: body.state } : {}),
        currentStep: step,
        ...(target.startedAt === null ? { startedAt: new Date() } : {}),
      },
    });
    await req.audit({
      action: 'deploy.progress',
      entityType: 'deploy',
      entityId: target.deployId,
      before: { state: target.state },
      after: { targetId: target.id, state: advance ? body.state : target.state, step },
    });
    bus.publish(`deploy:${target.deployId}`);
    res.json({ state: advance ? body.state : target.state, currentStep: step });
  });

  router.post('/steps', verified, async (req, res) => {
    const body = parse(StepJournal, req, res);
    if (body === null) return;
    const target = await ownTarget(deps, req, body.targetId);
    if (target === null) {
      sendRefusal(res, NO_SUCH_TARGET);
      return;
    }
    const output = body.output === undefined ? undefined : lastLines(body.output);
    let stepId: string;
    if (body.phase === 'start') {
      const row = await db.step.create({ data: { targetId: target.id, name: body.name, argv: body.argv }, select: { id: true } });
      stepId = row.id;
    } else {
      const open = await db.step.findFirst({
        where: { targetId: target.id, name: body.name, endedAt: null },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });
      const data = {
        argv: body.argv,
        endedAt: new Date(),
        ...(body.exitCode === undefined ? {} : { exitCode: body.exitCode }),
        ...(output === undefined ? {} : { output }),
      };
      const row =
        open === null
          ? await db.step.create({ data: { targetId: target.id, name: body.name, ...data }, select: { id: true } })
          : await db.step.update({ where: { id: open.id }, data, select: { id: true } });
      stepId = row.id;
    }
    await req.audit({
      action: 'deploy.step',
      entityType: 'deploy',
      entityId: target.deployId,
      after: {
        targetId: target.id,
        stepId,
        name: body.name,
        phase: body.phase,
        ...(body.exitCode === undefined ? {} : { exitCode: body.exitCode }),
      },
    });
    bus.publish(`deploy:${target.deployId}`);
    res.json({ stepId });
  });

  router.post('/result', verified, async (req, res) => {
    const body = parse(TargetResult, req, res);
    if (body === null) return;
    const target = await ownTarget(deps, req, body.targetId);
    if (target === null) {
      sendRefusal(res, NO_SUCH_TARGET);
      return;
    }
    const dryRun = target.deploy.dryRun;
    // A group member keeps its place in the group (deploy order, canary) alongside its result.
    const groupMeta = target.deploy.groupName === null ? null : readGroupMeta(target.result);
    let groupStopped: string[] = [];

    const recorded = await db.$transaction(async (tx) => {
      // Only once: the state guard makes a late or duplicate result a no-op, reported as 409.
      const updated = await tx.deployTarget.updateMany({
        where: { id: target.id, state: { notIn: [...TERMINAL_STATES] } },
        data: {
          state: body.state,
          result: {
            ...(groupMeta === null ? {} : { group: { ...groupMeta } }),
            gates: body.gates ?? [],
            // A dry run's resolved images belong on its sheet, not in target_image: that table is
            // the app's recorded release, which drift and rollbacks read.
            ...(dryRun ? { images: body.images } : {}),
          },
          ...(body.refusal === undefined ? {} : { refusal: body.refusal }),
          ...(body.schemaRevision === undefined ? {} : { schemaRevision: body.schemaRevision }),
          endedAt: new Date(),
          ...(target.startedAt === null ? { startedAt: new Date() } : {}),
        },
      });
      if (updated.count === 0) return false;
      // Stop at the first failure (SHP-REQ-078): every later member is cancelled in this same
      // transaction, so no poll can ever hand one out.
      if (target.deploy.groupName !== null && !dryRun && body.state !== 'succeeded') {
        groupStopped = await stopGroupAfter(tx, { deployId: target.deployId, targetId: target.id, app: target.app.name, state: body.state });
      }
      if (!dryRun && body.images.length > 0) {
        await tx.targetImage.createMany({
          data: body.images.map((image) => ({
            targetId: target.id,
            service: image.service,
            repo: repoOf(target.app.services, image.service),
            sha: image.sha,
            digest: image.digest,
            // Read from the verified digest (SHP-D-057); rollback targets read it (SHP-REQ-052).
            migrationLabel: image.migration ?? null,
          })),
        });
      }
      if (body.backupArtifact !== undefined) {
        await tx.backupArtifact.create({
          data: {
            appId: target.appId,
            targetId: target.id,
            path: body.backupArtifact.path,
            size: BigInt(body.backupArtifact.size),
            createdAt: new Date(body.backupArtifact.createdAt),
          },
        });
      }
      return true;
    });

    if (!recorded) {
      sendRefusal(res, refusal('conflict', 'This target already has a result.', 'Send a result once per target.'));
      return;
    }

    let outbox = 0;
    if (body.state === 'succeeded' && !dryRun) {
      // Foreman being down never fails a deploy: this only writes rows (SHP-D-033).
      try {
        outbox = await enqueueDeployment(db, target.id);
      } catch (err) {
        logger.error({ err, targetId: target.id }, 'could not enqueue the Foreman deployment record');
      }
    }

    await req.audit({
      action: 'deploy.result',
      entityType: 'deploy',
      entityId: target.deployId,
      before: { state: target.state },
      after: {
        targetId: target.id,
        app: target.app.name,
        state: body.state,
        dryRun,
        images: body.images,
        ...(body.refusal === undefined ? {} : { refusal: body.refusal.code }),
        ...(body.schemaRevision === undefined ? {} : { schemaRevision: body.schemaRevision }),
        ...(body.backupArtifact === undefined ? {} : { backupArtifact: body.backupArtifact.path }),
        ...(target.deploy.groupName === null ? {} : { group: target.deploy.groupName }),
        ...(groupStopped.length === 0 ? {} : { groupStopped }),
      },
    });
    logger.info({ deployId: target.deployId, targetId: target.id, state: body.state }, 'target result recorded');
    bus.publish(`deploy:${target.deployId}`);
    bus.publish(`app:${target.app.name}`);
    for (const name of groupStopped) bus.publish(`app:${name}`);
    // A group member that succeeded makes the next one runnable.
    if (target.deploy.groupName !== null && body.state === 'succeeded') bus.publish('work');
    res.json({ state: body.state, outbox });
  });
}
