import {
  BuildSecretsError,
  Journal,
  Ledger,
  ManifestLoadError,
  loadManifests,
  isAppLockLive,
  recoverInterrupted,
  deleteBuildSecret,
  listBuildSecretNames,
  loadAgentPrivateKey,
  runDeploy,
  setBuildSecret,
  type DeployRequest,
  type LoadedManifests,
  type SequencePorts,
} from '@shipyard/sequence';

import type { BuildSecretCommand, DeployCommand, StatusCommand } from './args.js';
import { formatDeployResult, formatProgress, formatRecovery, formatStatus, deployExitCode } from './format.js';
import { dataPaths } from './paths.js';
import type { Sink } from './config.js';

/** What each command needs to talk and to identify itself; everything else comes from `ports`. */
export interface CommandDeps {
  deployId: () => string;
  requesterLabel: () => string;
  stdout: Sink;
  stderr: Sink;
}

async function loadManifestsOrReport(ports: SequencePorts, dataRoot: string, deps: CommandDeps): Promise<LoadedManifests> {
  try {
    return await loadManifests(ports.fs, dataRoot);
  } catch (err) {
    if (err instanceof ManifestLoadError) {
      deps.stderr.write(`${err.message}\n`);
    }
    throw err;
  }
}

export async function runDeployCommand(ports: SequencePorts, dataRoot: string, command: DeployCommand, deps: CommandDeps): Promise<number> {
  const paths = dataPaths(dataRoot);
  const journal = new Journal(ports.fs, paths.journalPath, ports.clock, ports.log);

  // Never resume forward: any deploy the agent (or a previous CLI run) left mid-flight is rolled
  // back to its last verified-good compose file before this one starts (SHP-REQ-022).
  const recovered = await recoverInterrupted({ fs: ports.fs, docker: ports.docker, log: ports.log, clock: ports.clock }, journal, {
    historyDir: paths.historyDir,
    // A deploy another process is still running (its lock heartbeat is fresh) is not interrupted.
    isLive: (app) => isAppLockLive(dataRoot, app),
  });
  for (const r of recovered) deps.stdout.write(formatRecovery(r));

  let manifests;
  try {
    manifests = await loadManifestsOrReport(ports, dataRoot, deps);
  } catch {
    return 1;
  }

  const ledger = await Ledger.open(ports.fs, paths.ledgerPath);
  const deployId = deps.deployId();

  const result = await runDeploy(
    ports,
    {
      dataRoot,
      manifests,
      journal,
      ledger,
      workDir: paths.workDir,
      historyDir: paths.historyDir,
      onProgress: (event) => {
        deps.stdout.write(formatProgress(event));
      },
    },
    {
      deployId,
      kind: 'deploy',
      app: command.app,
      sha: command.sha,
      dryRun: command.dryRun,
      requesterLabel: command.label ?? deps.requesterLabel(),
    } satisfies DeployRequest,
  );

  if (command.json) {
    deps.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    deps.stdout.write(formatDeployResult(result));
  }

  return deployExitCode(result);
}

export async function runStatusCommand(ports: SequencePorts, dataRoot: string, command: StatusCommand, deps: CommandDeps): Promise<number> {
  let manifests;
  try {
    manifests = await loadManifestsOrReport(ports, dataRoot, deps);
  } catch {
    return 1;
  }

  const loaded = manifests.get(command.app);
  if (loaded === undefined) {
    deps.stderr.write(`no manifest on this host for app "${command.app}"\n`);
    return 1;
  }

  const paths = dataPaths(dataRoot);
  const ledger = await Ledger.open(ports.fs, paths.ledgerPath);
  const target = { files: loaded.manifest.compose.files, project: loaded.manifest.compose.project };
  const running = (await ports.docker.containers(target)).filter((c) => c.state === 'running');

  deps.stdout.write(formatStatus(command.app, ledger.last(command.app), running, ledger.recent(command.app, 5)));
  return 0;
}

export async function runRecoverCommand(ports: SequencePorts, dataRoot: string, deps: CommandDeps): Promise<number> {
  const paths = dataPaths(dataRoot);
  const journal = new Journal(ports.fs, paths.journalPath, ports.clock, ports.log);
  const results = await recoverInterrupted({ fs: ports.fs, docker: ports.docker, log: ports.log, clock: ports.clock }, journal, {
    historyDir: paths.historyDir,
  });

  if (results.length === 0) {
    deps.stdout.write('nothing to recover\n');
    return 0;
  }
  for (const r of results) deps.stdout.write(formatRecovery(r));
  return results.some((r) => r.error !== undefined) ? 1 : 0;
}

export async function runCheckManifestsCommand(ports: SequencePorts, dataRoot: string, deps: CommandDeps): Promise<number> {
  try {
    const manifests = await loadManifests(ports.fs, dataRoot);
    for (const [name, loaded] of manifests) {
      deps.stdout.write(`${name} ${loaded.file}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof ManifestLoadError) {
      deps.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

/** The longest build-secret value accepted on stdin. */
export const MAX_SECRET_BYTES = 64 * 1024;

export interface BuildSecretDeps {
  /** The whole of stdin, as text. Only `set` reads it. */
  readStdin: () => Promise<string>;
  stdout: Sink;
  stderr: Sink;
}

/**
 * `build-secret set|delete|list` (SHP-T-7.9, SHP-REQ-125). The values are sealed with a key derived
 * from the agent's own key (`<dataRoot>/agent/agent.key`), so this runs on the agent's host with
 * read access to that key. No value is ever printed; `list` shows names only.
 */
export async function runBuildSecretCommand(dataRoot: string, command: BuildSecretCommand, deps: BuildSecretDeps): Promise<number> {
  try {
    if (command.action === 'list') {
      const names = await listBuildSecretNames(dataRoot, command.app);
      for (const name of names) deps.stdout.write(`${name}\n`);
      if (names.length === 0) deps.stderr.write(`no build secrets set for ${command.app}\n`);
      return 0;
    }
    const key = await loadAgentPrivateKey(dataRoot);
    if (command.action === 'delete') {
      const removed = await deleteBuildSecret(dataRoot, key, command.app, command.name);
      deps.stdout.write(removed ? `deleted build secret ${command.name} for ${command.app}\n` : `no build secret ${command.name} for ${command.app}\n`);
      return removed ? 0 : 1;
    }
    const raw = await deps.readStdin();
    if (Buffer.byteLength(raw, 'utf8') > MAX_SECRET_BYTES) {
      deps.stderr.write(`the value on stdin is larger than ${String(MAX_SECRET_BYTES)} bytes\n`);
      return 2;
    }
    // One trailing newline is what `echo` and an interactive line add; it is not part of the value.
    const value = raw.replace(/\r?\n$/, '');
    if (value.length === 0) {
      deps.stderr.write('no value on stdin: pipe the secret in, e.g. printf %s "$TOKEN" | shipyard-run build-secret set <app> <name>\n');
      return 2;
    }
    await setBuildSecret(dataRoot, key, command.app, command.name, value);
    deps.stdout.write(`set build secret ${command.name} for ${command.app}\n`);
    return 0;
  } catch (err) {
    if (err instanceof BuildSecretsError) {
      deps.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
