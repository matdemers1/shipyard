import { Router, type Request } from 'express';
import { ActionRequest, refusal, type Refusal } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { callerFromRequest } from '../deploys/service.js';
import { sendRefusal } from '../errors.js';
import { getAction, isActionTerminal, listActions, requestAction, sweepStaleActions, tokenScopeCovers } from './service.js';

export * from './service.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const NO_SUCH_ACTION = refusal('not_found', 'No such action.', 'List actions and use one of their IDs.');

/** Reading needs a signed-in user (any role) or a token. */
function readRefusal(req: Request): Refusal | null {
  const type = req.actor?.type;
  if (type === 'user' || type === 'token') return null;
  if (type === undefined) return refusal('unauthenticated', 'You are not signed in.');
  return refusal('forbidden', `A ${type} actor cannot read actions.`);
}

/** A token reads only actions on the apps and stacks it is scoped to (SHP-REQ-047), as POST checks. */
function scopeRefusal(req: Request, kind: 'app' | 'stack', name: string): Refusal | null {
  if (req.actor?.type !== 'token') return null;
  if (tokenScopeCovers({ tokenApps: req.tokenApps, tokenStacks: req.tokenStacks }, { kind, name })) return null;
  return refusal('forbidden', `This token is not scoped to ${name}.`, `Use a token issued for ${name}.`);
}

/**
 * Mounted at `/api/actions` (SHP-T-15.4, SHP-ADR-010): request a lifecycle action, read one, and
 * list them newest first — the Activity screen merges the list with deploys and builds.
 */
export function actionsRouter(deps: ServiceDeps): Router {
  const { db } = deps;
  const router = Router();

  router.post('/', async (req, res) => {
    const parsed = ActionRequest.safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(
        res,
        refusal(
          'invalid_request',
          'The action request failed validation.',
          parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
        ),
      );
      return;
    }
    const result = await requestAction(deps, callerFromRequest(req), parsed.data);
    if ('code' in result) {
      sendRefusal(res, result);
      return;
    }
    res.status(202).json(result);
  });

  router.get('/', async (req, res) => {
    const denied = readRefusal(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const raw = req.query['limit'];
    let limit = DEFAULT_LIMIT;
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_LIMIT) {
        sendRefusal(res, refusal('invalid_request', `limit must be a whole number from 1 to ${String(MAX_LIMIT)}.`));
        return;
      }
      limit = Number(raw);
    }
    const cursor = req.query['cursor'];
    if (cursor !== undefined && typeof cursor !== 'string') {
      sendRefusal(res, refusal('invalid_request', 'cursor must be a string.'));
      return;
    }
    await sweepStaleActions(deps);
    res.json(
      await listActions(db, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(req.actor?.type === 'token' ? { scope: { apps: req.tokenApps ?? new Set<string>(), stacks: req.tokenStacks ?? new Set<string>() } } : {}),
      }),
    );
  });

  router.get('/:id', async (req, res) => {
    const denied = readRefusal(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const raw: unknown = req.params['id'];
    const id = typeof raw === 'string' ? raw : '';
    const first = await getAction(db, id);
    if (first === null) {
      sendRefusal(res, NO_SUCH_ACTION);
      return;
    }
    const scoped = scopeRefusal(req, first.target.kind, first.target.name);
    if (scoped !== null) {
      sendRefusal(res, scoped);
      return;
    }
    if (isActionTerminal(first.state)) {
      res.json(first);
      return;
    }
    // Not yet ended: give the stale sweep its chance, so an agent that went away shows as failed.
    const swept = await sweepStaleActions(deps);
    res.json(swept.includes(first.id) ? ((await getAction(db, id)) ?? first) : first);
  });

  return router;
}
