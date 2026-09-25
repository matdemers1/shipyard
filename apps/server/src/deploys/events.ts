import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

// Stub wired into app.ts by the fleet lead (SHP-P-3 pre-flight). SHP-T-3.4 fills it: GET /api/deploys/:id/events (Server-Sent Events), mounted at /api/deploys.
export function deployEventsRouter(_deps: ServiceDeps): Router {
  return Router();
}
