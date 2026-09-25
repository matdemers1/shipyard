import { Router, type Request } from 'express';
import { refusal, type Refusal } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { getGroupDeployStatus, listGroups, waitForGroupChange } from './service.js';

export * from './service.js';

/**
 * Mounted at /api/groups · group deploys with canary promotion (SHP-T-5.2, SHP-T-5.3).
 *
 * A group deploy is requested like any other — `POST /api/deploys` with `group` in place of `app`
 * (or `shipyard_deploy` over MCP). This router reads:
 * - `GET /` — every reported group, its canary and its members in deploy order.
 * - `GET /deploys/:id[?wait=]` — a group deploy with every member's status, in deploy order.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SUCH_GROUP_DEPLOY = refusal('not_found', 'No such group deploy.', 'List deploys and use the ID of a group deploy.');

function assertCanRead(req: Request): Refusal | null {
  const type = req.actor?.type;
  if (type === 'user' || type === 'token') return null;
  if (type === undefined) return refusal('unauthenticated', 'You are not signed in.');
  return refusal('forbidden', `A ${type} actor cannot read deploys.`);
}

/** A token reads a group only when it is scoped to every member (SHP-REQ-047). */
function inScope(req: Request, apps: readonly string[]): boolean {
  if (req.actor?.type !== 'token') return true;
  return apps.every((a) => req.tokenApps?.has(a) === true);
}

export function groupsRouter(deps: ServiceDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const denied = assertCanRead(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const groups = await listGroups(deps.db);
    res.json(groups.filter((g) => inScope(req, g.members)));
  });

  router.get('/deploys/:id', async (req, res) => {
    const denied = assertCanRead(req);
    if (denied !== null) {
      sendRefusal(res, denied);
      return;
    }
    const raw: unknown = req.params['id'];
    const id = typeof raw === 'string' ? raw : '';
    if (!UUID_RE.test(id)) {
      sendRefusal(res, NO_SUCH_GROUP_DEPLOY);
      return;
    }
    const rawWait = req.query['wait'];
    let wait = 0;
    if (rawWait !== undefined) {
      if (typeof rawWait !== 'string' || !/^\d+$/.test(rawWait) || Number(rawWait) > 90) {
        sendRefusal(res, refusal('invalid_request', 'wait must be a whole number of seconds from 0 to 90.'));
        return;
      }
      wait = Number(rawWait);
    }
    // Scope is checked before waiting, so an out-of-scope caller cannot hold a long poll open.
    const first = await getGroupDeployStatus(deps.db, id);
    if (first === null) {
      sendRefusal(res, NO_SUCH_GROUP_DEPLOY);
      return;
    }
    if (!inScope(req, first.members.map((m) => m.app))) {
      sendRefusal(res, refusal('forbidden', `This token is not scoped to every member of group ${first.group}.`));
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
      const status = await waitForGroupChange(deps, id, wait, abort.signal);
      if (abort.signal.aborted || res.writableEnded) return;
      res.json(status ?? first);
    } finally {
      res.off('close', onClose);
    }
  });

  return router;
}
