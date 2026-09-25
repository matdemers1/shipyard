import type { Router } from 'express';
import type { ServiceDeps } from '../deps.js';

// Stub (SHP-P-2 pre-flight). SHP-T-2.3 replaces it: POST /api/agent/report.
export function mountReport(_router: Router, _deps: ServiceDeps): void {
  // nothing yet
}
