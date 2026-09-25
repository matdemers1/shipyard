import type { ServiceDeps } from '../deps.js';
import type { Mailer } from '../mail/index.js';

/** Starts the nightly pg_dump (client 16) and the restore drill (SHP-T-6.3). A stub until that task fills it. */
export function startBackups(_deps: ServiceDeps, _mailer: Mailer): { stop: () => Promise<void> } {
  return { stop: () => Promise.resolve() };
}
