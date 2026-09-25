import type { ServiceDeps } from '../deps.js';

/** Fires due schedules (SHP-T-5.4). A stub until that task fills it. */
export function startScheduler(_deps: ServiceDeps): { stop: () => Promise<void> } {
  return { stop: () => Promise.resolve() };
}
