import type { ServiceDeps } from '../deps.js';
import { SCHEDULER_INTERVAL_MS, fireDueSchedules } from './service.js';

export interface SchedulerOptions {
  /** How often to look for due schedules; tests shorten it. */
  intervalMs?: number;
  /** The clock; tests move it. */
  now?: () => Date;
}

/**
 * Fires due schedules (SHP-T-5.4, SHP-REQ-080): once at start, then every 15 s, with every gate
 * re-run at fire time. Sweeps never overlap; `stop()` waits for one in flight.
 */
export function startScheduler(deps: ServiceDeps, options: SchedulerOptions = {}): { stop: () => Promise<void> } {
  const intervalMs = options.intervalMs ?? SCHEDULER_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let running = false;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = (): void => {
    if (stopped || running) return;
    running = true;
    inFlight = fireDueSchedules(deps, now())
      .then(() => undefined)
      .catch((err: unknown) => {
        deps.logger.error({ err }, 'scheduler sweep failed');
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, intervalMs);
  tick();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
