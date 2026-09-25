import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

import { refusal } from '@shipyard/schema';
import { stringify as stringifyYaml } from 'yaml';

import { redact } from './redact.js';
import { RefusalError } from './ports.js';
import type { ComposeTarget, Clock, DockerPort, FsPort, Manifest } from './ports.js';

/**
 * The step runner (SHP-T-1.7, SHP-REQ-018, SHP-REQ-019, SHP-REQ-020, SHP-REQ-030, SHP-REQ-102).
 * Every step is exec'd as an argument vector in a named compose service, never through a shell.
 * Backup output is never stored, of any kind — not even on failure. Migrate (and any later
 * generic step) has its output redacted against the stack's env-file secrets and capped to the
 * last 50 lines before it is ever returned to a caller that might journal it.
 */

type ManifestSteps = NonNullable<Manifest['steps']>;
export type BackupStepDef = NonNullable<ManifestSteps['backup']>;
export type MigrateStepDef = NonNullable<ManifestSteps['migrate']>;

export interface StepPorts {
  docker: DockerPort;
  fs: FsPort;
  clock: Clock;
}

export interface Artifact {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface BackupResult {
  exitCode: number;
  artifact: Artifact;
}

export interface ExecStepResult {
  exitCode: number;
  output: string;
}

/** Image reference a migrate override compose file should map a service to. */
export interface ImageOverride {
  service: string;
  reference: string;
}

const ARTIFACT_GRACE_MS = 1000;

/**
 * Runs the manifest's backup step in the app's already-running container (SHP-D-018) and records
 * as the artifact the newest non-empty file created anywhere under `artifactsDir` since the step began
 * (SHP-D-054). Never returns or throws with any step output (SHP-REQ-102): a caller cannot leak
 * what it was never given.
 */
export async function runBackup(ports: StepPorts, target: ComposeTarget, step: BackupStepDef): Promise<BackupResult> {
  // What was there before the step, so an existing file can never pass as this step's artifact —
  // not even one whose mtime is skewed into the future.
  // A directory the app's first backup will create is simply empty before it (ENOENT is not a failure).
  const listed = await ports.fs.list(step.artifactsDir, { recursive: true }).catch((err: unknown) => {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return [];
    throw err;
  });
  const before = new Map(listed.map((entry) => [entry.path, entry.mtimeMs]));
  const startedAt = ports.clock.now().getTime();
  const result = await ports.docker.compose(target, ['exec', '-T', step.service, ...step.argv]);
  const endedAt = ports.clock.now().getTime();

  // At any depth: some apps nest their backups by date (D3 Auth's bundles/YYYY/MM/DD/).
  const entries = await ports.fs.list(step.artifactsDir, { recursive: true });
  const candidates = entries.filter(
    (entry) =>
      entry.size > 0 &&
      before.get(entry.path) !== entry.mtimeMs &&
      entry.mtimeMs >= startedAt - ARTIFACT_GRACE_MS &&
      entry.mtimeMs <= endedAt + ARTIFACT_GRACE_MS,
  );
  const newest = candidates.reduce<Artifact | null>((best, entry) => (best === null || entry.mtimeMs > best.mtimeMs ? entry : best), null);

  if (result.exitCode !== 0) {
    throw new RefusalError(refusal('backup_failed', `Backup step for service "${step.service}" exited ${result.exitCode}.`));
  }
  if (newest === null) {
    throw new RefusalError(refusal('backup_failed', `Backup step for service "${step.service}" produced no new non-empty file under ${step.artifactsDir}.`));
  }

  return { exitCode: result.exitCode, artifact: newest };
}

function overrideYaml(images: ImageOverride[]): string {
  const services: Record<string, { image: string }> = {};
  for (const image of images) {
    services[image.service] = { image: image.reference };
  }
  return stringifyYaml({ services });
}

/**
 * Runs the manifest's migrate step as a one-shot `compose run --rm` of the *new* images, before
 * the swap, while the old app still serves (SHP-D-028). Writes a temporary override compose file
 * in `workDir` (never in the stack directory), removes it afterwards on a best-effort basis, and
 * returns redacted, tail-capped output. A non-zero exit refuses without swapping (SHP-REQ-018).
 */
export async function runMigrate(
  ports: StepPorts,
  target: ComposeTarget,
  step: MigrateStepDef,
  images: ImageOverride[],
  workDir: string,
  secrets: Map<string, string>,
): Promise<ExecStepResult> {
  const overridePath = `${workDir}/${randomUUID()}.migrate-override.yaml`;
  await ports.fs.writeFileAtomic(overridePath, overrideYaml(images));

  const runTarget: ComposeTarget = { files: [...target.files, overridePath], project: target.project };
  let result;
  try {
    result = await ports.docker.compose(runTarget, ['run', '--rm', '--no-deps', '-T', step.service, ...step.argv]);
  } finally {
    try {
      await unlink(overridePath);
    } catch {
      // Best-effort cleanup: a leftover override file in workDir is harmless.
    }
  }

  const output = redactStreams(result.stdout, result.stderr, secrets);

  if (result.exitCode !== 0) {
    throw new RefusalError(refusal('migrate_failed', `Migrate step for service "${step.service}" exited ${result.exitCode}.\n${output}`));
  }

  return { exitCode: result.exitCode, output };
}

/** A generic journaled step: `compose exec -T` with redacted, tail-capped output. */
export async function runExec(ports: StepPorts, target: ComposeTarget, step: MigrateStepDef, secrets: Map<string, string>): Promise<ExecStepResult> {
  const result = await ports.docker.compose(target, ['exec', '-T', step.service, ...step.argv]);
  const output = redactStreams(result.stdout, result.stderr, secrets);

  if (result.exitCode !== 0) {
    throw new RefusalError(refusal('step_failed', `Step for service "${step.service}" exited ${result.exitCode}.\n${output}`));
  }

  return { exitCode: result.exitCode, output };
}

/**
 * Redacts each stream on its own before joining them, so a value can never straddle the seam the
 * join creates and survive redaction in neither half.
 */
function redactStreams(stdout: string, stderr: string, secrets: Map<string, string>): string {
  return redact(`${redact(stdout, secrets)}\n${redact(stderr, secrets)}`, secrets);
}
