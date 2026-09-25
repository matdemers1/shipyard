import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

// Stub wired into app.ts by the fleet lead (SHP-P-3 pre-flight). SHP-T-3.8 fills it: GET /api/users, PATCH /api/users/:id, invites under /api/invites.
export function usersRouter(_deps: ServiceDeps): Router {
  return Router();
}
