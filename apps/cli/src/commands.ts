import {
  Journal,
  Ledger,
  ManifestLoadError,
  loadManifests,
  recoverInterrupted,
  runDeploy,
  type DeployRequest,
  type LoadedManifests,
  type SequencePorts,
} from '@shipyard/sequence';

import type { DeployCommand, StatusCommand } from './args.js';
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
