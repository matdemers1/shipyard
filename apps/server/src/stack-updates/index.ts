import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { AppName, StackRollbackRequest, StackUpdateRequest, refusal, type Refusal, type StackUpdateStatus } from '@shipyard/schema';
import type { Decider } from '../approvals/service.js';
import { STEP_UP_MS, staleStepUp } from '../auth/native-sessions.js';
import type { ServiceDeps } from '../deps.js';
import { callerFromRequest } from '../deploys/service.js';
import { sendRefusal } from '../errors.js';
import {
  approveStackUpdate,
  denyStackUpdate,
  expireHeldStackUpdates,
  getStackUpdate,
  isStackUpdateTerminal,
  listStackUpdates,
  listStacks,
  requestStackRollback,
  requestStackUpdate,
  stackNeedsYou,
  sweepStaleStackUpdates,
} from './service.js';

export * from './service.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const NO_SUCH_UPDATE = refusal('not_found', 'No such stack update.', 'List stack updates and use one of their IDs.');

/** Reading needs a signed-in user (any role) or a token. */
function readRefusal(req: Request): Refusal | null {
  const type = req.actor?.type;
  if (type === 'user' || type === 'token') return null;
  if (type === undefined) return refusal('unauthenticated', 'You are not signed in.');
  return refusal('forbidden', `A ${type} actor cannot read stack updates.`);
}

/** A token reads only the stacks its scope names (SHP-REQ-047), as POST checks. */
function scopeRefusal(req: Request, stack: string): Refusal | null {
  if (req.actor?.type !== 'token') return null;
  if (req.tokenStacks?.has(stack) === true) return null;
  return refusal('forbidden', `This token is not scoped to ${stack}.`, `Use a token issued for ${stack}.`);
}

function tokenScope(req: Request): ReadonlySet<string> | undefined {
  return req.actor?.type === 'token' ? (req.tokenStacks ?? new Set<string>()) : undefined;
}

function parseBody<T extends z.ZodType>(schema: T, req: Request, res: Response, what: string): z.infer<T> | null {
  const parsed = schema.safeParse(req.body);
  if (parsed.success) return parsed.data;
  sendRefusal(
    res,
    refusal(
      'invalid_request',
      `The ${what} request failed validation.`,
      parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
    ),
  );
  return null;
}

/** `?limit=&cursor=`, or the refusal already sent. */
function pageQuery(req: Request, res: Response): { limit: number; cursor?: string } | null {
  const raw = req.query['limit'];
  let limit = DEFAULT_LIMIT;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_LIMIT) {
      sendRefusal(res, refusal('invalid_request', `limit must be a whole number from 1 to ${String(MAX_LIMIT)}.`));
      return null;
    }
    limit = Number(raw);
  }
  const cursor = req.query['cursor'];
  if (cursor !== undefined && typeof cursor !== 'string') {
    sendRefusal(res, refusal('invalid_request', 'cursor must be a string.'));
    return null;
  }
  return cursor === undefined ? { limit } : { limit, cursor };
}

function nameParam(req: Request): string | null {
  const raw: unknown = req.params['name'];
  const parsed = AppName.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function idParam(req: Request): string {
  const raw: unknown = req.params['id'];
  return typeof raw === 'string' ? raw : '';
}

/**
 * Mounted at `/api/stacks` (SHP-T-16.3; SHP-ADR-010, SHP-REQ-195, SHP-REQ-199, SHP-REQ-200):
 *
 * - `GET /` — every adopted stack with its tracked services, running digests and candidates.
 * - `POST /:name/updates` — update to the reported candidates, or the digests named (deployer and
 *   up; a token only for a stack its scope names). Queued, or held for approval by the stack's
 *   policy.
 * - `POST /:name/rollback` — back to an earlier succeeded update; a native session needs step-up.
 * - `GET /:name/updates` — the stack's history, newest first.
 */
export function stacksRouter(deps: ServiceDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const denied = readRefusal(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    await sweepStaleStackUpdates(deps);
    await expireHeldStackUpdates(deps);
    res.json({ stacks: await listStacks(db, tokenScope(req)) });
  });

  router.post('/:name/updates', async (req, res) => {
    const name = nameParam(req);
    if (name === null) {
      sendRefusal(res, refusal('unknown_app', 'No adopted stack has that name.'));
      return;
    }
    const body = parseBody(StackUpdateRequest, req, res, 'stack update');
    if (body === null) return;
    const result = await requestStackUpdate(deps, callerFromRequest(req), name, body);
    if ('code' in result) {
      sendRefusal(res, result);
      return;
    }
    res.status(202).json(result);
  });

  router.post('/:name/rollback', async (req, res) => {
    const name = nameParam(req);
    if (name === null) {
      sendRefusal(res, refusal('unknown_app', 'No adopted stack has that name.'));
      return;
    }
    const stale = staleStepUp(req);
    if (stale !== null) {
      sendRefusal(res, stale, { maxAgeSeconds: STEP_UP_MS / 1000 });
      return;
    }
    const body = parseBody(StackRollbackRequest, req, res, 'stack rollback');
    if (body === null) return;
    const result = await requestStackRollback(deps, callerFromRequest(req), name, body);
    if ('code' in result) {
      sendRefusal(res, result);
      return;
    }
    res.status(202).json(result);
  });

  router.get('/:name/updates', async (req, res) => {
    const denied = readRefusal(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const name = nameParam(req);
    const stack = name === null ? null : await db.stack.findUnique({ where: { name }, select: { id: true, name: true } });
    if (stack === null) {
      sendRefusal(res, refusal('not_found', 'No adopted stack has that name.', 'List stacks and use one of their names.'));
      return;
    }
    const scoped = scopeRefusal(req, stack.name);
    if (scoped !== null) {
      sendRefusal(res, scoped);
      return;
    }
    const page = pageQuery(req, res);
    if (page === null) return;
    await sweepStaleStackUpdates(deps);
    res.json(await listStackUpdates(db, { ...page, stackId: stack.id }));
  });

  return router;
}

type Decide = (deps: ServiceDeps, decider: Decider, id: string) => Promise<StackUpdateStatus | Refusal>;

/**
 * Mounted at `/api/stack-updates` (SHP-T-16.3):
 *
 * - `GET /` — every stack update, newest first (a token: its stacks only) — an Activity source.
 * - `GET /needs-you` — held updates and each stack's unfixed failure, for Needs you (console users).
 * - `GET /:id` — one update and its outcome.
 * - `POST /:id/approve`, `POST /:id/deny` — a deployer's decision on a held one (console users only,
 *   never a token; a native session needs step-up), like a held deploy's.
 */
export function stackUpdatesRouter(deps: ServiceDeps): Router {
  const { db, logger } = deps;
  const router = Router();

  router.get('/', async (req, res) => {
    const denied = readRefusal(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const page = pageQuery(req, res);
    if (page === null) return;
    await sweepStaleStackUpdates(deps);
    const scope = tokenScope(req);
    res.json(await listStackUpdates(db, { ...page, ...(scope === undefined ? {} : { scope }) }));
  });

  router.get('/needs-you', async (req, res) => {
    if (req.actor === undefined) {
      sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    if (req.actor.type !== 'user') {
      sendRefusal(res, refusal('forbidden', 'What needs you is read in the console.'));
      return;
    }
    await sweepStaleStackUpdates(deps);
    await expireHeldStackUpdates(deps);
    res.json(await stackNeedsYou(db));
  });

  router.get('/:id', async (req, res) => {
    const denied = readRefusal(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const id = idParam(req);
    const first = await getStackUpdate(db, id);
    if (first === null) {
      sendRefusal(res, NO_SUCH_UPDATE);
      return;
    }
    const scoped = scopeRefusal(req, first.stack);
    if (scoped !== null) {
      sendRefusal(res, scoped);
      return;
    }
    if (isStackUpdateTerminal(first.state)) {
      res.json(first);
      return;
    }
    // Not yet ended: give the stale sweep its chance, so an agent that went away shows as failed.
    const swept = await sweepStaleStackUpdates(deps);
    res.json(swept.includes(first.id) ? ((await getStackUpdate(db, id)) ?? first) : first);
  });

  const decide = (action: 'approve' | 'deny', fn: Decide): void => {
    router.post(`/:id/${action}`, async (req, res) => {
      const stale = staleStepUp(req);
      if (stale !== null) {
        sendRefusal(res, stale, { maxAgeSeconds: STEP_UP_MS / 1000 });
        return;
      }
      const decider: Decider = { actor: req.actor, role: req.role, audit: (event) => req.audit(event) };
      const result = await fn(deps, decider, idParam(req));
      if ('code' in result) {
        sendRefusal(res, result);
        return;
      }
      logger.info({ stackUpdateId: result.id, state: result.state }, `stack update ${action === 'approve' ? 'approved' : 'denied'}`);
      res.json(result);
    });
  };
  decide('approve', approveStackUpdate);
  decide('deny', denyStackUpdate);

  return router;
}
