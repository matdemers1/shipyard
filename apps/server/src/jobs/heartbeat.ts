import type { ServiceDeps } from '../deps.js';
import type { Mailer } from '../mail/index.js';

/** Starts the agent staleness alerts (SHP-T-6.4). A stub until that task fills it. */
export function startHeartbeat(_deps: ServiceDeps, _mailer: Mailer): { stop: () => Promise<void> } {
  return { stop: () => Promise.resolve() };
}
