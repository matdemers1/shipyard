import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

// Stub wired into app.ts by the fleet lead (SHP-P-2 pre-flight). SHP-T-2.3 fills it: GET /api/apps, /api/apps/:app (the read-only mirror).
export function appsRouter(_deps: ServiceDeps): Router {
  return Router();
}
