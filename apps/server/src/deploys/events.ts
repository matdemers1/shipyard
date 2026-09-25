import { Router, type Request, type Response } from 'express';
import { refusal, type DeployStatus, type Refusal } from '@shipyard/schema';
import type { Db } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { getDeployStatus, isTerminal } from './service.js';

/**
 * Live deploy progress (SHP-T-3.4, SHP-REQ-058, SHP-D-070). Mounted at `/api/deploys` before the
 * deploys router:
 *
 * - `GET /:id/steps` — the steps contract shared with the deploy record screen:
 *   `{ steps: [{ name, argv, startedAt, endedAt, exitCode, output }] }`, ordered by `startedAt`.
 * - `GET /:id/events` — Server-Sent Events: `status` and `steps` at once (the full current state,
 *   so a reconnect with `Last-Event-ID` loses nothing), again on every `deploy:<id>` publish when
 *   they changed, a `: ping` comment when idle, and on a terminal state the final status, `end`,
 *   and the stream closes. The console falls back to polling when the stream drops.
 */

/** One step as the console reads it. */
export interface StepView {
  name: string;
  argv: string[];
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  output: string | null;
}

export interface DeployEventsOptions {
  /** How long an idle stream waits before a keep-alive comment. */
  pingMs?: number;
}

const DEFAULT_PING_MS = 15_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SUCH_DEPLOY = refusal('not_found', 'No such deploy.', 'List deploys and use one of their IDs.');

/** The steps of a deploy's targets, oldest first. */
export async function getDeploySteps(db: Db, deployId: string): Promise<StepView[]> {
  const rows = await db.step.findMany({
    where: { target: { deployId } },
    select: { name: true, argv: true, startedAt: true, endedAt: true, exitCode: true, output: true },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((s) => ({
    name: s.name,
    argv: s.argv,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
    exitCode: s.exitCode,
    output: s.output,
  }));
}

/**
 * Reading needs a signed-in user (viewers included) or a token, and a token reads only the apps
 * it is scoped to (SHP-REQ-047) — the same rule as `GET /api/deploys/:id`.
 */
function readRefusal(req: Request, app: string | null): Refusal | null {
  const type = req.actor?.type;
  if (type === undefined) return refusal('unauthenticated', 'You are not signed in.');
  if (type !== 'user' && type !== 'token') return refusal('forbidden', `A ${type} actor cannot read deploys.`);
  if (app !== null && type === 'token' && req.tokenApps?.has(app) !== true) {
    return refusal('forbidden', `This token is not scoped to ${app}.`, `Use a token issued for ${app}.`);
  }
  return null;
}

/** The deploy's status once the caller may read it; otherwise the refusal has been sent. */
async function readableStatus(db: Db, req: Request, res: Response): Promise<DeployStatus | null> {
  const denied = readRefusal(req, null);
  if (denied !== null) {
    sendRefusal(res, denied);
    return null;
  }
  const raw: unknown = req.params['id'];
  const id = typeof raw === 'string' ? raw : '';
  if (!UUID_RE.test(id)) {
    sendRefusal(res, NO_SUCH_DEPLOY);
    return null;
  }
  const status = await getDeployStatus(db, id);
  if (status === null) {
    sendRefusal(res, NO_SUCH_DEPLOY);
    return null;
  }
  const scoped = readRefusal(req, status.app);
  if (scoped !== null) {
    sendRefusal(res, scoped);
    return null;
  }
  return status;
}

export function deployEventsRouter(deps: ServiceDeps, options: DeployEventsOptions = {}): Router {
  const { db, bus, logger } = deps;
  const pingMs = options.pingMs ?? DEFAULT_PING_MS;
  const router = Router();

  router.get('/:id/steps', async (req, res) => {
    const status = await readableStatus(db, req, res);
    if (status === null) return;
    res.json({ steps: await getDeploySteps(db, status.deployId) });
  });

  router.get('/:id/events', async (req, res) => {
    // Scope is checked before the stream opens, so an out-of-scope caller gets a refusal, not a stream.
    const first = await readableStatus(db, req, res);
    if (first === null) return;
    const deployId = first.deployId;
    const topic = `deploy:${deployId}` as const;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    // Read through a function: `closed` flips in the close handler, which narrowing cannot see.
    const isClosed = (): boolean => closed;
    // The waiter armed for the current round; aborting it removes its bus listener at once.
    let round: AbortController | null = null;
    const onClose = (): void => {
      closed = true;
      round?.abort();
    };
    res.on('close', onClose);

    let seq = 0;
    const send = (event: string, data: unknown): void => {
      seq += 1;
      res.write(`id: ${String(seq)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let lastStatus = '';
    let lastSteps = '';
    /** Sends what changed since the last send; returns the status read. */
    const push = async (known?: DeployStatus): Promise<DeployStatus | null> => {
      const status = known ?? (await getDeployStatus(db, deployId));
      const steps = await getDeploySteps(db, deployId);
      if (closed || status === null) return status;
      const statusJson = JSON.stringify(status);
      const stepsJson = JSON.stringify({ steps });
      if (statusJson !== lastStatus) {
        lastStatus = statusJson;
        send('status', status);
      }
      if (stepsJson !== lastSteps) {
        lastSteps = stepsJson;
        send('steps', { steps });
      }
      return status;
    };

    try {
      let known: DeployStatus | undefined = first;
      while (!isClosed()) {
        // Armed before the read, so a publish between the read and the wait is not lost.
        const current = new AbortController();
        round = current;
        const woken = bus.wait(topic, pingMs, current.signal);
        let published = false;
        try {
          const status = await push(known);
          known = undefined;
          if (isClosed() || status === null || isTerminal(status.state)) {
            if (!isClosed()) {
              send('end', { state: status?.state ?? null });
              res.end();
            }
            return;
          }
          published = await woken;
        } finally {
          current.abort();
          await woken;
          round = null;
        }
        if (!isClosed() && !published) res.write(': ping\n\n');
      }
    } catch (err) {
      logger.error({ err, deployId }, 'deploy event stream failed');
      if (!res.writableEnded) res.end();
    } finally {
      res.off('close', onClose);
    }
  });

  return router;
}
