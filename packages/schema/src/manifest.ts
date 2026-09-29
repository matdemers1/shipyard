import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { AppName, GhRepo, ProjectCode, Step } from './primitives.js';
import { BuildConfig } from './build.js';

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

/**
 * An untagged OCI repository reference: `[host[:port]/]path`, path components lowercase per the
 * distribution grammar. Strict because the string is embedded in argv tokens that other tools parse
 * further — BuildKit's comma-separated `--output type=image,name=<ref>,push=true` among them — so a
 * `,` or `=` here would smuggle options past the manifest (SHP-REQ-117, SHP-REQ-127).
 */
const IMAGE_REPOSITORY_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;

const ServiceConfig = z
  .strictObject({
    image: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => !v.includes('@') && !(v.split('/').pop() ?? '').includes(':'), 'image must not include a tag or digest; both are chosen at deploy time')
      .refine((v) => IMAGE_REPOSITORY_RE.test(v), 'image must be a plain repository reference: [host[:port]/]lowercase/path, no commas, spaces or `=`'),
  })
  .meta({ id: 'ServiceConfig', description: 'The untagged image for one compose service' });

const HealthConfig = z
  .strictObject({
    service: z.string().min(1),
    /** The container port the check reaches over the app's own Docker network (SHP-D-056). */
    port: z.int().min(1).max(65535),
    path: z.string().regex(/^\//, 'health path must start with /'),
    /**
     * The schema revision /health must report. Usually omitted: the image's
     * `dev.d3cloud.shipyard.schema` label supplies it, and without either the check only requires
     * that a schema revision is reported at all (SHP-D-019, SHP-D-022).
     */
    expectSchema: z.string().min(1).optional(),
  })
  .meta({ id: 'HealthConfig', description: 'The service and path polled to confirm a deploy is healthy' });

const ForemanConfig = z
  .strictObject({
    project: ProjectCode,
    environment: z.string().min(1).default('production'),
  })
  .meta({ id: 'ForemanConfig', description: 'The Foreman project a deploy is recorded against' });

/**
 * The app's own backup command, exec'd in its running container (SHP-D-018). Success is exit 0 plus
 * a new non-empty file under `artifactsDir` created since the step began (SHP-D-054).
 */
const BackupStep = z
  .strictObject({
    service: z.string().min(1),
    argv: Step.shape.argv,
    artifactsDir: z.string().regex(/^\//, 'artifactsDir must be an absolute host path'),
  })
  .meta({ id: 'BackupStep', description: 'Backup command and the host directory its artifact appears in' });

/** The literal token in a restore argv that the agent replaces with the artifact's file name. */
export const RESTORE_ARTIFACT_TOKEN = '{artifact}';

/**
 * The app's own restore command (SHP-D-038), exec'd in its running container like the backup.
 * One or more argv entries carry the literal token `{artifact}`, which the agent replaces with the
 * restored artifact's **file name** — the container names its own mount of the backups directory
 * (e.g. `/backups/{artifact}`). Never a shell; the name is checked against `[A-Za-z0-9._-]+`
 * before it is substituted.
 */
const RestoreStep = z
  .strictObject({
    service: z.string().min(1),
    argv: Step.shape.argv.refine(
      (argv) => argv.some((arg) => arg.includes(RESTORE_ARTIFACT_TOKEN)),
      `restore argv must name the artifact with the literal token ${RESTORE_ARTIFACT_TOKEN}`,
    ),
  })
  .meta({ id: 'RestoreStep', description: 'Restore command; {artifact} is replaced by the backup file name' });

const ManifestSteps = z
  .strictObject({
    backup: BackupStep.optional(),
    /** Run as a one-shot `compose run --rm` with the new image before the swap (SHP-D-028). */
    migrate: Step.optional(),
    /** Guided restore from the console only (SHP-D-038); needs `backup`, whose artifacts it restores. */
    restore: RestoreStep.optional(),
  })
  .refine((steps) => steps.restore === undefined || steps.backup !== undefined, {
    message: 'steps.restore needs steps.backup: a restore only ever uses an artifact the backup step took',
    path: ['restore'],
  })
  .meta({ id: 'ManifestSteps', description: 'Optional backup/migrate/restore steps' });

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
    /** Env files whose values are redacted from stored step output (SHP-D-082). Absolute paths. */
    envFiles: z.array(z.string().regex(/^\//, 'env file paths must be absolute')).optional(),
    /** Refuse before locking when the Docker root has less free space than this (SHP-D-083). */
    diskFloorGb: z.number().min(0).max(1000).default(5),
    /** Old Shipyard-deployed images kept per service after a success. */
    retainImages: z.int().min(1).max(20).default(3),
    /**
     * How the app's images are built (SHP-REQ-117). Undefined means today's behaviour: G5 reads
     * the GitHub workflow run for the SHA, same as `{ source: 'github' }`.
     */
    build: BuildConfig.optional(),
    /**
     * Request one deploy of each successful Shipyard build through the normal sequence, every gate,
     * freeze, lock and approval applying (SHP-REQ-138). Requires `build.source: shipyard`. Undefined
     * means false; optional rather than defaulted so hand-built Manifest values need not name it.
     */
    autoDeploy: z.boolean().optional(),
  })
  .refine((m) => !m.autoDeploy || m.build?.source === 'shipyard', {
    message: 'autoDeploy requires build.source to be shipyard',
    path: ['autoDeploy'],
  })
  .refine(
    (m) => {
      if (m.build?.source !== 'shipyard') return true;
      const releaseTargets = m.build.releaseTargets;
      if (releaseTargets === undefined) return false;
      const serviceKeys = Object.keys(m.services).sort();
      const targetKeys = Object.keys(releaseTargets).sort();
      return serviceKeys.length === targetKeys.length && serviceKeys.every((k, i) => k === targetKeys[i]);
    },
    {
      message: 'build.releaseTargets must map every compose service to a build target, with no extras, when build.source is shipyard',
      path: ['build', 'releaseTargets'],
    },
  )
  .meta({ id: 'Manifest', description: 'The host-local app manifest (SHP-REQ-004)' });

export type Manifest = z.infer<typeof Manifest>;

/** Parses a manifest YAML document, throwing a ZodError (or SyntaxError for bad YAML) on failure. */
export function parseManifestYaml(text: string): Manifest {
  const parsed: unknown = parseYaml(text);
  return Manifest.parse(parsed);
}
