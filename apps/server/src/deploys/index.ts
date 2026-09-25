import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

// Stub wired into app.ts by the fleet lead (SHP-P-2 pre-flight). SHP-T-2.5 fills it: POST/GET /api/deploys, GET /api/deploys/:id (?wait=).
export function deploysRouter(_deps: ServiceDeps): Router {
  return Router();
}
