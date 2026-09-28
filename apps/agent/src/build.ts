import type { KeyObject } from 'node:crypto';
import { refusal, type BuildJob, type BuildProgress, type BuildResult, type BuildStage, type Manifest, type Refusal } from '@shipyard/schema';
import {
  RefusalError,
  appendBuildRecord,
  createIntegrationStage,
  loadSecrets,
  readBuildSecrets,
  redact,
  runBuildStages,
  verifyBuildNetwork,
  withBuildSource,
  type BuildKitPort,
  type Clock,
  type DockerPort,
  type FsPort,
  type GitHubPort,
  type Log,
  type StageProgress,
} from '@shipyard/sequence';
import type { AgentClient } from './client.js';
import { DEFAULT_BACKOFF, abortableSleep, isPermanent, nextDelay, type Backoff, type Sleep } from './loop.js';

/**
 * The agent's build worker (SHP-T-7.9; SHP-REQ-125, SHP-REQ-129, SHP-REQ-130, SHP-REQ-140).
 *
 * - **One slot** (SHP-REQ-129): `offer` starts a build in the background only when none is
 *   running; a second offer is ignored and logged. The loop advertises `capabilities: ['build']`
 *   only while the worker is idle, and the server hands out one build at a time besides.
 * - **Deploys first** (SHP-REQ-130): before every stage boundary the worker waits while a deploy
 *   is in flight on the host (the loop running a target, or any live app lock — which catches a
 *   host-CLI deploy), heartbeating all the while, so no new stage starts during a deploy.
 * - **Redacted progress** (SHP-REQ-140): every log chunk sent to the server has passed through
 *   `redact` against both the build secrets and the manifest's envFiles values, and is capped at
 *   64 KiB, before it leaves the host.
 * - **Build secrets** (SHP-REQ-125) are read from the encrypted store on this host
 *   (`<dataRoot>/agent/build-secrets.json`, sealed with a key derived from the agent's own key) and
 *   handed to BuildKit as secret mounts by `runBuildStages`. Never logged, never sent.
 * - **Journal first**: a JSONL line is appended to `<dataRoot>/agent/builds.log` before each stage
 *   runs and when the build ends, so a crash leaves a trace on the host.
 * - **Heartbeat**: a progress report (the current stage, `running`, no log) every
 *   `BUILD_HEARTBEAT_MS`, so the server's stale sweep (30 minutes of silence) never takes a live
 *   build for a dead one.
 *
 * The only data taken from the server is the job's build ID, app name and 40-hex SHA; the app must
 * be in this host's own manifests (`withBuildSource` refuses otherwise).
 */

export const BUILD_PROGRESS_PATH = '/api/agent/build-progress';
export const BUILD_RESULT_PATH = '/api/agent/build-result';
/** How often a running build reports that it is still alive. */
export const BUILD_HEARTBEAT_MS = 60_000;
/** How often a stage held back for a deploy checks again. */
export const DEPLOY_WAIT_POLL_MS = 2_000;
/** `BuildProgress.log` is capped at 64 KiB; the tail is what matters. */
const MAX_LOG_CHARS = 65_536;

export function buildJournalPath(dataRoot: string): string {
  return `${dataRoot}/agent/builds.log`;
}

/** What the worker needs from Docker: the build network check and the integration stage. */
export type BuildDocker = Pick<DockerPort, 'compose' | 'removeImage' | 'loadImage' | 'inspectNetwork'>;

export interface BuildWorkerOptions {
  client: AgentClient;
  /** This host's manifests, reloaded for every build. */
  manifests: () => Promise<Map<string, Manifest>>;
  github: GitHubPort;
  buildkit: BuildKitPort;
  docker: BuildDocker;
  fs: FsPort;
  dataRoot: string;
  /** Scratch source and secret-file directories are made under here. */
  tmpDir: string;
  /** The agent's Ed25519 private key: the build-secret store's key is derived from it. */
  privateKey?: KeyObject;
  /** Reads an app's build secrets; defaults to the encrypted store under `dataRoot`. */
  readSecrets?: (app: string) => Promise<Map<string, string>>;
  /** True while a deploy is in flight on this host. */
  deployInFlight: () => boolean | Promise<boolean>;
  /**
   * Called once a build has ended, success or failure (SHP-T-7.11, SHP-REQ-132): the cache
   * manager's hook to garbage-collect the BuildKit cache after every build. Never awaited by the
   * caller's own delivery path — errors are the cache manager's problem, never the build's.
   */
  onBuildFinished?: () => void | Promise<void>;
  log: Log;
  clock: Pick<Clock, 'now'>;
  sleep?: Sleep;
  backoff?: Backoff;
  heartbeatMs?: number;
  deployWaitMs?: number;
  /** Test seams: the engine's build functions. */
  engine?: Partial<BuildEngine>;
}

export interface BuildEngine {
  withBuildSource: typeof withBuildSource;
  runBuildStages: typeof runBuildStages;
  verifyBuildNetwork: typeof verifyBuildNetwork;
  createIntegrationStage: typeof createIntegrationStage;
}

export interface BuildWorker {
  /** Starts `job` in the background. False (and ignored) when a build is already running. */
  offer(job: BuildJob): boolean;
  busy(): boolean;
  /** Resolves when no build is running. */
  idle(): Promise<void>;
  /** Stops at the next stage boundary (reported `cancelled`) and stops retrying the result. */
  stop(): void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A log whose `output` field is redacted again (envFile values) before pino ever sees it. */
function redactingLog(log: Log, clean: (text: string) => string): Log {
  const fix = (obj: object): object => {
    const output = (obj as { output?: unknown }).output;
    return typeof output === 'string' ? { ...obj, output: clean(output) } : obj;
  };
  return {
    info: (obj, msg) => {
      log.info(fix(obj), msg);
    },
    warn: (obj, msg) => {
      log.warn(fix(obj), msg);
    },
    error: (obj, msg) => {
      log.error(fix(obj), msg);
    },
    child: (bindings) => redactingLog(log.child(bindings), clean),
  };
}

export function createBuildWorker(opts: BuildWorkerOptions): BuildWorker {
  const sleep = opts.sleep ?? abortableSleep;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const heartbeatMs = opts.heartbeatMs ?? BUILD_HEARTBEAT_MS;
  const deployWaitMs = opts.deployWaitMs ?? DEPLOY_WAIT_POLL_MS;
  const engine: BuildEngine = {
    withBuildSource: opts.engine?.withBuildSource ?? withBuildSource,
    runBuildStages: opts.engine?.runBuildStages ?? runBuildStages,
    verifyBuildNetwork: opts.engine?.verifyBuildNetwork ?? verifyBuildNetwork,
    createIntegrationStage: opts.engine?.createIntegrationStage ?? createIntegrationStage,
  };
  const privateKey = opts.privateKey;
  const readSecrets =
    opts.readSecrets ??
    ((app: string): Promise<Map<string, string>> => {
      if (privateKey === undefined) return Promise.reject(new Error('the build worker has no agent key to open build secrets with'));
      return readBuildSecrets(opts.dataRoot, privateKey, app);
    });
  const stopping = new AbortController();
  let current: Promise<void> | null = null;

  async function journal(entry: Record<string, unknown>): Promise<void> {
    await opts.fs.mkdirp(`${opts.dataRoot}/agent`);
    await opts.fs.appendLine(buildJournalPath(opts.dataRoot), JSON.stringify({ at: opts.clock.now().toISOString(), ...entry }));
  }

  async function run(job: BuildJob): Promise<void> {
    const tag = { buildId: job.buildId, app: job.app, sha: job.sha };
    const log = opts.log.child(tag);
    log.info({ requester: job.requesterLabel }, 'build received');

    let buildSecrets = new Map<string, string>();
    let envSecrets = new Map<string, string>();
    const clean = (text: string): string => {
      const redacted = redact(redact(text, buildSecrets), envSecrets);
      return redacted.length > MAX_LOG_CHARS ? redacted.slice(-MAX_LOG_CHARS) : redacted;
    };

    let cancelRequested = false;
    const cancelStage = new AbortController();
    const requestCancel = (): void => {
      cancelRequested = true;
      cancelStage.abort();
    };
    const onStop = (): void => {
      requestCancel();
    };
    stopping.signal.addEventListener('abort', onStop, { once: true });
    if (stopping.signal.aborted) requestCancel();

    // Reports go out one at a time, in order; a failed one is logged, never fatal to the build.
    let chain: Promise<void> = Promise.resolve();
    let warned = false;
    let lastStage: BuildStage = 'fetch';
    const report = (stage: BuildStage, state: BuildProgress['state'], raw?: string): Promise<void> => {
      const body: BuildProgress = {
        buildId: job.buildId,
        stage,
        state,
        ...(raw === undefined || raw === '' ? {} : { log: clean(raw) }),
        at: opts.clock.now().toISOString(),
      };
      const next = chain.then(async () => {
        try {
          const res = (await opts.client.request('POST', BUILD_PROGRESS_PATH, body)) as { cancel?: unknown } | null;
          if (res?.cancel === true && !cancelRequested) {
            log.info({ stage }, 'the server asked for a cancel; stopping at the next stage boundary');
            requestCancel();
          }
        } catch (err) {
          if (isPermanent(err)) {
            // The server does not know this build as ours any more: stop at the next boundary.
            log.warn({ stage, err: message(err) }, 'server refused build progress; stopping the build');
            requestCancel();
            return;
          }
          if (!warned) log.warn({ stage, err: message(err) }, 'server unreachable mid-build; continuing');
          warned = true;
        }
      });
      chain = next;
      return next;
    };

    const heartbeat = setInterval(() => {
      void report(lastStage, 'running');
    }, heartbeatMs);
    heartbeat.unref();

    const onProgress = async (p: StageProgress): Promise<void> => {
      if (p.state === 'running') await journal({ ...tag, stage: p.stage, phase: 'start' });
      lastStage = p.stage;
      await report(p.stage, p.state, p.log);
    };

    /** Holds the next stage while a deploy is in flight (SHP-REQ-130); true to stop here. */
    const shouldCancel = async (): Promise<boolean> => {
      let held = false;
      while (!cancelRequested && (await opts.deployInFlight())) {
        if (!held) {
          log.info({ stage: lastStage }, 'a deploy is in flight on this host; holding the next build stage');
          await journal({ ...tag, stage: lastStage, phase: 'held', reason: 'deploy in flight' });
          held = true;
        }
        await sleep(deployWaitMs, stopping.signal);
      }
      if (held && !cancelRequested) log.info({}, 'the deploy has ended; the build continues');
      return cancelRequested;
    };

    let result: BuildResult;
    try {
      await journal({ ...tag, stage: 'fetch', phase: 'start' });
      await report('fetch', 'running');
      const manifests = await opts.manifests();
      let fetched = false;
      const stages = await engine.withBuildSource(
        { manifests, app: job.app, sha: job.sha, github: opts.github, scratchRoot: opts.tmpDir, log },
        async (dir, manifest) => {
          fetched = true;
          await report('fetch', 'succeeded');
          await engine.verifyBuildNetwork(opts.docker);
          buildSecrets = await readSecrets(job.app);
          // Redact with the app's runtime env values too (SHP-REQ-140): a test that echoes its env
          // must not carry a production value to the server. A missing env file fails closed.
          envSecrets = await loadSecrets(opts.fs, manifest.envFiles);
          const integration =
            manifest.build?.integration === undefined
              ? undefined
              : engine.createIntegrationStage({
                  docker: opts.docker,
                  buildkit: opts.buildkit,
                  dir,
                  manifest,
                  buildId: job.buildId,
                  sha: job.sha,
                  tmpDir: opts.tmpDir,
                  secrets: buildSecrets,
                  signal: cancelStage.signal,
                  log: redactingLog(log, clean),
                });
          return engine.runBuildStages({
            dir,
            manifest,
            sha: job.sha,
            buildkit: opts.buildkit,
            secrets: buildSecrets,
            tmpDir: opts.tmpDir,
            log: redactingLog(log, clean),
            onProgress,
            shouldCancel,
            ...(integration === undefined ? {} : { integration }),
          });
        },
      ).catch(async (err: unknown) => {
        if (!fetched) await report('fetch', 'failed', message(err));
        throw err;
      });
      result =
        stages.state === 'succeeded'
          ? { buildId: job.buildId, state: 'succeeded', digests: stages.digests }
          : {
              buildId: job.buildId,
              state: stages.state,
              digests: {},
              ...(stages.failedStage === undefined ? {} : { failedStage: stages.failedStage }),
            };
      if (result.state === 'succeeded') {
        // The agent-local record gate G5 reads for a Shipyard-built app (SHP-REQ-128).
        await appendBuildRecord(opts.fs, opts.dataRoot, {
          buildId: job.buildId,
          app: job.app,
          sha: job.sha,
          state: 'succeeded',
          digests: result.digests,
          at: opts.clock.now().toISOString(),
        });
      }
    } catch (err) {
      if (err instanceof RefusalError) {
        const why: Refusal = { ...err.refusal, message: clean(err.refusal.message), fix: clean(err.refusal.fix) };
        result = { buildId: job.buildId, state: 'refused', digests: {}, refusal: why };
      } else {
        log.error({ err: clean(message(err)) }, 'build failed before the stages could report');
        result = {
          buildId: job.buildId,
          state: 'failed',
          digests: {},
          refusal: refusal('step_failed', `The agent could not run this build: ${clean(message(err))}`),
          failedStage: lastStage,
        };
      }
    } finally {
      clearInterval(heartbeat);
      stopping.signal.removeEventListener('abort', onStop);
    }
    await chain;
    try {
      await journal({ ...tag, phase: 'result', state: result.state, ...(result.refusal === undefined ? {} : { refusal: result.refusal.code }) });
    } catch (err) {
      log.warn({ err: message(err) }, 'could not journal the build result');
    }
    log.info({ state: result.state, refusal: result.refusal?.code, failedStage: result.failedStage }, 'build finished');
    // The result first, so the console and an auto-deploy never wait on cache GC; the slot stays
    // taken until GC ends, so the next build does not start mid-prune (SHP-REQ-132).
    await deliver(result, log);
    if (opts.onBuildFinished !== undefined) {
      try {
        await opts.onBuildFinished();
      } catch (err) {
        log.warn({ err: message(err) }, 'onBuildFinished threw; ignoring');
      }
    }
  }

  /** Sends the result until the server takes it, refuses it, or the agent stops. */
  async function deliver(result: BuildResult, log: Log): Promise<void> {
    let delay = backoff.initialMs;
    for (;;) {
      try {
        const res = (await opts.client.request('POST', BUILD_RESULT_PATH, result)) as { accepted?: unknown } | null;
        if (res?.accepted === false) log.warn({ state: result.state }, 'the server had already ended this build; result not recorded');
        else log.info({ state: result.state }, 'build result reported');
        return;
      } catch (err) {
        if (isPermanent(err)) {
          log.warn({ err: message(err) }, 'server refused the build result; dropping it');
          return;
        }
        if (stopping.signal.aborted) {
          log.warn({}, 'stopping with the build result unreported; the server fails the build as interrupted');
          return;
        }
        log.warn({ err: message(err), retryInMs: delay }, 'build result not delivered; retrying');
        await sleep(delay, stopping.signal);
        delay = nextDelay(delay, backoff);
      }
    }
  }

  return {
    offer(job) {
      if (current !== null) {
        opts.log.warn({ buildId: job.buildId, app: job.app }, 'a build is already running; ignoring another');
        return false;
      }
      const started = run(job)
        .catch((err: unknown) => {
          opts.log.error({ buildId: job.buildId, err: message(err) }, 'build worker threw');
        })
        .finally(() => {
          current = null;
        });
      current = started;
      return true;
    },
    busy: () => current !== null,
    idle: () => current ?? Promise.resolve(),
    stop() {
      stopping.abort();
    },
  };
}
