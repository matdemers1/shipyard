import { refusal, type MaintenanceJob, type MaintenanceProgress, type MaintenanceResult, type MaintenanceStep } from '@shipyard/schema';
import type { MaintenanceRecovery } from '@shipyard/sequence';
import type { AgentClient } from './client.js';
import { DEFAULT_BACKOFF, abortableSleep, isPermanent, nextDelay, type Backoff, type LoopLog, type Sleep } from './loop.js';

/**
 * The agent's side of volume backups, restores, orphan deletes and prunes (SHP-ADR-012,
 * SHP-T-17.2; SHP-REQ-201..206). A job arrives on a poll as `{ target: null, maintenance }`, only
 * when the agent advertised `maintenance`; it runs in the background so the loop keeps polling, one
 * at a time on the host — a second is refused `conflict`, never queued. The engine
 * (`runMaintenance` in the sequence package) journals each step before it runs; this posts each
 * step to `/api/agent/maintenance/:id/progress` as it starts, off the engine's path, and the result
 * to `/api/agent/maintenance/:id/result` until the server takes it, with the same backoff as
 * actions.
 */

export function maintenanceProgressPath(jobId: string): string {
  return `/api/agent/maintenance/${jobId}/progress`;
}

export function maintenanceResultPath(jobId: string): string {
  return `/api/agent/maintenance/${jobId}/result`;
}

export interface MaintenanceRunnerOptions {
  client: AgentClient;
  /** Runs one job through the engine; `onStep` is called as each step starts. Should not throw. */
  execute: (job: MaintenanceJob, onStep: (step: MaintenanceStep) => void) => Promise<MaintenanceResult>;
  /** Called once a job has finished, whatever its result (the agent reports its archives at once). */
  onFinished?: (job: MaintenanceJob, result: MaintenanceResult) => void;
  log: LoopLog;
  /** Aborting stops retrying an undelivered result. */
  signal?: AbortSignal;
  sleep?: Sleep;
  backoff?: Backoff;
}

export interface MaintenanceRunner {
  /** Runs the job in the background; the loop keeps polling. */
  offer(job: MaintenanceJob): void;
  /** Runs the job (or refuses it while another runs), delivers its result, and resolves with it. */
  run(job: MaintenanceJob): Promise<MaintenanceResult>;
  busy(): boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Posts a result until the server takes it, refuses it, or the agent stops. */
async function deliverResult(opts: Pick<MaintenanceRunnerOptions, 'client' | 'log' | 'signal' | 'sleep' | 'backoff'>, result: MaintenanceResult): Promise<boolean> {
  const sleep = opts.sleep ?? abortableSleep;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  let delay = backoff.initialMs;
  for (;;) {
    try {
      await opts.client.request('POST', maintenanceResultPath(result.jobId), result);
      opts.log.info({ jobId: result.jobId, state: result.state, refusal: result.refusal?.code }, 'maintenance result reported');
      return true;
    } catch (err) {
      if (isPermanent(err)) {
        opts.log.warn({ jobId: result.jobId, err: message(err) }, 'server refused the maintenance result; dropping it');
        return true;
      }
      if (opts.signal?.aborted === true) {
        opts.log.warn({ jobId: result.jobId }, 'stopping with the maintenance result unreported');
        return false;
      }
      opts.log.warn({ jobId: result.jobId, err: message(err), retryInMs: delay }, 'maintenance result not delivered; retrying');
      await sleep(delay, opts.signal);
      delay = nextDelay(delay, backoff);
    }
  }
}

export function createMaintenanceRunner(opts: MaintenanceRunnerOptions): MaintenanceRunner {
  const { client, log } = opts;
  let current: string | null = null;

  const run = async (job: MaintenanceJob): Promise<MaintenanceResult> => {
    // Decided before the first await, so two jobs offered back to back cannot both start.
    if (current !== null) {
      const busy: MaintenanceResult = {
        jobId: job.jobId,
        state: 'refused',
        refusal: refusal('conflict', 'Another volume or prune job is running on this host.', 'Wait for it to finish, then ask again.'),
      };
      await deliverResult(opts, busy);
      return busy;
    }
    current = job.jobId;
    log.info({ jobId: job.jobId, kind: job.kind }, 'maintenance job received');

    // Progress goes out in order, off the engine's path: a slow or absent server never holds it up.
    let chain: Promise<void> = Promise.resolve();
    let warned = false;
    const onStep = (step: MaintenanceStep): void => {
      const progress: MaintenanceProgress = { jobId: job.jobId, step };
      chain = chain
        .then(() => client.request('POST', maintenanceProgressPath(job.jobId), progress))
        .then(() => undefined)
        .catch((err: unknown) => {
          if (!warned && !isPermanent(err)) log.warn({ jobId: job.jobId, err: message(err) }, 'could not report maintenance progress; carrying on');
          warned = true;
        });
    };

    let result: MaintenanceResult;
    try {
      result = await opts.execute(job, onStep);
    } catch (err) {
      log.error({ jobId: job.jobId, err: message(err) }, 'maintenance runner failed');
      result = { jobId: job.jobId, state: 'failed', refusal: refusal('step_failed', `The agent could not run this ${job.kind}: ${message(err)}`) };
    } finally {
      current = null;
    }
    await chain;
    try {
      opts.onFinished?.(job, result);
    } catch (err) {
      log.warn({ jobId: job.jobId, err: message(err) }, 'onFinished threw; ignoring');
    }
    await deliverResult(opts, result);
    return result;
  };

  return {
    offer: (job) => void run(job),
    run,
    busy: () => current !== null,
  };
}

/**
 * After a restart: every job `recoverInterruptedMaintenance` found open — whose stopped project it
 * has already started again — is reported `failed` with `interrupted` and then closed. A job inside
 * a stack update is not one the server knows, so it is only closed. One the server cannot be told
 * about now stays open for the next start; one it refuses (it already has a result) is closed.
 */
export async function reportInterruptedMaintenance(opts: {
  client: AgentClient;
  recovered: MaintenanceRecovery[];
  close: (recovery: MaintenanceRecovery) => Promise<void>;
  log: LoopLog;
}): Promise<void> {
  for (const r of opts.recovered) {
    if (r.report) {
      const restarted = r.restarted
        ? r.startExitCode === 0
          ? ` Its containers had been stopped for it and were started again.`
          : ` Its containers had been stopped for it, and starting them again failed (exit ${String(r.startExitCode)}).`
        : '';
      const safety = r.kind === 'volume-restore' && r.archives.length > 0 ? ` What the volume held before is in archive ${r.archives.join(', ')}.` : '';
      const result: MaintenanceResult = {
        jobId: r.jobId,
        state: 'failed',
        refusal: refusal(
          'interrupted',
          `The agent restarted during this ${r.kind} of ${r.name}.${restarted}${safety}`,
          r.kind === 'volume-restore' ? `The volume may be partly restored; check ${r.name}, then restore again.` : `Check ${r.name} on the Host view, then run it again if it is still needed.`,
        ),
      };
      try {
        await opts.client.request('POST', maintenanceResultPath(r.jobId), result);
      } catch (err) {
        if (!isPermanent(err)) {
          opts.log.warn({ jobId: r.jobId, err: message(err) }, 'could not report an interrupted maintenance job; keeping it for the next start');
          continue;
        }
      }
    }
    try {
      await opts.close(r);
    } catch (err) {
      opts.log.warn({ jobId: r.jobId, err: message(err) }, 'could not close an interrupted maintenance job in the journal');
      continue;
    }
    opts.log.warn({ jobId: r.jobId, kind: r.kind, name: r.name, restarted: r.restarted }, 'reported a maintenance job interrupted by a restart');
  }
}
