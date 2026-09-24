import { Router } from 'express';

// Stub, wired into app.ts by the fleet lead so SHP-T-0.7 never edits app.ts. SHP-T-0.7 replaces it.
/** Mounted at `/api`; serves `GET /api/openapi.json`. */
export function openapiRouter(): Router {
  return Router();
}
