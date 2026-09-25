import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

/** Mounted at /api/system · the System screen's data: outbox, Shipyard's own backups, versions (SHP-T-6.5). A stub until that task fills it. */
export function systemRouter(_deps: ServiceDeps): Router {
  return Router();
}
