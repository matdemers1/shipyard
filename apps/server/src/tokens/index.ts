import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

// Stub wired into app.ts by the fleet lead (SHP-P-2 pre-flight). SHP-T-2.7 fills it: GET/POST /api/tokens, DELETE /api/tokens/:id.
export function tokensRouter(_deps: ServiceDeps): Router {
  return Router();
}
