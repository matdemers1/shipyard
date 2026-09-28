import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refusal } from '@shipyard/schema';
import type { BuildStage, Digest, Manifest } from '@shipyard/schema';

import { RefusalError } from '../ports.js';
import type { BuildKitPort, BuildSecretMount, Log } from '../ports.js';
import { redact } from '../redact.js';

/**
 * The build stage runner (SHP-T-7.7): test target → integration hook → release targets pushed to
 * GHCR. It only talks to BuildKit through `BuildKitPort`, never to a binary directly.
 *
 * - The test target is built before any release target (SHP-REQ-118), without export; if it fails
 *   the build fails and nothing is pushed (SHP-REQ-120).
 * - Each release target is pushed as `<image>:sha-<40hex>` with `org.opencontainers.image.revision`
 *   and `org.opencontainers.image.source` labels (SHP-REQ-127); its digest is returned per service
 *   for the agent to report (SHP-REQ-128).
 * - Build secrets are written to 0600 files in a fresh 0700 directory, passed as `--secret` mounts,
 *   and removed in a `finally` (SHP-REQ-125). Every log chunk is redacted against their values
 *   before it leaves this function (SHP-REQ-126).
 */

const SHA_RE = /^[0-9a-f]{40}$/;
/** BuildProgress.log is capped at 64 KiB; the tail is what matters. */
const MAX_LOG_CHARS = 65_536;

export type StageState = 'running' | 'succeeded' | 'failed' | 'skipped';

export interface StageProgress {
  stage: BuildStage;
  state: StageState;
  /** Already redacted. */
  log?: string;
}

export interface RunBuildStagesOptions {
  /** The extracted source directory (from `withBuildSource`). */
  dir: string;
  manifest: Manifest;
  sha: string;
  buildkit: BuildKitPort;
  /** Build secret values by name, read from the agent's encrypted store. Never logged or stored. */
  secrets: Map<string, string>;
  /** Where the secret-file directory is created. */
  tmpDir: string;
  log?: Log;
  onProgress: (p: StageProgress) => void | Promise<void>;
  shouldCancel?: () => boolean | Promise<boolean>;
  /**
   * The integration stage (SHP-T-7.8), run between the test target and the release targets.
   * Receives a redacting logger; resolves true when the integration tests passed. Absent → the
   * stage is reported `skipped`.
   */
  integration?: (ctx: { onLog: (chunk: string) => void }) => Promise<boolean>;
}

export interface BuildStagesResult {
  state: 'succeeded' | 'failed' | 'cancelled';
  /** Keyed by compose service; empty unless succeeded. */
  digests: Record<string, Digest>;
  failedStage?: BuildStage;
}

/** Thrown as `RefusalError(invalid_request)` before any solve when the manifest cannot be built. */
function refuse(message: string): never {
  throw new RefusalError(refusal('invalid_request', message));
}

export async function runBuildStages(options: RunBuildStagesOptions): Promise<BuildStagesResult> {
  const { manifest, sha, buildkit, secrets } = options;
  const build = manifest.build;
  if (!SHA_RE.test(sha)) refuse('build sha must be 40 lowercase hex characters');
  if (build?.source !== 'shipyard') refuse(`app ${manifest.name} is not built by Shipyard (build.source is not shipyard)`);
  const releaseTargets = build.releaseTargets ?? {};
  const services = Object.keys(manifest.services).sort();
  for (const service of services) {
    if (releaseTargets[service] === undefined) refuse(`build.releaseTargets has no target for service ${service}`);
  }
  const secretNames = build.secrets ?? [];
  for (const name of secretNames) {
    if (!secrets.has(name)) refuse(`build secret ${name} is named in the manifest but not set on this agent`);
  }

  const dockerfile = join(options.dir, build.dockerfile ?? 'Dockerfile');
  const testTarget = build.testTarget ?? 'test';
  const labels = {
    'org.opencontainers.image.revision': sha,
    'org.opencontainers.image.source': `https://github.com/${manifest.repo}`,
  };

  const clean = (text: string): string => {
    const redacted = redact(text, secrets);
    return redacted.length > MAX_LOG_CHARS ? redacted.slice(-MAX_LOG_CHARS) : redacted;
  };
  const progress = async (stage: BuildStage, state: StageState, raw?: string): Promise<void> => {
    await options.onProgress(raw === undefined ? { stage, state } : { stage, state, log: clean(raw) });
  };
  const cancelled = async (): Promise<boolean> => (options.shouldCancel ? await options.shouldCancel() : false);
  /** Collects a stage's raw output (in memory only) and forwards redacted chunks to the log. */
  const collector = (stage: BuildStage): { onLog: (chunk: string) => void; text: () => string } => {
    let buf = '';
    return {
      onLog(chunk) {
        buf += chunk;
        if (buf.length > MAX_LOG_CHARS * 4) buf = buf.slice(-MAX_LOG_CHARS * 2);
        options.log?.info({ stage, output: redact(chunk, secrets) }, 'build output');
      },
      text: () => buf,
    };
  };
  const CANCELLED: BuildStagesResult = { state: 'cancelled', digests: {} };

  let secretDir: string | undefined;
  try {
    const mounts: BuildSecretMount[] = [];
    if (secretNames.length > 0) {
      secretDir = await mkdtemp(join(options.tmpDir, 'shipyard-build-secrets-'));
      await chmod(secretDir, 0o700);
      for (const name of secretNames) {
        const src = join(secretDir, name);
        await writeFile(src, secrets.get(name) ?? '', { mode: 0o600 });
        await chmod(src, 0o600);
        mounts.push({ id: name, src });
      }
    }

    // ── test (SHP-REQ-118, SHP-REQ-120) ──
    if (await cancelled()) return CANCELLED;
    await progress('test', 'running');
    const testLog = collector('test');
    const test = await buildkit.solve(
      { contextDir: options.dir, dockerfile, target: testTarget, secrets: mounts, labels: {} },
      testLog.onLog,
    );
    if (test.exitCode !== 0) {
      await progress('test', 'failed', testLog.text());
      return { state: 'failed', digests: {}, failedStage: 'test' };
    }
    await progress('test', 'succeeded', testLog.text());

    // ── integration (SHP-T-7.8) ──
    if (await cancelled()) return CANCELLED;
    if (options.integration === undefined) {
      await progress('integration', 'skipped');
    } else {
      await progress('integration', 'running');
      const integrationLog = collector('integration');
      const passed = await options.integration({ onLog: integrationLog.onLog });
      if (!passed) {
        await progress('integration', 'failed', integrationLog.text());
        return { state: 'failed', digests: {}, failedStage: 'integration' };
      }
      await progress('integration', 'succeeded', integrationLog.text());
    }

    // ── build + push (SHP-REQ-127, SHP-REQ-128) ──
    if (await cancelled()) return CANCELLED;
    await progress('build', 'running');
    const buildLog = collector('build');
    const digests: Record<string, Digest> = {};
    for (const service of services) {
      if (await cancelled()) return CANCELLED;
      const image = manifest.services[service]?.image ?? '';
      const result = await buildkit.solve(
        {
          contextDir: options.dir,
          dockerfile,
          target: releaseTargets[service] ?? '',
          secrets: mounts,
          labels,
          push: { ref: `${image}:sha-${sha}` },
        },
        buildLog.onLog,
      );
      if (result.exitCode !== 0) {
        await progress('build', 'failed', buildLog.text());
        return { state: 'failed', digests: {}, failedStage: 'build' };
      }
      if (result.digest === undefined) {
        await progress('build', 'succeeded', buildLog.text());
        await progress('push', 'failed', `no pushed digest reported for service ${service}`);
        return { state: 'failed', digests: {}, failedStage: 'push' };
      }
      digests[service] = result.digest;
    }
    await progress('build', 'succeeded', buildLog.text());
    await progress('push', 'succeeded', services.map((s) => `${s} ${digests[s] ?? ''}`).join('\n'));
    return { state: 'succeeded', digests };
  } finally {
    if (secretDir !== undefined) await rm(secretDir, { recursive: true, force: true });
  }
}
