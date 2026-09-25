import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

/** Mounted at /api/apps · guided restore (SHP-T-5.6). A stub until that task fills it. */
export function restoreRouter(_deps: ServiceDeps): Router {
  return Router();
}
