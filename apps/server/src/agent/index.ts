import { Router } from 'express';
import type { ServiceDeps } from '../deps.js';
import { mountEnrol } from './enrol.js';
import { mountPoll } from './poll.js';
import { mountReport } from '../apps/report.js';

/**
 * The agent protocol under /api/agent (SHP-D-064). Every route here is called by the agent only,
 * signed with its Ed25519 key; the server never calls the agent (SHP-REQ-033). Each task owns its
 * own module; this file only composes them (SHP-P-2 pre-flight, lead-owned).
 */
export function agentRouter(deps: ServiceDeps): Router {
  const router = Router();
  mountEnrol(router, deps); // SHP-T-2.2 — POST /enrol, and the console's confirm/list
  mountReport(router, deps); // SHP-T-2.3 — POST /report
  mountPoll(router, deps); // SHP-T-2.4 — POST /poll, /steps, /targets/:id/result
  return router;
}
