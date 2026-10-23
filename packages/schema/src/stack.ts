import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { AppName } from './primitives.js';
import { BackupStep, ComposeConfig, ServiceConfig } from './manifest.js';
import { Digest } from './primitives.js';

/**
 * What a tracked service follows (SHP-ADR-010): `pinned` never offers an update; `{ tag }` follows
 * whatever that tag points at (`latest`, `release`, `17`); `{ semver }` follows the highest tag in
 * a range such as `17.x` or `^1.4`, read from the registry's tag list.
 */
export const StackTrack = z
  .union([
    z.literal('pinned'),
    z.strictObject({ tag: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, 'a registry tag') }),
    z.strictObject({ semver: z.string().regex(/^[0-9xX^~<>=*.| -]{1,64}$/, 'a semver range such as 17.x or ^1.4') }),
  ])
  .meta({ id: 'StackTrack', description: 'What a tracked service follows: pinned, a tag, or a semver range' });
export type StackTrack = z.infer<typeof StackTrack>;

export const StackService = z
  .strictObject({
    image: ServiceConfig.shape.image,
    track: StackTrack,
  })
  .meta({ id: 'StackService', description: 'A stack service whose image Shipyard updates by digest' });
export type StackService = z.infer<typeof StackService>;

/** The container's own healthcheck by default; an HTTP path when the image has none. */
export const StackHealth = z
  .strictObject({
    service: z.string().min(1),
    port: z.int().min(1).max(65535),
    path: z.string().regex(/^\//, 'health path must start with /'),
  })
  .meta({ id: 'StackHealth', description: 'The HTTP check a stack update waits for, when the image has no healthcheck' });

const StackBase = {
  kind: z.literal('stack'),
  name: AppName,
  compose: ComposeConfig,
  /** Env files whose values are redacted from action output and logs (SHP-ADR-011). Absolute paths. */
  envFiles: z.array(z.string().regex(/^\//, 'env file paths must be absolute')).optional(),
};

/** `none`: start, stop, restart and recreate only; something else (ZimaOS's app store, say) updates it. */
const LifecycleOnlyStack = z.strictObject({
  ...StackBase,
  updates: z.literal('none').default('none'),
});

/**
 * `digest` (SHP-P-16): Shipyard also updates the named services to the digest their track resolves
 * to, with an optional backup first, a health check and soak after, and image-only rollback.
 */
const DigestUpdatedStack = z
  .strictObject({
    ...StackBase,
    updates: z.literal('digest'),
    services: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/), StackService).refine((v) => Object.keys(v).length > 0, 'at least one service is required'),
    steps: z.strictObject({ backup: BackupStep.optional() }).optional(),
    health: StackHealth.optional(),
    soakSeconds: z.int().min(0).max(3600).default(60),
    /** Who must approve an update: requests from tokens (default), every request, or none. */
    approval: z.enum(['tokens', 'always', 'never']).default('tokens'),
  });

/**
 * A third-party stack adopted into Shipyard's Operated tier (SHP-ADR-010), written as YAML on the
 * host under `<data root>/stacks/<name>.yml`, apart from the D3 app manifests in `apps/`, so no
 * deploy code path ever reads one as an app. Adoption stays a host act (SHP-D-059). Strict: an
 * unknown key is refused.
 */
export const StackManifest = z
  .union([LifecycleOnlyStack, DigestUpdatedStack])
  .meta({ id: 'StackManifest', description: 'A host-local manifest adopting a third-party compose stack (SHP-ADR-010)' });
export type StackManifest = z.infer<typeof StackManifest>;

/** Parses a stack manifest YAML document, throwing a ZodError (or SyntaxError for bad YAML) on failure. */
export function parseStackManifestYaml(text: string): StackManifest {
  const parsed: unknown = parseYaml(text);
  return StackManifest.parse(parsed);
}

/** One adopted stack as the agent reports it. */
/** One tracked service as the agent last saw it (SHP-REQ-194). */
export const AgentStackService = z
  .strictObject({
    /** The digest its running container carries; null when none runs. */
    running: Digest.nullable(),
    /** What its track resolves to now, when that differs from `running`; null when up to date or pinned. */
    candidate: z.strictObject({ tag: z.string().min(1).max(128), digest: Digest }).nullable(),
    checkedAt: z.iso.datetime({ offset: true }).nullable(),
    /** Why the last check failed (registry unreachable, no tag in range); null when it did not. */
    error: z.string().max(500).nullable(),
  })
  .meta({ id: 'AgentStackService', description: "A tracked service's running digest and update candidate" });
export type AgentStackService = z.infer<typeof AgentStackService>;

export const AgentStack = z
  .strictObject({
    manifest: StackManifest,
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/, '64 lowercase hex characters'),
    /** Per tracked service, for `updates: digest` stacks; absent from older agents and lifecycle-only stacks. */
    services: z.record(z.string().min(1), AgentStackService).optional(),
  })
  .meta({ id: 'AgentStack', description: 'An adopted stack as reported by the agent' });
export type AgentStack = z.infer<typeof AgentStack>;
