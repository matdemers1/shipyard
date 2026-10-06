import { Router, type Request } from 'express';
import { refusal, RolloutRequest, type Refusal } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { callerFromRequest, isRefusal, MAX_WAIT_SECONDS } from '../deploys/service.js';
import { createRollout, getRolloutStatus, planRollout, waitForRolloutChange } from './service.js';

export * from './service.js';

/**
 * Mounted at /api/rollouts · "Roll all" (SHP-T-12.1; SHP-REQ-151, SHP-REQ-152, SHP-REQ-153).
 *
 * - `POST /plan` — what a rollout of these `{ app, sha }` items would ship, in order, or the refusal
 *   a real request would get now (the lock included). Writes nothing.
 * - `POST /` — start the rollout: every member locked in one transaction, shipped one at a time.
 * - `GET /:id[?wait=]` — the rollout with every member's deploy status, in order.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SUCH_ROLLOUT = refusal('not_found', 'No such rollout.', 'Use the rollout ID returned when it was started.');

function assertCanRead(req: Request): Refusal | null {
  const type = req.actor?.type;
  if (type === 'user' || type === 'token') return null;
  if (type === undefined) return refusal('unauthenticated', 'You are not signed in.');
  return refusal('forbidden', `A ${type} actor cannot read rollouts.`);
}

/** A token reads a rollout only when it is scoped to every member (SHP-REQ-047). */
function inScope(req: Request, apps: readonly string[]): boolean {
  if (req.actor?.type !== 'token') return true;
  return apps.every((a) => req.tokenApps?.has(a) === true);
}

function parseRequest(req: Request): RolloutRequest | Refusal {
  const parsed = RolloutRequest.safeParse(req.body);
  if (parsed.success) return parsed.data;
  return refusal(
    'invalid_request',
    'The rollout request failed validation.',
    parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
  );
}

export function rolloutsRouter(deps: ServiceDeps): Router {
  const { logger } = deps;
  const selfApp = deps.config.SELF_APP;
  const router = Router();

  router.post('/plan', async (req, res) => {
    const input = parseRequest(req);
    if (isRefusal(input)) {
      sendRefusal(res, input);
      return;
    }
    const result = await planRollout(deps, callerFromRequest(req), input, { selfApp });
    if (isRefusal(result)) {
      sendRefusal(res, result);
      return;
    }
    res.json(result);
  });

  router.post('/', async (req, res) => {
    const input = parseRequest(req);
    if (isRefusal(input)) {
      sendRefusal(res, input);
      return;
    }
    const result = await createRollout(deps, callerFromRequest(req), input, { selfApp });
    if (isRefusal(result)) {
      sendRefusal(res, result);
      return;
    }
    logger.info({ rolloutId: result.rolloutId, deployIds: result.deployIds }, 'rollout requested');
    res.status(201).json(result);
  });

  router.get('/:id', async (req, res) => {
    const denied = assertCanRead(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const raw: unknown = req.params['id'];
    const id = typeof raw === 'string' ? raw : '';
    if (!UUID_RE.test(id)) {
      sendRefusal(res, NO_SUCH_ROLLOUT);
      return;
    }
    const rawWait = req.query['wait'];
    let wait = 0;
    if (rawWait !== undefined) {
      if (typeof rawWait !== 'string' || !/^\d+$/.test(rawWait) || Number(rawWait) > MAX_WAIT_SECONDS) {
        sendRefusal(res, refusal('invalid_request', `wait must be a whole number of seconds from 0 to ${String(MAX_WAIT_SECONDS)}.`));
        return;
      }
      wait = Number(rawWait);
    }
    // Scope is checked before waiting, so an out-of-scope caller cannot hold a long poll open.
    const first = await getRolloutStatus(deps.db, id, selfApp);
    if (first === null) {
      sendRefusal(res, NO_SUCH_ROLLOUT);
      return;
    }
    if (!inScope(req, first.members.map((m) => m.app))) {
      sendRefusal(res, refusal('forbidden', 'This token is not scoped to every app in this rollout.'));
      return;
    }
    if (wait === 0) {
      res.json(first);
      return;
    }
    const abort = new AbortController();
    const onClose = (): void => {
      abort.abort();
    };
    res.on('close', onClose);
    try {
      const status = await waitForRolloutChange(deps, id, selfApp, wait, abort.signal);
      if (abort.signal.aborted || res.writableEnded) return;
      res.json(status ?? first);
    } finally {
      res.off('close', onClose);
    }
  });

  return router;
}
