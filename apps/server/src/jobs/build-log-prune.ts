import type { ServiceDeps } from '../deps.js';

/** Build logs are kept this long after their build ends (SHP-REQ-141). */
export const BUILD_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How often `startBuildLogPrune` runs. */
export const BUILD_LOG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Deletes the logs of every build that ended more than 30 days before `now` (SHP-REQ-141). A
 * build that has not ended — queued or running — has no `endedAt` and keeps its logs. The build
 * row and its stages stay: only the log text goes. Returns how many chunks were deleted.
 */
export async function pruneBuildLogs(deps: Pick<ServiceDeps, 'db' | 'logger'>, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - BUILD_LOG_RETENTION_MS);
  const { count } = await deps.db.buildLog.deleteMany({ where: { build: { endedAt: { lt: cutoff } } } });
  if (count > 0) deps.logger.info({ count, cutoff: cutoff.toISOString() }, 'build logs pruned');
  return count;
}

/** Starts the hourly build-log prune; the stopper waits for a run in flight. */
export function startBuildLogPrune(
  deps: Pick<ServiceDeps, 'db' | 'logger'>,
  intervalMs = BUILD_LOG_PRUNE_INTERVAL_MS,
): { stop: () => Promise<void> } {
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  const tick = (): void => {
    inFlight = pruneBuildLogs(deps).catch((err: unknown) => {
      deps.logger.error({ err }, 'build log prune failed');
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
