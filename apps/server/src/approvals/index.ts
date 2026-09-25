import { Router, type Request } from 'express';
import { refusal, type DeployAccepted, type Refusal } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { isRefusal } from '../deploys/service.js';
import { approveDeploy, denyDeploy, listPendingApprovals, type Decider } from './service.js';

export * from './service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decider(req: Request): Decider {
  return { actor: req.actor, role: req.role, audit: (event) => req.audit(event) };
}

function idParam(req: Request): string | null {
  const raw: unknown = req.params['id'];
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw : null;
}

type Decide = (deps: ServiceDeps, d: Decider, deployId: string) => Promise<DeployAccepted | Refusal>;

/**
 * Mounted at `/api/deploys` before the deploys router (SHP-T-3.6): `POST /:id/approve` and
 * `POST /:id/deny`, console users only (SHP-D-072).
 */
export function approvalsRouter(deps: ServiceDeps): Router {
  const router = Router();

  const decide = (action: 'approve' | 'deny', fn: Decide) => {
    router.post(`/:id/${action}`, async (req, res) => {
      const id = idParam(req);
      if (id === null) {
        sendRefusal(res, refusal('not_found', 'No such deploy.', 'List pending approvals and use one of their deploy IDs.'));
        return;
      }
      const result = await fn(deps, decider(req), id);
      if (isRefusal(result)) {
        sendRefusal(res, result);
        return;
      }
      deps.logger.info({ deployId: id, state: result.state }, `deploy ${action === 'approve' ? 'approved' : 'denied'}`);
      res.json(result);
    });
  };
  decide('approve', approveDeploy);
  decide('deny', denyDeploy);

  return router;
}

/**
 * `GET /approvals` — pending approvals for the home banner (SHP-D-071). Any signed-in console
 * user may read them, viewers included. Meant to be mounted at `/api`.
 */
export function pendingApprovalsRouter(deps: ServiceDeps): Router {
  const router = Router();
  router.get('/approvals', async (req, res) => {
    if (req.actor === undefined) {
      sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    if (req.actor.type !== 'user') {
      sendRefusal(res, refusal('forbidden', 'Pending approvals are read in the console.'));
      return;
    }
    res.json(await listPendingApprovals(deps));
  });
  return router;
}
