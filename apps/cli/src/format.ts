import type { DeployResult, LedgerEntry, RecoveryResult, RunningContainer } from '@shipyard/sequence';

/**
 * Pure output formatting (SHP-T-1.12), so it can be tested against fake `DeployResult`s with no
 * ports involved. Human text to stdout; the pino-compatible logs are a separate stream (stderr).
 */

/** succeeded → 0, refused → 2, failed/rolled_back → 1, a passing dry run (still "verifying") → 0. */
export function deployExitCode(result: DeployResult): number {
  if (result.state === 'refused') return 2;
  if (result.state === 'failed' || result.state === 'rolled_back') return 1;
  return 0;
}

export function formatDeployResult(result: DeployResult): string {
  const lines: string[] = [`state: ${result.state}`, `sha: ${result.sha}`];
  for (const image of result.images) {
    lines.push(`  ${image.service} ${image.repo}@${image.digest}`);
  }
  if (result.schemaRevision !== null) lines.push(`schema: ${result.schemaRevision}`);
  if (result.refusal !== null) {
    lines.push(`${result.refusal.code} (${result.refusal.gate}): ${result.refusal.message}`);
    lines.push(`  fix: ${result.refusal.fix}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatProgress(event: { state: string; step?: string }): string {
  return event.step === undefined ? `${event.state}\n` : `${event.state} (${event.step})\n`;
}

export function formatRecovery(result: RecoveryResult): string {
  const lines = [`recovered ${result.app} ${result.deployId} (last step: ${result.lastStep ?? '(none)'})`];
  if (result.restored.length > 0) lines.push(`  restored: ${result.restored.join(', ')}`);
  if (result.upExitCode !== null) lines.push(`  compose up exit: ${result.upExitCode}`);
  if (result.error !== undefined) lines.push(`  error: ${result.error}`);
  return `${lines.join('\n')}\n`;
}

export function formatStatus(app: string, live: LedgerEntry | null, running: RunningContainer[], recent: LedgerEntry[]): string {
  const lines = [`app: ${app}`, `live sha: ${live?.sha ?? '(none)'}`, 'running:'];
  for (const c of running) {
    lines.push(`  ${c.service} ${c.repoDigests.join(', ') || '(no digest)'}`);
  }
  lines.push('last 5 ledger entries:');
  for (const entry of recent) {
    lines.push(`  ${entry.at} ${entry.kind} ${entry.sha} ${entry.images.map((i) => `${i.service}@${i.digest}`).join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}
