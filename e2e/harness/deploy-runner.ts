// A deploy in its own process, so a test can SIGKILL it mid-step (SHP-T-1.9's kill-mid-swap e2e).
// Run with tsx and TSX_TSCONFIG_PATH=e2e/harness/runner.tsconfig.json (workspace packages resolve
// to their sources). Argument: one JSON RunnerConfig. Prints `SHIPYARD_TEST_PAUSED <point>` when
// the machine's test hook pauses, and the DeployResult as one JSON line if it ever finishes.
import { runDeploy } from '../../packages/sequence/src/machine.js';
import { enginePorts, memoryLog, openContext, type EngineEndpoints, type ToyDataRoot } from './engine.js';

export interface RunnerConfig {
  endpoints: EngineEndpoints;
  paths: Omit<ToyDataRoot, 'remove'>;
  deployId: string;
  sha: string;
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (raw === undefined) throw new Error('usage: deploy-runner <config json>');
  const config = JSON.parse(raw) as RunnerConfig;
  const ports = enginePorts(config.endpoints, memoryLog());
  const ctx = await openContext(ports, config.paths);
  const result = await runDeploy(ports, ctx, {
    deployId: config.deployId,
    kind: 'deploy',
    app: 'toy',
    sha: config.sha,
    dryRun: false,
    requesterLabel: 'kill-mid-swap runner',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
