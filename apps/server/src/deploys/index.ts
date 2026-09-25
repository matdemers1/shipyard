import { Router, type Request } from 'express';
import { AppName, DeployKind, DeployRequest, refusal, type Refusal } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { MAX_WAIT_SECONDS, appsOf, callerFromRequest, createDeploy, isRefusal, listDeploys, waitForChange } from './service.js';
import { foremanStatus, isTimelineOutcome, listTimeline } from './timeline.js';

export * from './service.js';
export * from './timeline.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const NO_SUCH_DEPLOY = refusal('not_found', 'No such deploy.', 'List deploys and use one of their IDs.');

/** Reading needs a signed-in user (any role, viewers included) or a token. */
function assertCanRead(req: Request): Refusal | null {
  const type = req.actor?.type;
  if (type === 'user' || type === 'token') return null;
  if (type === undefined) return refusal('unauthenticated', 'You are not signed in.');
  return refusal('forbidden', `A ${type} actor cannot read deploys.`);
}

/** A token reads only the apps it is scoped to (SHP-REQ-047); a user reads every app. */
function outOfScope(req: Request, app: string): Refusal | null {
  if (req.actor?.type === 'token' && req.tokenApps?.has(app) !== true) {
    return refusal('forbidden', `This token is not scoped to ${app}.`, `Use a token issued for ${app}.`);
  }
  return null;
}

function intParam(raw: unknown, fallback: number, min: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n < min || n > max ? null : n;
}

/** Mounted at `/api/deploys` (SHP-T-2.5): request a deploy or dry run, list, and read status. */
export function deploysRouter(deps: ServiceDeps): Router {
  const { db, logger } = deps;
  const router = Router();

  router.post('/', async (req, res) => {
    const parsed = DeployRequest.safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(
        res,
        refusal(
          'invalid_request',
          'The deploy request failed validation.',
          parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
        ),
      );
      return;
    }
    const result = await createDeploy(deps, callerFromRequest(req), parsed.data);
    if (isRefusal(result)) {
      sendRefusal(res, result);
      return;
    }
    logger.info({ deployId: result.deployId, app: parsed.data.app, state: result.state }, 'deploy requested');
    res.status(201).json(result);
  });

  router.get('/', async (req, res) => {
    const denied = assertCanRead(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const limit = intParam(req.query['limit'], DEFAULT_LIMIT, 1, MAX_LIMIT);
    if (limit === null) {
      sendRefusal(res, refusal('invalid_request', `limit must be a whole number from 1 to ${String(MAX_LIMIT)}.`));
      return;
    }
    const rawApp = req.query['app'];
    let app: string | undefined;
    if (rawApp !== undefined) {
      const name = AppName.safeParse(rawApp);
      if (!name.success) {
        sendRefusal(res, refusal('invalid_request', 'app must be an app name.'));
        return;
      }
      app = name.data;
      const scoped = outOfScope(req, app);
      if (scoped !== null) {
        sendRefusal(res, scoped);
        return;
      }
    }
    const rows = await listDeploys(db, {
      limit,
      ...(app !== undefined ? { app } : {}),
      ...(req.actor?.type === 'token' ? { apps: req.tokenApps ?? new Set<string>() } : {}),
    });
    res.json(rows);
  });

  // Placed before `/:id`, so `timeline` is never read as a deploy id.
  router.get('/timeline', async (req, res) => {
    const denied = assertCanRead(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const limit = intParam(req.query['limit'], DEFAULT_LIMIT, 1, MAX_LIMIT);
    if (limit === null) {
      sendRefusal(res, refusal('invalid_request', `limit must be a whole number from 1 to ${String(MAX_LIMIT)}.`));
      return;
    }

    const rawApp = req.query['app'];
    let app: string | undefined;
    if (rawApp !== undefined) {
      const name = AppName.safeParse(rawApp);
      if (!name.success) {
        sendRefusal(res, refusal('invalid_request', 'app must be an app name.'));
        return;
      }
      app = name.data;
      const scoped = outOfScope(req, app);
      if (scoped !== null) {
        sendRefusal(res, scoped);
        return;
      }
    }

    const rawRequester = req.query['requester'];
    if (rawRequester !== undefined && typeof rawRequester !== 'string') {
      sendRefusal(res, refusal('invalid_request', 'requester must be a string.'));
      return;
    }

    const rawOutcome = req.query['outcome'];
    if (rawOutcome !== undefined && !isTimelineOutcome(rawOutcome)) {
      sendRefusal(res, refusal('invalid_request', 'outcome must be one of the recognised outcomes.'));
      return;
    }

    const rawKind = req.query['kind'];
    const kind = DeployKind.safeParse(rawKind);
    if (rawKind !== undefined && !kind.success) {
      sendRefusal(res, refusal('invalid_request', 'kind must be a recognised deploy kind.'));
      return;
    }

    const rawDryRun = req.query['dryRun'];
    if (rawDryRun !== undefined && rawDryRun !== 'true' && rawDryRun !== 'false') {
      sendRefusal(res, refusal('invalid_request', 'dryRun must be true or false.'));
      return;
    }

    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined && typeof rawCursor !== 'string') {
      sendRefusal(res, refusal('invalid_request', 'cursor must be a string.'));
      return;
    }

    const page = await listTimeline(db, {
      limit,
      ...(app !== undefined ? { app } : {}),
      ...(req.actor?.type === 'token' ? { apps: req.tokenApps ?? new Set<string>() } : {}),
      ...(rawRequester !== undefined ? { requester: rawRequester } : {}),
      ...(rawOutcome !== undefined ? { outcome: rawOutcome } : {}),
      ...(kind.success ? { kind: kind.data } : {}),
      ...(rawDryRun === 'true' ? { dryRun: true } : {}),
      ...(rawCursor !== undefined ? { cursor: rawCursor } : {}),
    });
    res.json(page);
  });

  router.get('/:id/foreman', async (req, res) => {
    const denied = assertCanRead(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const raw: unknown = req.params['id'];
    const id = typeof raw === 'string' ? raw : '';
    if (!UUID_RE.test(id)) {
      sendRefusal(res, NO_SUCH_DEPLOY);
      return;
    }
    // waitForChange(0) is the cheapest way to fetch the deploy's app for the scope check.
    const status = await waitForChange(deps, id, 0);
    if (status === null) {
      sendRefusal(res, NO_SUCH_DEPLOY);
      return;
    }
    const scoped = appsOf(status)
      .map((app) => outOfScope(req, app))
      .find((r): r is Refusal => r !== null);
    if (scoped !== undefined) {
      sendRefusal(res, scoped);
      return;
    }
    const result = await foremanStatus(db, id);
    if (result === null) {
      sendRefusal(res, NO_SUCH_DEPLOY);
      return;
    }
    res.json(result);
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
      sendRefusal(res, NO_SUCH_DEPLOY);
      return;
    }
    const wait = intParam(req.query['wait'], 0, 0, MAX_WAIT_SECONDS);
    if (wait === null) {
      sendRefusal(res, refusal('invalid_request', `wait must be a whole number of seconds from 0 to ${String(MAX_WAIT_SECONDS)}.`));
      return;
    }

    // Scope is checked before waiting, so an out-of-scope caller cannot hold a long poll open.
    const first = await waitForChange(deps, id, 0);
    if (first === null) {
      sendRefusal(res, NO_SUCH_DEPLOY);
      return;
    }
    // Every app the status names: a group's members are never read through one member's scope.
    const scoped = appsOf(first)
      .map((app) => outOfScope(req, app))
      .find((r): r is Refusal => r !== null);
    if (scoped !== undefined) {
      sendRefusal(res, scoped);
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
      const status = await waitForChange(deps, id, wait, abort.signal);
      if (abort.signal.aborted || res.writableEnded) return;
      if (status === null) {
        sendRefusal(res, NO_SUCH_DEPLOY);
        return;
      }
      res.json(status);
    } finally {
      res.off('close', onClose);
    }
  });

  return router;
}
