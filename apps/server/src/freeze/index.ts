import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

/** Mounted at /api/apps · freeze and unfreeze (SHP-T-5.1). A stub until that task fills it. */
export function freezeRouter(_deps: ServiceDeps): Router {
  return Router();
}
