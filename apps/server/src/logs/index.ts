import { Router, type Request } from 'express';
import { LogsRequest, refusal } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { callerFromRequest } from '../deploys/service.js';
import { sendRefusal } from '../errors.js';
import { logsHubFor, type LogsEvent, type LogsViewer } from './hub.js';
import { openLogs, toLogsSession } from './service.js';

export * from './hub.js';
export * from './service.js';

/**
 * Mounted at `/api/logs` (SHP-T-15.4, SHP-ADR-011):
 *
 * - `POST /` — open a bounded log read of one container (201 `LogsSession`); audited `logs.view`.
 * - `GET /:id/stream` — Server-Sent Events relaying the agent's chunks in order: `event: lines`
 *   with `{ seq, lines }`, then `event: end` with `{ reason, error? }`, and the stream closes. A
 *   `: ping` comment keeps an idle stream open. Only the viewer who opened it may attach; leaving
 *   ends the session, and the agent's next chunk is told to stop.
 * - `DELETE /:id` — stop it (204).
 *
 * Log lines pass through and are dropped: never stored, never logged (SHP-REQ-191). Only IDs and
 * counts reach pino.
 */

export interface LogsRouterOptions {
  /** How long an idle stream waits before a keep-alive comment. */
  pingMs?: number;
}

const DEFAULT_PING_MS = 15_000;
const NO_SUCH_SESSION = refusal('not_found', 'No such log session.', 'Open a new one with POST /api/logs.');

function viewerOf(req: Request): LogsViewer | null {
  const actor = req.actor;
  if ((actor?.type !== 'user' && actor?.type !== 'token') || actor.id === undefined) return null;
  return { type: actor.type, id: actor.id };
}

export function logsRouter(deps: ServiceDeps, options: LogsRouterOptions = {}): Router {
  const { logger } = deps;
  const hub = logsHubFor(deps.bus);
  const pingMs = options.pingMs ?? DEFAULT_PING_MS;
  const router = Router();

  router.post('/', async (req, res) => {
    const parsed = LogsRequest.safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(
        res,
        refusal(
          'invalid_request',
          'The logs request failed validation.',
          parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
        ),
      );
      return;
    }
    const session = await openLogs(deps, callerFromRequest(req), parsed.data);
    if ('code' in session) {
      sendRefusal(res, session);
      return;
    }
    res.status(201).json(toLogsSession(session));
  });

  router.get('/:id/stream', (req, res) => {
    const raw: unknown = req.params['id'];
    const id = typeof raw === 'string' ? raw : '';
    const viewer = viewerOf(req);
    if (viewer === null) {
      sendRefusal(res, req.actor === undefined ? refusal('unauthenticated', 'You are not signed in.') : refusal('forbidden', 'Only a user or token reads logs.'));
      return;
    }
    // Someone else's session is reported as absent, so its existence is not disclosed.
    if (hub.get(id) === null || !hub.isViewer(id, viewer)) {
      sendRefusal(res, NO_SUCH_SESSION);
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // An object, not a `let`: the close handler and the listener flip it between awaits-free calls.
    const stream = { finished: false };
    let relayed = 0;
    const ping = setInterval(() => {
      // Expiry is checked on activity; an idle stream is activity enough.
      hub.sweep();
      if (!stream.finished) res.write(': ping\n\n');
    }, pingMs);
    let unsubscribe: () => void = () => undefined;
    const finish = (): void => {
      if (stream.finished) return;
      stream.finished = true;
      clearInterval(ping);
      res.off('close', finish);
      // Detaching the last listener of a live session ends it: the viewer has left.
      unsubscribe();
      if (!res.writableEnded) res.end();
      logger.info({ logsId: id, chunks: relayed }, 'log stream closed');
    };
    const onEvent = (event: LogsEvent): void => {
      if (stream.finished) return;
      if (event.type === 'lines') {
        relayed += 1;
        res.write(`id: ${String(event.seq)}\nevent: lines\ndata: ${JSON.stringify({ seq: event.seq, lines: event.lines })}\n\n`);
        return;
      }
      res.write(`event: end\ndata: ${JSON.stringify({ reason: event.reason, ...(event.error === undefined ? {} : { error: event.error }) })}\n\n`);
      finish();
    };
    res.on('close', finish);
    unsubscribe = hub.subscribe(id, onEvent);
    if (stream.finished) unsubscribe();
  });

  router.delete('/:id', async (req, res) => {
    const raw: unknown = req.params['id'];
    const id = typeof raw === 'string' ? raw : '';
    const viewer = viewerOf(req);
    if (viewer === null) {
      sendRefusal(res, req.actor === undefined ? refusal('unauthenticated', 'You are not signed in.') : refusal('forbidden', 'Only a user or token reads logs.'));
      return;
    }
    const session = hub.get(id);
    if (session === null || !hub.isViewer(id, viewer)) {
      sendRefusal(res, NO_SUCH_SESSION);
      return;
    }
    const stopped = hub.stop(id);
    await req.audit({
      action: 'logs.stop',
      entityType: 'container',
      entityId: session.container,
      after: { logsId: id, containerName: session.containerName, alreadyEnded: !stopped },
    });
    res.status(204).end();
  });

  return router;
}
