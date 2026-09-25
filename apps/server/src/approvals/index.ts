import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

// Stub wired into app.ts by the fleet lead (SHP-P-3 pre-flight). SHP-T-3.6 fills it: POST /api/deploys/:id/approve and /deny, mounted at /api/deploys.
export function approvalsRouter(_deps: ServiceDeps): Router {
  return Router();
}
