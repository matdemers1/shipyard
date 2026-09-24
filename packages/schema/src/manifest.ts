import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { AppName, GhRepo, ProjectCode, Step } from './primitives.js';

/**
 * The host-local app manifest (SHP-REQ-004). Written as YAML on the host and
 * parsed here into one shared shape. Strict everywhere: an unknown key such as
 * `command` or `shell` on a step is rejected, not ignored.
 */

const ComposeConfig = z
  .strictObject({
    files: z.array(z.string().regex(/^\//, 'compose file paths must be absolute')).min(1),
    project: z.string().min(1),
  })
  .meta({ id: 'ComposeConfig', description: 'Compose files and project name for this app' });

const ServiceConfig = z
  .strictObject({
    image: z
      .string()
      .min(1)
      .refine((v) => !v.includes(':'), 'image must not include a tag; the tag is chosen at deploy time'),
  })
  .meta({ id: 'ServiceConfig', description: 'The untagged image for one compose service' });

const HealthConfig = z
  .strictObject({
    service: z.string().min(1),
    path: z.string().regex(/^\//, 'health path must start with /'),
    expectSchema: z.string().min(1).optional(),
  })
  .meta({ id: 'HealthConfig', description: 'The service and path polled to confirm a deploy is healthy' });

const ForemanConfig = z
  .strictObject({
    project: ProjectCode,
  })
  .meta({ id: 'ForemanConfig', description: 'The Foreman project a deploy is recorded against' });

const ManifestSteps = z
  .strictObject({
    backup: Step.optional(),
    migrate: Step.optional(),
  })
  .meta({ id: 'ManifestSteps', description: 'Optional backup/migrate steps run before an image swap' });

export const Manifest = z
  .strictObject({
    name: AppName,
    repo: GhRepo,
    defaultBranch: z.string().min(1).default('main'),
    workflow: z.string().min(1),
    compose: ComposeConfig,
    services: z.record(z.string().min(1), ServiceConfig).refine((v) => Object.keys(v).length > 0, 'at least one service is required'),
    health: HealthConfig,
    soakSeconds: z.int().min(0).max(3600).default(60),
    approval: z.enum(['none', 'required']).default('none'),
    steps: ManifestSteps.optional(),
    requiredEnv: z.array(z.string().min(1)).optional(),
    foreman: ForemanConfig.optional(),
    group: z.string().min(1).optional(),
    canary: z.boolean().optional(),
  })
  .meta({ id: 'Manifest', description: 'The host-local app manifest (SHP-REQ-004)' });

export type Manifest = z.infer<typeof Manifest>;

/** Parses a manifest YAML document, throwing a ZodError (or SyntaxError for bad YAML) on failure. */
export function parseManifestYaml(text: string): Manifest {
  const parsed: unknown = parseYaml(text);
  return Manifest.parse(parsed);
}
