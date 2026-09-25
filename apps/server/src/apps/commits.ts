import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

// Stub wired into app.ts by the fleet lead (SHP-P-3 pre-flight). SHP-T-3.2 fills it: GET /api/apps/:app/commits (commits waiting on the default branch, with CI state), mounted at /api/apps.
export function commitsRouter(_deps: ServiceDeps): Router {
  return Router();
}
