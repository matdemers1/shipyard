import type { Request, Response, Router } from 'express';
import type { z } from 'zod';
import { ActionProgress, ActionResult, LogsChunk, MaintenanceProgress, MaintenanceResult, StackUpdateProgress, StackUpdateResult, refusal, type LogsChunkAck } from '@shipyard/schema';
import { ownAction, recordActionProgress, recordActionResult } from '../actions/service.js';
import { ownStackUpdate, recordStackUpdateProgress, recordStackUpdateResult } from '../stack-updates/service.js';
import { ownMaintenance, recordMaintenanceProgress, recordMaintenanceResult } from '../maintenance/service.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { logsHubFor } from '../logs/hub.js';
import { verifyAgentRequest } from './verify.js';

/**
 * The agent's side of lifecycle actions and log reads (SHP-T-15.4; SHP-ADR-010, SHP-ADR-011),
 * signed like every agent route:
 *
 * - `POST /actions/:id/progress` — the action has started on the host (`dispatched → running`).
 * - `POST /actions/:id/result` — its terminal result, exactly once; only for an action dispatched
 *   to this agent. Compose's output arrives redacted and capped by the agent.
 * - `POST /logs/:id/chunks` — one ordered batch of redacted lines. Relayed to the viewer and
 *   dropped (SHP-REQ-191): the answer `{ continue: false }` tells the agent to stop because the
 *   viewer left, the session ended, or the 2 MB relay cap was reached. Its body may be up to 2 MB
 *   (app.ts); nothing of it is logged — only the session ID, the sequence number and a line count.
 * - `POST /stack-updates/:id/progress` and `/result` (SHP-T-16.3, SHP-ADR-010) — a stack update's
 *   step, then its terminal result exactly once with the images before and after (SHP-REQ-200);
 *   only for an update dispatched to this agent.
 * - `POST /maintenance/:id/progress` and `/result` (SHP-T-17.3, SHP-ADR-012) — a volume backup,
 *   restore or delete, or a prune: its step, then its terminal result exactly once; only from the
 *   agent it was dispatched to and only while it is dispatched or running. A backup's archive is
 *   mirrored at once; the output never says more than the agent's redacted, capped log.
 */

const NO_SUCH_ACTION = refusal('not_found', 'No such action dispatched to this agent.', 'Poll for work and report only actions you were given.');
const NO_SUCH_STACK_UPDATE = refusal('not_found', 'No such stack update dispatched to this agent.', 'Poll for work and report only stack updates you were given.');
const NO_SUCH_MAINTENANCE = refusal('not_found', 'No such maintenance job dispatched to this agent.', 'Poll for work and report only maintenance jobs you were given.');
const NO_SUCH_LOGS = refusal('not_found', 'No such log read dispatched to this agent.', 'Poll for work and stream only log reads you were given.');

function parse<T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | null {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    // Only the issue paths and messages: a log chunk's text never goes back out, nor into a log.
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

function paramId(req: Request): string {
  const raw: unknown = req.params['id'];
  return typeof raw === 'string' ? raw : '';
}

export function mountWork(router: Router, deps: ServiceDeps): void {
  const { db, logger } = deps;
  const verified = verifyAgentRequest(deps);
  const hub = logsHubFor(deps.bus);

  router.post('/actions/:id/progress', verified, async (req, res) => {
    const body = parse(ActionProgress, req, res);
    const agentId = req.agent?.id;
    if (body === null || agentId === undefined || agentId === null) return;
    const row = body.actionId === paramId(req) ? await ownAction(db, agentId, body.actionId) : null;
    if (row === null) {
      sendRefusal(res, NO_SUCH_ACTION);
      return;
    }
    const outcome = await recordActionProgress(deps, row, body);
    if (!outcome.accepted) {
      sendRefusal(res, refusal('conflict', 'This action has already ended.', 'Report progress only for a running action.'));
      return;
    }
    await req.audit({
      action: 'action.progress',
      entityType: 'action',
      entityId: row.id,
      before: { state: row.state },
      after: { state: outcome.status.state, target: outcome.status.target, verb: row.verb },
    });
    res.json(outcome.status);
  });

  router.post('/actions/:id/result', verified, async (req, res) => {
    const body = parse(ActionResult, req, res);
    const agentId = req.agent?.id;
    if (body === null || agentId === undefined || agentId === null) return;
    const row = body.actionId === paramId(req) ? await ownAction(db, agentId, body.actionId) : null;
    if (row === null) {
      sendRefusal(res, NO_SUCH_ACTION);
      return;
    }
    const outcome = await recordActionResult(deps, row, body);
    if (!outcome.accepted) {
      sendRefusal(res, refusal('conflict', 'This action already has a result.', 'Send a result once per action.'));
      return;
    }
    await req.audit({
      action: 'action.result',
      entityType: 'action',
      entityId: row.id,
      before: { state: row.state },
      after: {
        state: body.state,
        target: outcome.status.target,
        verb: row.verb,
        service: row.service,
        ...(outcome.status.refusal === null ? {} : { refusal: outcome.status.refusal.code }),
      },
    });
    logger.info({ actionId: row.id, state: body.state }, 'lifecycle action result recorded');
    res.json(outcome.status);
  });

  router.post('/stack-updates/:id/progress', verified, async (req, res) => {
    const body = parse(StackUpdateProgress, req, res);
    const agentId = req.agent?.id;
    if (body === null || agentId === undefined || agentId === null) return;
    const row = body.updateId === paramId(req) ? await ownStackUpdate(db, agentId, body.updateId) : null;
    if (row === null) {
      sendRefusal(res, NO_SUCH_STACK_UPDATE);
      return;
    }
    const outcome = await recordStackUpdateProgress(deps, row, body);
    if (!outcome.accepted) {
      sendRefusal(res, refusal('conflict', 'This stack update has already ended.', 'Report progress only for a running stack update.'));
      return;
    }
    await req.audit({
      action: 'stack_update.progress',
      entityType: 'stack_update',
      entityId: row.id,
      before: { state: row.state, step: row.step },
      after: { state: outcome.status.state, step: body.step, stack: row.stackName, kind: row.kind },
    });
    res.json(outcome.status);
  });

  router.post('/stack-updates/:id/result', verified, async (req, res) => {
    const body = parse(StackUpdateResult, req, res);
    const agentId = req.agent?.id;
    if (body === null || agentId === undefined || agentId === null) return;
    const row = body.updateId === paramId(req) ? await ownStackUpdate(db, agentId, body.updateId) : null;
    if (row === null) {
      sendRefusal(res, NO_SUCH_STACK_UPDATE);
      return;
    }
    const outcome = await recordStackUpdateResult(deps, row, body);
    if (!outcome.accepted) {
      sendRefusal(res, refusal('conflict', 'This stack update already has a result.', 'Send a result once per stack update.'));
      return;
    }
    // SHP-REQ-200: the digests before and after, and the outcome, on the audit trail too.
    await req.audit({
      action: 'stack_update.result',
      entityType: 'stack_update',
      entityId: row.id,
      before: { state: row.state },
      after: {
        state: body.state,
        stack: row.stackName,
        kind: row.kind,
        images: body.images,
        previous: body.previous,
        ...(outcome.status.refusal === null ? {} : { refusal: outcome.status.refusal.code }),
        ...(body.backupArtifact === undefined ? {} : { backupArtifact: body.backupArtifact.path }),
      },
    });
    logger.info({ stackUpdateId: row.id, stack: row.stackName, state: body.state }, 'stack update result recorded');
    res.json(outcome.status);
  });

  router.post('/maintenance/:id/progress', verified, async (req, res) => {
    const body = parse(MaintenanceProgress, req, res);
    const agentId = req.agent?.id;
    if (body === null || agentId === undefined || agentId === null) return;
    const row = body.jobId === paramId(req) ? await ownMaintenance(db, agentId, body.jobId) : null;
    if (row === null) {
      sendRefusal(res, NO_SUCH_MAINTENANCE);
      return;
    }
    const outcome = await recordMaintenanceProgress(deps, row, body);
    if (!outcome.accepted) {
      sendRefusal(res, refusal('conflict', 'This maintenance job has already ended.', 'Report progress only for a running job.'));
      return;
    }
    // The step only: what the job names is on its request and dispatch rows already.
    await req.audit({
      action: 'maintenance.progress',
      entityType: 'maintenance_job',
      entityId: row.id,
      before: { state: row.state, step: row.step },
      after: { state: outcome.status.state, step: body.step },
    });
    res.json(outcome.status);
  });

  router.post('/maintenance/:id/result', verified, async (req, res) => {
    const body = parse(MaintenanceResult, req, res);
    const agentId = req.agent?.id;
    if (body === null || agentId === undefined || agentId === null) return;
    const row = body.jobId === paramId(req) ? await ownMaintenance(db, agentId, body.jobId) : null;
    if (row === null) {
      sendRefusal(res, NO_SUCH_MAINTENANCE);
      return;
    }
    const outcome = await recordMaintenanceResult(deps, row, body);
    if (!outcome.accepted) {
      sendRefusal(res, refusal('conflict', 'This maintenance job already has a result.', 'Send a result once per job.'));
      return;
    }
    await req.audit({
      action: 'maintenance.result',
      entityType: 'maintenance_job',
      entityId: row.id,
      before: { state: row.state },
      after: {
        state: body.state,
        kind: row.kind,
        volume: row.volume,
        ...(body.archive === undefined ? {} : { archiveId: body.archive.archiveId, sizeBytes: body.archive.sizeBytes, sha256: body.archive.sha256 }),
        ...(body.removedArchives === undefined ? {} : { removedArchives: body.removedArchives }),
        ...(body.prune === undefined ? {} : { pruneItems: body.prune.items.length, reclaimableBytes: body.prune.reclaimableBytes, reclaimedBytes: body.prune.reclaimedBytes }),
        ...(outcome.status.refusal === null ? {} : { refusal: outcome.status.refusal.code }),
      },
    });
    logger.info({ maintenanceId: row.id, kind: row.kind, state: body.state }, 'maintenance result recorded');
    res.json(outcome.status);
  });

  router.post('/logs/:id/chunks', verified, (req, res) => {
    const body = parse(LogsChunk, req, res);
    const agentId = req.agent?.id;
    if (body === null || agentId === undefined || agentId === null) return;
    if (body.logsId !== paramId(req)) {
      sendRefusal(res, NO_SUCH_LOGS);
      return;
    }
    const answer = hub.chunk(agentId, body);
    if (answer === 'not_yours') {
      sendRefusal(res, NO_SUCH_LOGS);
      return;
    }
    // Relayed and dropped: nothing is stored, so there is nothing to audit; the view itself was
    // audited when it was opened (SHP-REQ-192).
    req.noAuditNeeded('log chunk relayed, never stored');
    logger.debug({ logsId: body.logsId, seq: body.seq, lines: body.lines.length, done: body.done, continue: answer.continue }, 'log chunk relayed');
    const ack: LogsChunkAck = answer;
    res.json(ack);
  });
}
