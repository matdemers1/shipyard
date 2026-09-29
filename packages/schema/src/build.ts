import { z } from 'zod';

import { AppName, Argv, Digest, Sha40 } from './primitives.js';
import { Refusal } from './errors.js';

/**
 * The build pipeline (SHP-REQ-117, SHP-REQ-136): the agent fetches a GitHub tarball of an exact
 * SHA, builds a Dockerfile `test` target, optionally runs a compose integration-test service,
 * builds release targets with rootless BuildKit, and pushes each to GHCR as `sha-<40hex>`. This
 * module only shapes what the manifest's `build` block and the agent protocol carry for it —
 * `packages/sequence` and the agent own the behaviour.
 */

/** A BuildKit target, compose service, or secret name — never a shell string. */
export const BuildName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, 'lowercase alphanumeric, `_.-`, starting alphanumeric, max 63 chars')
  .meta({ id: 'BuildName', description: 'A BuildKit target, compose service, or secret name' });
export type BuildName = z.infer<typeof BuildName>;

/** One stage of a build, in the order the agent runs them. */
export const BuildStage = z
  .enum(['fetch', 'test', 'integration', 'build', 'push'])
  .meta({ id: 'BuildStage', description: 'One stage of a Shipyard-built image' });
export type BuildStage = z.infer<typeof BuildStage>;

/** The terminal (or in-flight) state of a whole build. */
export const BuildState = z
  .enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'refused'])
  .meta({ id: 'BuildState', description: 'The state of a whole build' });
export type BuildState = z.infer<typeof BuildState>;

/** What caused a build to be queued. */
export const BuildTrigger = z
  .enum(['webhook', 'reconcile', 'manual', 'mcp', 'rebuild'])
  .meta({ id: 'BuildTrigger', description: 'What caused a build to be queued' });
export type BuildTrigger = z.infer<typeof BuildTrigger>;

/** A build handed to the agent in the poll response, alongside (never instead of) a deploy target. */
export const BuildJob = z
  .strictObject({
    buildId: z.string().min(1).max(100),
    app: AppName,
    sha: Sha40,
    /** The requester label, for the agent's logs. Display only. */
    requesterLabel: z.string().max(200).optional(),
  })
  .meta({ id: 'BuildJob', description: 'A build for the agent to run' });
export type BuildJob = z.infer<typeof BuildJob>;

/** A stage the agent reports moving through, agent to server. */
export const BuildProgress = z
  .strictObject({
    buildId: z.string().min(1).max(100),
    stage: BuildStage,
    state: z.enum(['running', 'succeeded', 'failed', 'skipped']),
    /** Already redacted by the agent before it is sent. */
    log: z.string().max(65536, 'log is truncated to 64KiB').optional(),
    at: z.iso.datetime(),
  })
  .meta({ id: 'BuildProgress', description: 'A build stage moved to a new state' });
export type BuildProgress = z.infer<typeof BuildProgress>;

/** The terminal result of a whole build, agent to server. */
export const BuildResult = z
  .strictObject({
    buildId: z.string().min(1).max(100),
    state: z.enum(['succeeded', 'failed', 'cancelled', 'refused']),
    /** Empty unless state is succeeded. Keyed by compose service name. */
    digests: z.record(z.string().min(1), Digest),
    refusal: Refusal.optional(),
    failedStage: BuildStage.optional(),
  })
  .refine((r) => r.state !== 'succeeded' || Object.keys(r.digests).length > 0, {
    message: 'a succeeded build must report at least one digest',
    path: ['digests'],
  })
  .refine((r) => r.state !== 'refused' || r.refusal !== undefined, {
    message: 'a refused build must carry a refusal',
    path: ['refusal'],
  })
  .meta({ id: 'BuildResult', description: 'The terminal result of a whole build' });
export type BuildResult = z.infer<typeof BuildResult>;

// ─── The manifest's build block ─────────────────────────────────────────────

/**
 * A repo-relative path (a Dockerfile or a compose file): never absolute, never a `..` segment,
 * never a backslash or NUL byte. Kept local to this module — the manifest's `build` block is the
 * only place it is used.
 */
const RepoRelativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/'), 'must be relative (no leading /)')
  .refine((p) => !p.includes('\\'), 'must not contain a backslash')
  .refine((p) => !p.includes('\0'), 'must not contain a NUL byte')
  .refine((p) => !p.split('/').includes('..'), 'must not contain a .. segment');

const BuildIntegration = z
  .strictObject({
    compose: RepoRelativePath,
    service: BuildName,
    argv: Argv.optional(),
  })
  .meta({ id: 'BuildIntegration', description: 'An optional compose integration-test service run before release targets are built' });

/**
 * The manifest's `build` block (SHP-REQ-117): accepts only a Dockerfile path, BuildKit target
 * names, compose service names, argv arrays and secret names — never a command string. `source:
 * github` (the default, and Shipyard's own manifest per SHP-REQ-136) is today's behaviour: G5
 * reads the GitHub workflow run's image, and every other build field must be absent, so a manifest
 * cannot half-opt-in. `source: shipyard` has Shipyard itself build, test, and push the image.
 */
export const BuildConfig = z
  .strictObject({
    source: z.enum(['github', 'shipyard']).default('github'),
    /** Repo-relative; undefined means the consumer applies the default of `Dockerfile`. */
    dockerfile: RepoRelativePath.optional(),
    /** The BuildKit target run for tests; undefined means the consumer applies the default of `test`. */
    testTarget: BuildName.optional(),
    /** Every compose service in `services` mapped to the Dockerfile target that produces its image. */
    releaseTargets: z.record(z.string().min(1), BuildName).optional(),
    integration: BuildIntegration.optional(),
    /** Secret NAMES only — values never appear in the manifest. */
    secrets: z.array(BuildName).max(20).optional(),
  })
  .refine(
    (b) =>
      b.source === 'shipyard' ||
      (b.dockerfile === undefined &&
        b.testTarget === undefined &&
        b.releaseTargets === undefined &&
        b.integration === undefined &&
        b.secrets === undefined),
    {
      message: 'when build.source is github, no other build field may be set (SHP-REQ-136): CI already builds the image',
      path: ['source'],
    },
  )
  .meta({ id: 'BuildConfig', description: "The manifest's build block (SHP-REQ-117)" });
export type BuildConfig = z.infer<typeof BuildConfig>;
