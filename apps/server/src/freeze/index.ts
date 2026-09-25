import { Router, type Request } from 'express';
import { FreezeRequest, refusal } from '@shipyard/schema';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { isRefusal } from '../deploys/service.js';
import { activeFreezeInfo, clearFreeze, setFreeze, type FreezeCaller } from './service.js';

function callerOf(req: Request): FreezeCaller {
  return { actor: req.actor, role: req.role, audit: (event) => req.audit(event) };
}

/**
 * Mounted at /api/apps · freeze and unfreeze (SHP-T-5.1, SHP-REQ-077). `POST /:app/freeze` sets a
 * freeze; `DELETE /:app/freeze` clears it. `GET /:app/freeze` reads the active freeze, for the
 * console (any signed-in reader, same as the rest of app detail).
 */
export function freezeRouter(deps: ServiceDeps): Router {
  const router = Router();
  const { db } = deps;

  router.get('/:app/freeze', async (req, res) => {
    const type = req.actor?.type;
    if (type !== 'user' && type !== 'token') {
      sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
      return;
    }
    const name = req.params['app'];
    const scope = req.actor?.type === 'token' ? (req.tokenApps ?? new Set<string>()) : undefined;
    const notFound = refusal('not_found', `No app named ${name}.`, 'List the apps and use one of their names.');
    if (typeof name !== 'string' || (scope !== undefined && !scope.has(name))) {
      sendRefusal(res, notFound);
      return;
    }
    const app = await db.app.findUnique({ where: { name }, select: { id: true } });
    if (app === null) {
      sendRefusal(res, notFound);
      return;
    }
    res.json({ freeze: await activeFreezeInfo(db, app.id) });
  });

  router.post('/:app/freeze', async (req, res) => {
    const name = req.params['app'];
    if (typeof name !== 'string') {
      sendRefusal(res, refusal('not_found', 'No such app.', 'List the apps and use one of their names.'));
      return;
    }
    const parsed = FreezeRequest.safeParse(req.body);
    if (!parsed.success) {
      sendRefusal(res, refusal('invalid_request', 'The request failed validation.', parsed.error.issues.map((i) => i.message).join('; ')));
      return;
    }
    const result = await setFreeze(db, callerOf(req), name, parsed.data);
    if (isRefusal(result)) {
      sendRefusal(res, result);
      return;
    }
    res.status(201).json(result);
  });

  router.delete('/:app/freeze', async (req, res) => {
    const name = req.params['app'];
    if (typeof name !== 'string') {
      sendRefusal(res, refusal('not_found', 'No such app.', 'List the apps and use one of their names.'));
      return;
    }
    const result = await clearFreeze(db, callerOf(req), name);
    if (isRefusal(result)) {
      sendRefusal(res, result);
      return;
    }
    res.status(200).json(result);
  });

  return router;
}
