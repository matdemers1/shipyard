import type { Request, Response, Router } from 'express';
import type { z } from 'zod';
import {
  ACTIVE_STATES,
  PollRequest,
  StepJournal,
  TargetProgress,
  TargetResult,
  refusal,
  type DeployTargetState,
  type PollResponse,
} from '@shipyard/schema';
import type { Prisma } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { TERMINAL_STATES } from '../deploys/service.js';
import { sendRefusal } from '../errors.js';
import { enqueueDeployment } from '../outbox/index.js';
import { PROGRESS_RANK, claimTarget, describeTarget, lastLines, releaseTarget } from './dispatch.js';
import { verifyAgentRequest } from './verify.js';

/**
 * The agent's work channel (SHP-T-2.4; SHP-REQ-040, SHP-REQ-033, SHP-D-041, SHP-D-081).
 *
 * - `POST /poll` — a long poll of at most 25 s. Every poll is a heartbeat. It answers as soon as a
 *   runnable target for one of this agent's apps is queued (`bus.publish('work')`).
 * - `POST /progress` — the running target's state and step, forward only.
 * - `POST /steps` — the agent's local journal lines, synced when the server is reachable.
 * - `POST /result` — the terminal result, exactly once.
 *
 * The server only records what the agent reports: the agent re-verifies every target itself and
 * alone decides a health-failure rollback (SHP-D-002, SHP-D-081).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SUCH_TARGET = refusal('not_found', 'No such target dispatched to this agent.', 'Poll for work and report only targets you were given.');
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
  app: { select: { name: true, agentId: true, services: true } },
  deploy: { select: { dryRun: true } },
} satisfies Prisma.DeployTargetSelect;

/** The target, if it exists, was dispatched, and belongs to an app this agent owns. */
async function ownTarget(deps: ServiceDeps, req: Request, targetId: string) {
  if (!UUID_RE.test(targetId) || req.agent?.id === undefined || req.agent.id === null) return null;
  const row = await deps.db.deployTarget.findUnique({ where: { id: targetId }, select: TARGET_SELECT });
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
        if (woken === null) break;
        await woken;
        stop.abort();
        if (gone.signal.aborted) return;
      }
      // A heartbeat is a mutation of the agent row (last_heartbeat_at), so it is audited like one.
      await req.audit({ action: 'agent.heartbeat', entityType: 'agent', entityId: agentId });
      const response: PollResponse = { target: null };
      res.json(response);
    } finally {
      res.off('close', onClose);
    }
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

    const recorded = await db.$transaction(async (tx) => {
      // Only once: the state guard makes a late or duplicate result a no-op, reported as 409.
      const updated = await tx.deployTarget.updateMany({
        where: { id: target.id, state: { notIn: [...TERMINAL_STATES] } },
        data: {
          state: body.state,
          result: {
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
      if (!dryRun && body.images.length > 0) {
        await tx.targetImage.createMany({
          data: body.images.map((image) => ({
            targetId: target.id,
            service: image.service,
            repo: repoOf(target.app.services, image.service),
            sha: image.sha,
            digest: image.digest,
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
      },
    });
    logger.info({ deployId: target.deployId, targetId: target.id, state: body.state }, 'target result recorded');
    bus.publish(`deploy:${target.deployId}`);
    bus.publish(`app:${target.app.name}`);
    res.json({ state: body.state, outbox });
  });
}
