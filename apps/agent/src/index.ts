import { pathToFileURL } from 'node:url';
import pino from 'pino';
import {
  Journal,
  Ledger,
  createBuildKitAdapter,
  createDockerAdapter,
  createGitHubAdapter,
  createRegistryAdapter,
  dockerConfigCredentials,
  isAppLockLive,
  loadAgentPrivateKey,
  loadManifests,
  lockPath,
  nodeFs,
  recoverInterrupted,
  runArgv,
  runDeploy,
  runRestore,
  runRollback,
  systemClock,
  type Log,
  type SequencePorts,
} from '@shipyard/sequence';
import { createBuildWorker, type BuildWorker } from './build.js';
import { createAgentClient, type FetchLike } from './client.js';
import { loadAgentConfig } from './config.js';
import { waitForConfirmation } from './enrol.js';
import { loadOrCreateIdentity } from './identity.js';
import { POLL_TIMEOUT_MS, createTargetRunner, fileTargetStore, reportLeftovers, runLoop, targetStorePath, trackInFlight } from './loop.js';
import { buildReport, manifestsHash, startReporting } from './report.js';

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

  // Opened once: the ledger's hash chain is verified on open. Appends take a cross-process lock and
  // chain onto the file's true tail, since the host CLI appends to the same file (SHP-T-6.11).
  const ledger = await Ledger.open(ports.fs, paths.ledgerPath);

  const reporting = startReporting(
    client,
    () =>
      buildReport(
        { fs: ports.fs, docker: ports.docker, engineApiVersion: () => engineApiVersion(config.dockerHost), ledger, log: logger },
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
  if (config.buildkitAddr !== undefined) {
    await ports.fs.mkdirp(config.buildTmpDir);
    builds = createBuildWorker({
      client,
      manifests: async () => new Map([...(await loadManifests(ports.fs, config.dataRoot))].map(([name, loaded]) => [name, loaded.manifest])),
      github,
      buildkit: createBuildKitAdapter({
        addr: config.buildkitAddr,
        tmpDir: config.buildTmpDir,
        ...(config.buildDockerConfig === undefined ? {} : { dockerConfigDir: config.buildDockerConfig }),
      }),
      docker: ports.docker,
      fs: ports.fs,
      dataRoot: config.dataRoot,
      tmpDir: config.buildTmpDir,
      privateKey: await loadAgentPrivateKey(config.dataRoot),
      deployInFlight: async () => targets.inFlight() || (await anyLockLive()),
      log,
      clock: ports.clock,
    });
    logger.info({ buildkit: config.buildkitAddr }, 'builds enabled');
  }
  const worker = builds;

  try {
    await runLoop({
      client: pollClient,
      runTarget: targets.run,
      log: logger,
      signal: stopping.signal,
      ...(worker === undefined ? {} : { builds: { canTake: () => !worker.busy(), offer: (job) => void worker.offer(job) } }),
    });
  } finally {
    reporting.stop();
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
