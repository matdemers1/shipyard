import type { SequencePorts } from '@shipyard/sequence';

import { parseArgs, USAGE } from './args.js';
import { readEnvConfig, type EnvConfig, type Sink } from './config.js';
import { runCheckManifestsCommand, runDeployCommand, runRecoverCommand, runStatusCommand } from './commands.js';

/**
 * `shipyard-run` (SHP-T-1.12, SHP-REQ-032): parse args, build ports and context, call the
 * `@shipyard/sequence` engine, print, exit. No deploy logic — that all lives in the package the
 * agent also runs.
 */
export interface CliDeps {
  /** Built lazily, only once argv and env have both validated. */
  buildPorts: (config: EnvConfig) => SequencePorts;
  deployId: () => string;
  requesterLabel: () => string;
  stdout: Sink;
  stderr: Sink;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, deps: CliDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.stderr.write(`${parsed.message}\n`);
    return 2;
  }
  const { command } = parsed;

  if (command.kind === 'help') {
    deps.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const envResult = readEnvConfig(env);
  if (!envResult.ok) {
    deps.stderr.write(`${envResult.message}\n`);
    return 1;
  }
  const { config } = envResult;

  const ports = deps.buildPorts(config);
  const commandDeps = { deployId: deps.deployId, requesterLabel: deps.requesterLabel, stdout: deps.stdout, stderr: deps.stderr };

  switch (command.kind) {
    case 'deploy':
      return runDeployCommand(ports, config.dataRoot, command, commandDeps);
    case 'status':
      return runStatusCommand(ports, config.dataRoot, command, commandDeps);
    case 'recover':
      return runRecoverCommand(ports, config.dataRoot, commandDeps);
    case 'check-manifests':
      return runCheckManifestsCommand(ports, config.dataRoot, commandDeps);
  }
}
