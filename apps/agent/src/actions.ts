import { refusal, type ActionJob, type ActionProgress, type ActionResult, type LifecycleVerb, type Refusal } from '@shipyard/schema';
import {
  ACTION_STEP,
  ManifestLoadError,
  createRedactor,
  loadSecrets,
  redactionValues,
  type Clock,
  type ComposeTarget,
  type DockerPort,
  type FsPort,
  type Journal,
  type LoadedManifests,
  type LoadedStacks,
  type RunningContainer,
} from '@shipyard/sequence';
import type { AgentClient } from './client.js';
import { DEFAULT_BACKOFF, abortableSleep, isPermanent, nextDelay, type Backoff, type LoopLog, type Sleep } from './loop.js';

/**
 * Lifecycle actions (SHP-T-15.3; SHP-ADR-010, SHP-REQ-184, SHP-REQ-187): start, stop, restart or
 * recreate a service — or a whole compose project — of a Deployed app or an Operated stack.
 *
 * What reaches the host is a target name, a verb from a fixed enum and an optional service name.
 * The agent checks each against its own host-local manifests and the compose project before it
 * acts: the app or stack must exist, the service must be one of the project's, and no deploy of
 * that app may be in flight. Then it journals the action (SHP-D-029), runs the pinned compose CLI
 * with explicit `-f`/`-p` and an argv built here from the verb — never a command string — waits
 * for the affected containers to be running (and healthy, where they have a healthcheck), and
 * posts the result with compose's output redacted.
 *
 * `recreate` is `up -d --force-recreate --no-deps --no-build --pull never [service]`: it recreates
 * from the image the compose file already names, never pulls, and never touches the image line —
 * changing an image is a deploy.
 *
 * Crash recovery: an action is not resumed or redone. On restart, every action whose journal
 * `start` line has no `end` is reported `failed` (`interrupted`) and its journal bracket closed
 * (`reportInterruptedActions`); deploy recovery ignores action lines.
 */

export function actionProgressPath(actionId: string): string {
  return `/api/agent/actions/${actionId}/progress`;
}

export function actionResultPath(actionId: string): string {
  return `/api/agent/actions/${actionId}/result`;
}

/** How long start, restart and recreate wait for running/healthy (SHP-REQ-184). */
export const ACTION_WAIT_MS = 60_000;
/** How often the wait looks at the containers. */
export const ACTION_POLL_MS = 1_000;
/** The compose invocation itself; `stop` waits up to ten seconds per container before killing. */
export const ACTION_COMPOSE_TIMEOUT_MS = 180_000;
/** `ActionResult.output` is capped at 16 KiB; the end of compose's output is what explains a failure. */
export const MAX_ACTION_OUTPUT = 16_384;
/** The journal keeps the last lines of the output, as it does for a deploy step. */
const JOURNAL_OUTPUT_LINES = 50;

/** The compose arguments for a verb, after `-f … -p …`. Never anything else. */
export function actionArgv(verb: LifecycleVerb, service?: string): string[] {
  const svc = service === undefined ? [] : [service];
  switch (verb) {
    case 'start':
      return ['start', ...svc];
    case 'stop':
      return ['stop', ...svc];
    case 'restart':
      return ['restart', ...svc];
    case 'recreate':
      return ['up', '-d', '--force-recreate', '--no-deps', '--no-build', '--pull', 'never', ...svc];
  }
}

/** A deploy lock taken for the action's duration, so a deploy cannot start under it. */
export interface HeldLock {
  release(): Promise<void>;
}

export interface ActionRunnerOptions {
  client: AgentClient;
  docker: DockerPort;
  fs: FsPort;
  journal: Pick<Journal, 'begin' | 'end'>;
  clock: Clock;
  /** The host's app manifests, loaded afresh for each action. */
  apps: () => Promise<LoadedManifests>;
  /** The host's adopted stacks, loaded afresh for each action. */
  stacks: () => Promise<LoadedStacks>;
  /** True while a deploy, rollback or restore of `app` runs here (the agent's or the host CLI's). */
  deployInFlight: (app: string) => boolean | Promise<boolean>;
  /**
   * Takes `app`'s deploy lock for the action, or says who holds it. Absent: no lock is taken and
   * `deployInFlight` alone guards the app.
   */
  lockApp?: (app: string, job: ActionJob) => Promise<HeldLock | Refusal>;
  log: LoopLog;
  waitMs?: number;
  pollMs?: number;
  composeTimeoutMs?: number;
  /** Aborting stops retrying an undelivered result. */
  signal?: AbortSignal;
  sleep?: Sleep;
  backoff?: Backoff;
}

export interface ActionRunner {
  /** Runs the job in the background; the loop keeps polling. */
  offer(job: ActionJob): void;
  /** Runs the job (or refuses it while another runs) and delivers its result; resolves with it. */
  run(job: ActionJob): Promise<ActionResult>;
  busy(): boolean;
}

interface Resolved {
  compose: ComposeTarget;
  envFiles: string[] | undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function refused(job: ActionJob, why: Refusal, output?: string): ActionResult {
  return { actionId: job.actionId, state: 'refused', refusal: why, ...(output === undefined || output === '' ? {} : { output }) };
}

/** A name that compose would read as a flag must never reach it (non-negotiable 1). */
function flagLike(value: string): boolean {
  return value.startsWith('-');
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

function lastLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function describe(c: RunningContainer): string {
  const health = c.health === undefined || c.health === 'none' ? '' : `, ${c.health}`;
  return `${c.service === '' ? c.id.slice(0, 12) : c.service}: ${c.state}${health}`;
}

function ready(c: RunningContainer): boolean {
  return c.state === 'running' && (c.health === undefined || c.health === 'none' || c.health === 'healthy');
}

export function createActionRunner(opts: ActionRunnerOptions): ActionRunner {
  const { client, docker, fs, journal, clock, log } = opts;
  const waitMs = opts.waitMs ?? ACTION_WAIT_MS;
  const pollMs = opts.pollMs ?? ACTION_POLL_MS;
  const composeTimeoutMs = opts.composeTimeoutMs ?? ACTION_COMPOSE_TIMEOUT_MS;
  const sleep = opts.sleep ?? abortableSleep;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  let running = false;

  /** The app or stack the job names, from the host's own files only (SHP-D-059). */
  const resolveTarget = async (job: ActionJob): Promise<Resolved | Refusal> => {
    const { kind, name } = job.target;
    let found: Resolved | undefined;
    if (kind === 'app') {
      const manifest = (await opts.apps()).get(name)?.manifest;
      if (manifest === undefined) return refusal('unknown_app', `No manifest for app ${name} on this host.`);
      found = { compose: manifest.compose, envFiles: manifest.envFiles };
    } else {
      const stack = (await opts.stacks()).get(name)?.manifest;
      if (stack === undefined) return refusal('not_adopted', `No stack named ${name} is adopted on this host.`);
      found = { compose: stack.compose, envFiles: stack.envFiles };
    }
    if (flagLike(found.compose.project) || found.compose.files.some(flagLike)) {
      return refusal('invalid_request', `The ${kind} ${name} names a compose project or file beginning with "-"; Shipyard will not pass it to compose.`);
    }
    return found;
  };

  /** Env values of the target's containers (or one service's), for redaction only. */
  const containerEnvValues = async (compose: ComposeTarget, service: string | undefined): Promise<string[]> => {
    const inspect = docker.inspectEnv?.bind(docker);
    if (inspect === undefined) return [];
    const values: string[] = [];
    for (const c of await docker.containers(compose, service)) {
      const facts = await inspect(c.id).catch(() => null);
      if (facts !== null) values.push(...facts.envValues);
    }
    return values;
  };

  const waitReady = async (compose: ComposeTarget, service: string | undefined): Promise<string | null> => {
    const deadline = clock.now().getTime() + waitMs;
    for (;;) {
      const found = await docker.containers(compose, service);
      const notReady = found.filter((c) => !ready(c));
      if (found.length > 0 && notReady.length === 0) return null;
      if (clock.now().getTime() >= deadline) {
        const what = found.length === 0 ? 'no containers were found' : notReady.map(describe).join('; ');
        return `Not running${notReady.some((c) => c.health !== undefined && c.health !== 'none') ? ' and healthy' : ''} within ${String(Math.round(waitMs / 1000))} s: ${what}.`;
      }
      await clock.sleep(pollMs);
    }
  };

  const execute = async (job: ActionJob): Promise<ActionResult> => {
    const { kind, name } = job.target;
    const ids = { actionId: job.actionId, target: `${kind}/${name}`, verb: job.verb, service: job.service ?? null };
    log.info(ids, 'action received');

    if (job.service !== undefined && flagLike(job.service)) {
      return refused(job, refusal('invalid_request', `The service name ${job.service} begins with "-".`));
    }

    let resolved: Resolved | Refusal;
    try {
      resolved = await resolveTarget(job);
    } catch (err) {
      if (err instanceof ManifestLoadError) return refused(job, err.toRefusal());
      return refused(job, refusal('manifest_invalid', `The host's manifests could not be read: ${message(err)}`));
    }
    if ('code' in resolved) return refused(job, resolved);
    const { compose } = resolved;

    // The server checks this too; the agent is the last line (SHP-REQ-184).
    if (kind === 'app' && (await opts.deployInFlight(name))) {
      return refused(job, refusal('locked', `A deploy of ${name} is running on this host; the ${job.verb} was not run.`));
    }

    let secrets: Map<string, string>;
    try {
      secrets = await loadSecrets(fs, resolved.envFiles);
    } catch (err) {
      // Without the env file its values cannot be redacted, so nothing is run (SHP-REQ-190).
      return refused(job, refusal('manifest_invalid', `The ${kind} ${name}: ${message(err)}`));
    }

    // The service must be one of the project's, as compose itself reads the files.
    const config = await docker.compose(compose, ['config', '--services'], { timeoutMs: 30_000 });
    const services = new Set(
      config.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    if (config.exitCode !== 0) {
      const redactor = createRedactor(redactionValues(secrets, []));
      return refused(
        job,
        refusal('action_failed', `compose could not read the ${kind} ${name}'s project (exit ${String(config.exitCode)}).`),
        tail(redactor(`${config.stdout}${config.stderr}`), MAX_ACTION_OUTPUT),
      );
    }
    if (job.service !== undefined && !services.has(job.service)) {
      return refused(job, refusal('invalid_request', `${job.service} is not a service of the ${kind} ${name}'s compose project.`));
    }

    const envBefore = await containerEnvValues(compose, job.service).catch(() => []);

    let lock: HeldLock | undefined;
    if (kind === 'app' && opts.lockApp !== undefined) {
      const held = await opts.lockApp(name, job);
      if ('code' in held) return refused(job, held);
      lock = held;
    }

    const argv = actionArgv(job.verb, job.service);
    let journaled = false;
    let result: ActionResult;
    let output = '';
    let exitCode: number | undefined;
    try {
      // Journal first, always (SHP-REQ-187, SHP-D-029): if this line cannot be written, nothing runs.
      await journal.begin({
        deployId: job.actionId,
        app: name,
        step: ACTION_STEP,
        argv,
        detail: { kind: 'action', target: kind, verb: job.verb, service: job.service ?? null, requester: job.requesterLabel ?? null },
      });
      journaled = true;

      const progress: ActionProgress = { actionId: job.actionId, state: 'running' };
      await client.request('POST', actionProgressPath(job.actionId), progress).catch((err: unknown) => {
        log.warn({ ...ids, err: message(err) }, 'could not report the action running; carrying on');
      });

      const res = await docker.compose(compose, argv, { timeoutMs: composeTimeoutMs });
      exitCode = res.exitCode;
      output = `${res.stdout}${res.stderr}`;
      if (res.exitCode !== 0) {
        result = { actionId: job.actionId, state: 'failed', refusal: refusal('action_failed', `compose ${job.verb} exited ${String(res.exitCode)}.`) };
      } else if (job.verb === 'stop') {
        result = { actionId: job.actionId, state: 'succeeded' };
      } else {
        const notReady = await waitReady(compose, job.service);
        result =
          notReady === null
            ? { actionId: job.actionId, state: 'succeeded' }
            : { actionId: job.actionId, state: 'failed', refusal: refusal('action_failed', notReady) };
      }
    } catch (err) {
      result = {
        actionId: job.actionId,
        state: 'failed',
        refusal: refusal('action_failed', journaled ? `The ${job.verb} failed: ${message(err)}` : `The action could not be journaled, so it was not run: ${message(err)}`),
      };
    }

    try {
      // A recreate made new containers: their Env is read again, beside what was read before.
      const envAfter = await containerEnvValues(compose, job.service).catch(() => []);
      const redactor = createRedactor(redactionValues(secrets, [...envBefore, ...envAfter]));
      const redacted = tail(redactor(output), MAX_ACTION_OUTPUT);
      if (redacted.length > 0) result.output = redacted;
      if (journaled) {
        await journal
          .end({
            deployId: job.actionId,
            app: name,
            step: ACTION_STEP,
            argv,
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(redacted.length > 0 ? { output: lastLines(redacted, JOURNAL_OUTPUT_LINES) } : {}),
            detail: { kind: 'action', state: result.state, ...(result.refusal === undefined ? {} : { code: result.refusal.code }) },
          })
          .catch((err: unknown) => {
            log.error({ ...ids, err: message(err) }, 'could not journal the end of the action');
          });
      }
    } finally {
      await lock?.release().catch((err: unknown) => {
        log.warn({ ...ids, err: message(err) }, 'could not release the deploy lock; it goes stale in a minute');
      });
    }
    return result;
  };

  /** Posts the result until the server takes it, refuses it, or the agent stops. */
  const deliver = async (result: ActionResult): Promise<void> => {
    let delay = backoff.initialMs;
    for (;;) {
      try {
        await client.request('POST', actionResultPath(result.actionId), result);
        log.info({ actionId: result.actionId, state: result.state, refusal: result.refusal?.code }, 'action result reported');
        return;
      } catch (err) {
        if (isPermanent(err)) {
          log.warn({ actionId: result.actionId, err: message(err) }, 'server refused the action result; dropping it');
          return;
        }
        if (opts.signal?.aborted === true) {
          log.warn({ actionId: result.actionId }, 'stopping with the action result unreported');
          return;
        }
        log.warn({ actionId: result.actionId, err: message(err), retryInMs: delay }, 'action result not delivered; retrying');
        await sleep(delay, opts.signal);
        delay = nextDelay(delay, backoff);
      }
    }
  };

  const run = async (job: ActionJob): Promise<ActionResult> => {
    // Decided before the first await, so two jobs offered back to back cannot both start.
    if (running) {
      const busy = refused(job, refusal('conflict', 'Another lifecycle action is running on this host.', 'Wait for it to finish, then run this one again.'));
      await deliver(busy);
      return busy;
    }
    running = true;
    let result: ActionResult;
    try {
      result = await execute(job);
    } catch (err) {
      log.error({ actionId: job.actionId, err: message(err) }, 'action runner failed');
      result = { actionId: job.actionId, state: 'failed', refusal: refusal('action_failed', `The agent could not run this action: ${message(err)}`) };
    } finally {
      running = false;
    }
    await deliver(result);
    return result;
  };

  return {
    offer: (job) => void run(job),
    run,
    busy: () => running,
  };
}

// ─── After a restart ─────────────────────────────────────────────────────────

export interface InterruptedActionOptions {
  client: AgentClient;
  journal: Pick<Journal, 'unfinishedActions' | 'end'>;
  log: LoopLog;
}

/**
 * Reports every action a previous run started and never finished as `failed`/`interrupted`, and
 * closes its journal bracket. The action is not redone: what compose did before the crash is
 * whatever the containers now show. One the server cannot be told about now stays open for the
 * next start; one it refuses (it already has a result) is closed.
 */
export async function reportInterruptedActions(opts: InterruptedActionOptions): Promise<void> {
  for (const action of await opts.journal.unfinishedActions()) {
    const verb = typeof action.detail?.['verb'] === 'string' ? action.detail['verb'] : 'action';
    const result: ActionResult = {
      actionId: action.actionId,
      state: 'failed',
      refusal: refusal(
        'interrupted',
        `The agent restarted during this ${verb} of ${action.name}.`,
        `Check ${action.name}'s containers on the Host view, then run the action again if it is still needed.`,
      ),
    };
    try {
      await opts.client.request('POST', actionResultPath(action.actionId), result);
    } catch (err) {
      if (!isPermanent(err)) {
        opts.log.warn({ actionId: action.actionId, err: message(err) }, 'could not report an interrupted action; keeping it for the next start');
        continue;
      }
    }
    await opts.journal.end({ deployId: action.actionId, app: action.name, step: ACTION_STEP, detail: { kind: 'action', state: 'failed', interrupted: true } });
    opts.log.warn({ actionId: action.actionId, name: action.name, verb }, 'reported an action interrupted by a restart');
  }
}
