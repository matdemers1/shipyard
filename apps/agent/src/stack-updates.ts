import { refusal, type StackUpdateJob, type StackUpdateProgress, type StackUpdateResult, type StackUpdateStep } from '@shipyard/schema';
import type { StackRecoveryResult } from '@shipyard/sequence';
import type { AgentClient } from './client.js';
import { DEFAULT_BACKOFF, abortableSleep, isPermanent, nextDelay, type Backoff, type LoopLog, type Sleep } from './loop.js';

/**
 * The agent's side of stack updates (SHP-ADR-010, SHP-REQ-194..198). A job arrives on a poll as
 * `{ target: null, stackUpdate }`, only when the agent advertised `stack-updates`; it runs in the
 * background so the loop keeps polling, one at a time on the host — a second is refused
 * `conflict`, never queued. The engine (`runStackUpdate` in the sequence package) does the work and
 * journals each step before it runs; this posts each step to
 * `/api/agent/stack-updates/:id/progress` as it starts, off the engine's path, and the result to
 * `/api/agent/stack-updates/:id/result` until the server takes it.
 */

export function stackUpdateProgressPath(updateId: string): string {
  return `/api/agent/stack-updates/${updateId}/progress`;
}

export function stackUpdateResultPath(updateId: string): string {
  return `/api/agent/stack-updates/${updateId}/result`;
}

export interface StackUpdateRunnerOptions {
  client: AgentClient;
  /** Runs one job through the engine; `onStep` is called as each step starts. Should not throw. */
  execute: (job: StackUpdateJob, onStep: (step: StackUpdateStep) => void) => Promise<StackUpdateResult>;
  /** Called once a job has finished, whatever its result (the candidate checker re-checks the stack). */
  onFinished?: (job: StackUpdateJob, result: StackUpdateResult) => void;
  log: LoopLog;
  /** Aborting stops retrying an undelivered result. */
  signal?: AbortSignal;
  sleep?: Sleep;
  backoff?: Backoff;
}

export interface StackUpdateRunner {
  /** Runs the job in the background; the loop keeps polling. */
  offer(job: StackUpdateJob): void;
  /** Runs the job (or refuses it while another runs), delivers its result, and resolves with it. */
  run(job: StackUpdateJob): Promise<StackUpdateResult>;
  busy(): boolean;
  /** True while an update or rollback of `stack` runs here: a lifecycle action on it is refused. */
  inFlightFor(stack: string): boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createStackUpdateRunner(opts: StackUpdateRunnerOptions): StackUpdateRunner {
  const { client, log } = opts;
  const sleep = opts.sleep ?? abortableSleep;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  let current: string | null = null;

  const deliver = async (result: StackUpdateResult): Promise<void> => {
    let delay = backoff.initialMs;
    for (;;) {
      try {
        await client.request('POST', stackUpdateResultPath(result.updateId), result);
        log.info({ updateId: result.updateId, state: result.state, refusal: result.refusal?.code }, 'stack update result reported');
        return;
      } catch (err) {
        if (isPermanent(err)) {
          log.warn({ updateId: result.updateId, err: message(err) }, 'server refused the stack update result; dropping it');
          return;
        }
        if (opts.signal?.aborted === true) {
          log.warn({ updateId: result.updateId }, 'stopping with the stack update result unreported');
          return;
        }
        log.warn({ updateId: result.updateId, err: message(err), retryInMs: delay }, 'stack update result not delivered; retrying');
        await sleep(delay, opts.signal);
        delay = nextDelay(delay, backoff);
      }
    }
  };

  const run = async (job: StackUpdateJob): Promise<StackUpdateResult> => {
    // Decided before the first await, so two jobs offered back to back cannot both start.
    if (current !== null) {
      const busy: StackUpdateResult = {
        updateId: job.updateId,
        state: 'refused',
        images: [],
        previous: [],
        refusal: refusal('conflict', 'Another stack update is running on this host.', 'Wait for it to finish, then ask again.'),
      };
      await deliver(busy);
      return busy;
    }
    current = job.stack;
    log.info({ updateId: job.updateId, stack: job.stack, kind: job.kind }, 'stack update received');

    // Progress goes out in order, off the engine's path: a slow or absent server never holds it up.
    let chain: Promise<void> = Promise.resolve();
    let warned = false;
    const onStep = (step: StackUpdateStep): void => {
      const progress: StackUpdateProgress = { updateId: job.updateId, step };
      chain = chain
        .then(() => client.request('POST', stackUpdateProgressPath(job.updateId), progress))
        .then(() => undefined)
        .catch((err: unknown) => {
          if (!warned && !isPermanent(err)) log.warn({ updateId: job.updateId, err: message(err) }, 'could not report stack update progress; carrying on');
          warned = true;
        });
    };

    let result: StackUpdateResult;
    try {
      result = await opts.execute(job, onStep);
    } catch (err) {
      log.error({ updateId: job.updateId, err: message(err) }, 'stack update runner failed');
      result = { updateId: job.updateId, state: 'failed', images: [], previous: [], refusal: refusal('step_failed', `The agent could not run this stack update: ${message(err)}`) };
    } finally {
      current = null;
    }
    await chain;
    try {
      opts.onFinished?.(job, result);
    } catch (err) {
      log.warn({ updateId: job.updateId, err: message(err) }, 'onFinished threw; ignoring');
    }
    await deliver(result);
    return result;
  };

  return {
    offer: (job) => void run(job),
    run,
    busy: () => current !== null,
    inFlightFor: (stack) => current === stack,
  };
}

/**
 * After a restart (SHP-REQ-022's rule for stacks): every stack update the previous run left
 * unfinished has been put back by `recoverInterruptedStackUpdates`; this tells the server, `failed`
 * with `interrupted` — or `succeeded` with the ledger's images, when it had in fact finished.
 * A result the server cannot be told now is logged; its own sweep fails an update that never
 * reports.
 */
export async function reportInterruptedStackUpdates(opts: {
  client: AgentClient;
  recovered: StackRecoveryResult[];
  /** The ledger's record of an update that succeeded before the restart. */
  succeeded?: (stack: string, updateId: string) => Pick<StackUpdateResult, 'images' | 'previous'> | null;
  log: LoopLog;
}): Promise<void> {
  for (const r of opts.recovered) {
    const done = r.succeeded ? (opts.succeeded?.(r.stack, r.updateId) ?? null) : null;
    const result: StackUpdateResult =
      done !== null
        ? { updateId: r.updateId, state: 'succeeded', ...done }
        : {
            updateId: r.updateId,
            state: 'failed',
            images: [],
            previous: [],
            refusal: refusal(
              'interrupted',
              // A recovery that failed — a compose up that exited non-zero — says so (SHP-REQ-198).
              (r.restored.length > 0
                ? `The agent restarted during this update of ${r.stack}; its previous compose file was put back.`
                : `The agent restarted during this update of ${r.stack}, before anything changed.`) +
                (r.error === undefined ? '' : ` Recovering it failed: ${r.error}.`),
              `Check ${r.stack} on the Host view, then update again if it is still needed.`,
            ),
          };
    try {
      await opts.client.request('POST', stackUpdateResultPath(r.updateId), result);
      opts.log.warn({ updateId: r.updateId, stack: r.stack, state: result.state }, 'reported a stack update interrupted by a restart');
    } catch (err) {
      opts.log.warn({ updateId: r.updateId, err: message(err) }, 'could not report an interrupted stack update');
    }
  }
}
