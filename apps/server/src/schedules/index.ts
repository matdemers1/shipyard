import { Router, type Request } from 'express';
import { ScheduleRequest, refusal } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { callerFromRequest, isRefusal } from '../deploys/service.js';
import { cancelSchedule, createSchedule, listSchedules } from './service.js';

export * from './service.js';

function signedIn(req: Request): boolean {
  const type = req.actor?.type;
  return type === 'user' || type === 'token';
}

/**
 * Mounted at /api/schedules · scheduled deploys (SHP-T-5.4, SHP-REQ-080/081).
 *
 * - `GET /` — upcoming schedules and recently fired or cancelled ones, with each outcome and
 *   refusal. Any signed-in reader (a viewer included); a token sees only its apps.
 * - `POST /` — `{ app, sha, fireAt, requester? }`: a deployer, operator or admin, or a token scoped
 *   to the app. Approval for an approval-required app is captured here (see `service.ts`).
 * - `DELETE /:id` — cancels an unfired schedule.
 */
export function schedulesRouter(deps: ServiceDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    if (!signedIn(req)) {
      sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    const apps = req.actor?.type === 'token' ? (req.tokenApps ?? new Set<string>()) : undefined;
    res.json(await listSchedules(deps.db, apps === undefined ? {} : { apps }));
  });

  router.post('/', async (req, res) => {
    if (!signedIn(req)) {
      sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    const parsed = ScheduleRequest.safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(
        res,
        refusal(
          'invalid_request',
          'The request failed validation.',
          parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
        ),
      );
      return;
    }
    const result = await createSchedule(deps, callerFromRequest(req), parsed.data);
    if (isRefusal(result)) {
      sendRefusal(res, result);
      return;
    }
    deps.logger.info({ deployId: result.deployId, scheduleId: result.id, app: result.app, fireAt: result.fireAt }, 'deploy scheduled');
    res.status(201).json(result);
  });

  router.delete('/:id', async (req, res) => {
    if (!signedIn(req)) {
      sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    const result = await cancelSchedule(deps, callerFromRequest(req), req.params['id']);
    if (isRefusal(result)) {
      sendRefusal(res, result);
      return;
    }
    deps.logger.info({ deployId: result.deployId, scheduleId: result.id }, 'schedule cancelled');
    res.json(result);
  });

  return router;
}
