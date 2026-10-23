import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { refusal } from '@shipyard/schema';
import {
  AppLock,
  Journal,
  Ledger,
  createBuildKitAdapter,
  createDockerAdapter,
  createGitHubAdapter,
  createOciRegistry,
  createRegistryAdapter,
  dockerConfigCredentials,
  isAppLockLive,
  loadAgentPrivateKey,
  loadManifests,
  loadStacks,
  lockPath,
  nodeFs,
  recoverInterrupted,
  recoverInterruptedStackUpdates,
  registryCredentials,
  runArgv,
  runDeploy,
  runRestore,
  runRollback,
  runStackUpdate,
  systemClock,
  ManifestLoadError,
  backupVolumesBeforeUpdate,
  closeInterruptedMaintenance,
  nodeArchiveFiles,
  recoverInterruptedMaintenance,
  runMaintenance,
  type Log,
  type MaintenanceContext,
  type MaintenancePorts,
  type SequencePorts,
} from '@shipyard/sequence';
import { createActionRunner, reportInterruptedActions } from './actions.js';
import { createBuildWorker, type BuildWorker } from './build.js';
import { createCacheManager, type CacheManager } from './cache.js';
import { createAgentClient, type FetchLike } from './client.js';
import { loadAgentConfig } from './config.js';
import { waitForConfirmation } from './enrol.js';
import { loadOrCreateIdentity } from './identity.js';
import { POLL_TIMEOUT_MS, createTargetRunner, fileTargetStore, reportLeftovers, runLoop, targetStorePath, trackInFlight } from './loop.js';
import { createInventoryCollector } from './inventory.js';
import { createLogsRunner } from './logs.js';
import { createMaintenanceRunner, reportInterruptedMaintenance } from './maintenance.js';
import { buildReport, manifestsHash, startReporting } from './report.js';
import { createCandidateChecker } from './stack-candidates.js';
import { createStackUpdateRunner, reportInterruptedStackUpdates } from './stack-updates.js';

/**
 * The agent's entry (SHP-T-2.4). It opens no port, ever (SHP-ADR-002, SHP-REQ-033): everything
 * here is an outbound, signed request to the server, or Docker on the host.
 *
 * identity → enrol and wait for an owner's confirmation → roll back anything a previous run left
 * mid-deploy and report it → report the manifests → long-poll for work until SIGTERM, which stops
 * the loop after the current target.
 */

/** The same layout the host CLI uses (apps/cli/src/paths.ts). */
function dataPaths(dataRoot: string) {
  return {
    journalPath: `${dataRoot}/agent/journal.jsonl`,
    ledgerPath: `${dataRoot}/agent/ledger.jsonl`,
    workDir: `${dataRoot}/agent/work`,
    historyDir: `${dataRoot}/agent/history`,
  };
}

async function engineApiVersion(dockerHost: string | undefined): Promise<string> {
  const env = dockerHost === undefined ? process.env : { ...process.env, DOCKER_HOST: dockerHost };
  const res = await runArgv('docker', ['version', '--format', '{{.Server.APIVersion}}'], { env, timeoutMs: 10_000 });
  return res.exitCode === 0 ? res.stdout.trim() : '';
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadAgentConfig(env);
  const logger = pino({ name: 'shipyard-agent' });
  const log = logger as unknown as Log;
  const stopping = new AbortController();
  const stop = (signal: string): void => {
    if (stopping.signal.aborted) return;
    logger.info({ signal }, 'stopping after the current target');
    stopping.abort();
  };
  process.on('SIGTERM', () => {
    stop('SIGTERM');
  });
  process.on('SIGINT', () => {
    stop('SIGINT');
  });

  const identity = await loadOrCreateIdentity(config.dataRoot);
  logger.info({ fingerprint: identity.fingerprint, server: config.serverUrl, version: config.agentVersion }, 'agent starting');
  const client = createAgentClient({ serverUrl: config.serverUrl, identity, timeoutMs: POLL_TIMEOUT_MS });
  // Polls alone are cut off by a shutdown, so a stopping agent never sits out a 25 s wait. The
  // server hands back a target it claimed for a poll whose agent hung up.
  const pollFetch: FetchLike = (input, init) =>
    fetch(input, { ...init, signal: init.signal === undefined || init.signal === null ? stopping.signal : AbortSignal.any([init.signal, stopping.signal]) });
  const pollClient = createAgentClient({ serverUrl: config.serverUrl, identity, timeoutMs: POLL_TIMEOUT_MS, fetch: pollFetch });

  try {
    await waitForConfirmation(client, identity, config.agentVersion, logger, { signal: stopping.signal });
  } catch (err) {
    if (stopping.signal.aborted) return;
    throw err;
  }

  const github = createGitHubAdapter(config.githubToken === undefined ? {} : { token: config.githubToken });
  const ports: SequencePorts = {
    github,
    // Private images: the same read-only docker config the agent's compose pulls use (SHP-T-4.11).
    registry: createRegistryAdapter({ credentials: dockerConfigCredentials(process.env.DOCKER_CONFIG) }),
    docker: createDockerAdapter({
      ...(config.selfContainerId === undefined ? {} : { selfContainerId: config.selfContainerId }),
      ...(config.dockerHost === undefined ? {} : { dockerHost: config.dockerHost }),
      warn: (message, detail) => {
        logger.warn(detail, message);
      },
    }),
    fs: nodeFs(),
    clock: systemClock(),
    log,
  };
  const paths = dataPaths(config.dataRoot);
  await ports.fs.mkdirp(`${config.dataRoot}/agent`);
  const journal = new Journal(ports.fs, paths.journalPath, ports.clock, log);
  const store = fileTargetStore(ports.fs, targetStorePath(config.dataRoot));
  const isLive = (app: string): Promise<boolean> => isAppLockLive(config.dataRoot, app);

  // Never resume forward (SHP-REQ-022): roll back what a previous run left mid-deploy, then tell
  // the server about every target that run took and never reported.
  const recovered = await recoverInterrupted({ fs: ports.fs, docker: ports.docker, log, clock: ports.clock }, journal, {
    historyDir: paths.historyDir,
    isLive,
  });
  for (const r of recovered) logger.warn({ ...r }, 'recovered an interrupted deploy');
  await reportLeftovers({
    client,
    store,
    log: logger,
    recovered: new Map(recovered.map((r) => [r.deployId, r.lastStep])),
    isLive,
  });
  // A lifecycle action is never redone after a restart: it is reported interrupted (SHP-REQ-187).
  await reportInterruptedActions({ client, journal, log: logger });

  // Nor is a volume job (SHP-ADR-012): a project one had stopped is started again first — a stack
  // is never left stopped because the agent restarted — then the server is told.
  const archiveFiles = nodeArchiveFiles();
  const maintenanceRecovered = await recoverInterruptedMaintenance({ docker: ports.docker, files: archiveFiles, log }, journal);
  await reportInterruptedMaintenance({ client, recovered: maintenanceRecovered, close: (r) => closeInterruptedMaintenance(journal, r), log: logger });

  // Opened once: the ledger's hash chain is verified on open. Appends take a cross-process lock and
  // chain onto the file's true tail, since the host CLI appends to the same file (SHP-T-6.11).
  const ledger = await Ledger.open(ports.fs, paths.ledgerPath);

  // A stack update is never resumed forward either (SHP-REQ-197): put back what one left mid-swap,
  // and tell the server.
  const stackRecovered = await recoverInterruptedStackUpdates({ fs: ports.fs, docker: ports.docker, log }, journal, {
    historyDir: paths.historyDir,
    ledger,
    isLive,
  });
  await reportInterruptedStackUpdates({
    client,
    recovered: stackRecovered,
    succeeded: (stack, updateId) => {
      const record = ledger.stackUpdate(stack, updateId);
      const images = (list: { service: string; tag: string | null; digest: string }[]) => list.map(({ service, tag, digest }) => ({ service, tag, digest }));
      return record === null ? null : { images: images(record.images), previous: images(record.previous) };
    },
    log: logger,
  });

  // Stack updates (SHP-ADR-010): any OCI registry, with the same read-only docker config the
  // agent's pulls use; candidates are checked on the report interval, cached and rate-limit aware.
  const stackRegistry = createOciRegistry({ credentials: registryCredentials(process.env.DOCKER_CONFIG) });
  const candidates = createCandidateChecker({ registry: stackRegistry, docker: ports.docker, fs: ports.fs, log: logger });

  // Set once builds are enabled below; a plain variable so `reporting`'s closure (built before it
  // exists) always reads whatever it is by the time a report is actually sent (SHP-T-7.11).
  let cacheManager: CacheManager | undefined;

  // Holds the df and Docker-root caches and each container's previous stats sample across reports
  // (SHP-T-14.4), so it is made once.
  const inventory = createInventoryCollector({ docker: ports.docker, dataRoot: config.dataRoot, log: logger });

  const reporting = startReporting(
    client,
    () =>
      buildReport(
        {
          fs: ports.fs,
          docker: ports.docker,
          engineApiVersion: () => engineApiVersion(config.dockerHost),
          ledger,
          buildCache: () => cacheManager?.snapshot(),
          inventory,
          stackServices: (stack) => candidates.services(stack),
          log: logger,
        },
        config.dataRoot,
        { agentVersion: config.agentVersion, patExpiresAt: github.tokenExpiresAt()?.toISOString() ?? null },
      ),
    { currentHash: () => manifestsHash(ports.fs, config.dataRoot), log: logger },
  );

  const runTarget = createTargetRunner({
    client,
    engine: {
      deploy: (ctx, request) => runDeploy(ports, ctx, request),
      rollback: (ctx, request) => runRollback(ports, ctx, request),
      restore: (ctx, request) => runRestore(ports, ctx, request),
    },
    context: async () => ({
      dataRoot: config.dataRoot,
      manifests: await loadManifests(ports.fs, config.dataRoot),
      journal,
      ledger,
      workDir: paths.workDir,
      historyDir: paths.historyDir,
    }),
    store,
    log: logger,
    signal: stopping.signal,
  });

  // A deploy in flight on this host holds the next build stage (SHP-REQ-130): this agent running a
  // target, or any live app lock — which is also how a host-CLI deploy shows.
  const targets = trackInFlight(runTarget);
  const locksDir = lockPath(config.dataRoot, 'x').slice(0, -'/x.lock'.length);
  const anyLockLive = async (): Promise<boolean> => {
    let files: { path: string }[];
    try {
      files = await ports.fs.list(locksDir);
    } catch {
      return false;
    }
    for (const file of files) {
      const name = file.path.slice(file.path.lastIndexOf('/') + 1);
      if (name.endsWith('.lock') && (await isAppLockLive(config.dataRoot, name.slice(0, -'.lock'.length)))) return true;
    }
    return false;
  };

  // Builds (SHP-T-7.9): only when BUILDKIT_ADDR names a buildkitd; otherwise the capability is
  // never advertised and the server never sends a build.
  let builds: BuildWorker | undefined;
  let gcTimer: NodeJS.Timeout | undefined;
  if (config.buildkitAddr !== undefined) {
    await ports.fs.mkdirp(config.buildTmpDir);
    const buildkit = createBuildKitAdapter({
      addr: config.buildkitAddr,
      tmpDir: config.buildTmpDir,
      ...(config.buildDockerConfig === undefined ? {} : { dockerConfigDir: config.buildDockerConfig }),
    });
    // The BuildKit sidecar's own container (SHP-T-7.11): its compose labels by default, or an
    // explicit container name/ID (BUILDKIT_CONTAINER) when the sidecar is not run by compose.
    const explicitContainer = env['BUILDKIT_CONTAINER']?.trim();
    cacheManager = createCacheManager({
      buildkit,
      ...(config.dockerHost === undefined ? {} : { dockerHost: config.dockerHost }),
      ...(explicitContainer === undefined || explicitContainer === '' ? {} : { containerId: explicitContainer }),
      log: logger,
      clock: ports.clock,
    });
    const cache = cacheManager;
    builds = createBuildWorker({
      client,
      manifests: async () => new Map([...(await loadManifests(ports.fs, config.dataRoot))].map(([name, loaded]) => [name, loaded.manifest])),
      github,
      buildkit,
      docker: ports.docker,
      fs: ports.fs,
      dataRoot: config.dataRoot,
      tmpDir: config.buildTmpDir,
      privateKey: await loadAgentPrivateKey(config.dataRoot),
      deployInFlight: async () => targets.inFlight() || (await anyLockLive()),
      onBuildFinished: () => cache.afterBuild(),
      log,
      clock: ports.clock,
    });
    logger.info({ buildkit: config.buildkitAddr }, 'builds enabled');
    // A build whose success or failure never came (the agent restarted, or none has run yet since
    // start) still gets GC once a day (SHP-REQ-132).
    gcTimer = setInterval(() => void cache.maybeDailyGc(), 60 * 60 * 1000);
    gcTimer.unref();
  }
  const worker = builds;

  // Volume backups, restores, deletes and prunes (SHP-ADR-012). The helper is the agent's own
  // image, found once by inspecting its own container; it is never pulled.
  let ownImage: Promise<string> | undefined;
  const helperImage = (): Promise<string> => {
    if (ownImage === undefined) {
      const self = config.selfContainerId;
      const inspect = ports.docker.containerImageId?.bind(ports.docker);
      ownImage =
        self === undefined || inspect === undefined
          ? Promise.reject(new Error('the agent is not running in a container (no HOSTNAME under /.dockerenv, no SHIPYARD_SELF_CONTAINER_ID)'))
          : inspect(self).then((id) => {
              if (id === null) throw new Error(`Docker does not know the agent's own container ${self}`);
              return id;
            });
      // A failed lookup is tried again next time rather than remembered.
      ownImage.catch(() => {
        ownImage = undefined;
      });
    }
    return ownImage;
  };
  const maintenancePorts: MaintenancePorts = { docker: ports.docker, fs: ports.fs, files: archiveFiles, clock: ports.clock, log };
  const maintenanceContext = async (onStep?: MaintenanceContext['onStep']): Promise<MaintenanceContext> => ({
    dataRoot: config.dataRoot,
    backupRoot: config.backupRoot,
    apps: await loadManifests(ports.fs, config.dataRoot),
    stacks: await loadStacks(ports.fs, config.dataRoot),
    journal,
    ledger,
    helperImage,
    // A prune never runs beside a deploy, a stack update or an action (their locks show it).
    busy: async () => targets.inFlight() || (await anyLockLive()),
    ...(onStep === undefined ? {} : { onStep }),
  });

  // Stack updates by digest (SHP-P-16): always on, in the background, one at a time.
  const stackUpdates = createStackUpdateRunner({
    client,
    execute: async (job, onStep) => {
      let stacks;
      try {
        stacks = await loadStacks(ports.fs, config.dataRoot);
      } catch (err) {
        const why = err instanceof ManifestLoadError ? err.toRefusal() : refusal('manifest_invalid', `The host's stack manifests could not be read: ${err instanceof Error ? err.message : String(err)}`);
        return { updateId: job.updateId, state: 'refused', images: [], previous: [], refusal: why };
      }
      return runStackUpdate(
        { registry: stackRegistry, docker: ports.docker, fs: ports.fs, clock: ports.clock, log },
        {
          dataRoot: config.dataRoot,
          stacks,
          journal,
          ledger,
          historyDir: paths.historyDir,
          onStep,
          // volumeBackups.beforeUpdate (SHP-ADR-012): inside the update's own lock.
          backupVolumes: async (stack, updateId) => (await backupVolumesBeforeUpdate(maintenancePorts, await maintenanceContext(), { stack, updateId })).refusal,
        },
        job,
      );
    },
    // What runs changed: re-check the stack's candidates and tell the server now.
    onFinished: (job) => {
      candidates.invalidate(job.stack);
      void reporting.sendNow();
    },
    log: logger,
    signal: stopping.signal,
  });

  // Lifecycle actions and logs (SHP-ADR-010, SHP-ADR-011): always on, each in the background.
  const actions = createActionRunner({
    client,
    docker: ports.docker,
    fs: ports.fs,
    journal,
    clock: ports.clock,
    apps: () => loadManifests(ports.fs, config.dataRoot),
    stacks: () => loadStacks(ports.fs, config.dataRoot),
    // This agent running a target for the app, or any live lock on it — a host-CLI deploy too.
    deployInFlight: async (app) => targets.inFlightFor(app) || (await isAppLockLive(config.dataRoot, app)),
    // Held for the action, so a deploy arriving meanwhile is refused `locked` rather than racing it.
    lockApp: (app, job) =>
      AppLock.acquire(config.dataRoot, app, {
        pid: process.pid,
        deployId: job.actionId,
        requesterLabel: job.requesterLabel ?? 'shipyard server',
        sha: '',
        step: `action ${job.verb}`,
        at: new Date().toISOString(),
      }),
    // A stack is held the same way, and never acted on mid-update (SHP-P-16).
    stackBusy: (stack) => stackUpdates.inFlightFor(stack),
    lockStack: (stack, job) =>
      AppLock.acquire(config.dataRoot, stack, {
        pid: process.pid,
        deployId: job.actionId,
        requesterLabel: job.requesterLabel ?? 'shipyard server',
        sha: '',
        step: `action ${job.verb}`,
        at: new Date().toISOString(),
      }),
    log: logger,
    signal: stopping.signal,
  });
  const maintenance = createMaintenanceRunner({
    client,
    execute: async (job, onStep) => {
      let ctx: MaintenanceContext;
      try {
        ctx = await maintenanceContext(onStep);
      } catch (err) {
        const why = err instanceof ManifestLoadError ? err.toRefusal() : refusal('manifest_invalid', `The host's manifests could not be read: ${err instanceof Error ? err.message : String(err)}`);
        return { jobId: job.jobId, state: 'refused', refusal: why };
      }
      return runMaintenance(maintenancePorts, ctx, job);
    },
    // New or removed archives reach the server with the next report, sent now.
    onFinished: () => void reporting.sendNow(),
    log: logger,
    signal: stopping.signal,
  });
  const logs = createLogsRunner({
    client,
    docker: ports.docker,
    fs: ports.fs,
    apps: () => loadManifests(ports.fs, config.dataRoot),
    stacks: () => loadStacks(ports.fs, config.dataRoot),
    log: logger,
  });

  try {
    await runLoop({
      client: pollClient,
      runTarget: targets.run,
      actions,
      logs,
      stackUpdates,
      maintenance,
      log: logger,
      signal: stopping.signal,
      ...(worker === undefined ? {} : { builds: { canTake: () => !worker.busy(), offer: (job) => void worker.offer(job) } }),
      ...(cacheManager === undefined ? {} : { onBuildSettings: (settings) => void cacheManager.applySettings(settings) }),
    });
  } finally {
    reporting.stop();
    if (gcTimer !== undefined) clearInterval(gcTimer);
    if (worker !== undefined && worker.busy()) {
      // Stop at the next stage boundary and report it cancelled; a build still stuck in a stage
      // when the process exits is failed `interrupted` by the server's stale sweep.
      worker.stop();
      await Promise.race([worker.idle(), new Promise((resolve) => setTimeout(resolve, 8_000).unref())]);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => {
      process.exit(0);
    },
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
