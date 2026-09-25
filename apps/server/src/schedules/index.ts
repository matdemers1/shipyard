import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

/** Mounted at /api/schedules · scheduled deploys (SHP-T-5.4). A stub until that task fills it. */
export function schedulesRouter(_deps: ServiceDeps): Router {
  return Router();
}
