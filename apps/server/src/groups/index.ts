import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

/** Mounted at /api/groups · group deploys with canary promotion (SHP-T-5.2, SHP-T-5.3). A stub until that task fills it. */
export function groupsRouter(_deps: ServiceDeps): Router {
  return Router();
}
