import { z } from 'zod';

import { AppName, Digest, Sha40 } from './primitives.js';
import { Refusal } from './errors.js';
import { DeployTargetState } from './agent.js';
import { ActionTarget, LifecycleVerb, ServiceName } from './actions.js';
import { Digest as DigestRef } from './primitives.js';

/**
 * REST API request/response shapes (SHP-REQ-004). Kept transform/refinement-free
 * where practical so z.toJSONSchema (SHP-T-0.7) can render them directly.
 */

/** Short, printable text: it is echoed into lock refusals, logs and the console. */
const RequesterText = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}]*$/u, 'no control characters');

export const Requester = z
  .strictObject({
    repo: RequesterText,
    branch: RequesterText,
    label: RequesterText,
  })
  .meta({ id: 'Requester', description: 'Who or what asked for this deploy, for the audit trail' });
export type Requester = z.infer<typeof Requester>;

export const DeployKind = z
  .enum(['deploy', 'rollback', 'restore'])
  .meta({ id: 'DeployKind', description: 'The kind of deploy target requested' });
export type DeployKind = z.infer<typeof DeployKind>;

// The exactly-one-of-app/group rule needs a refine that z.toJSONSchema cannot
// express structurally; SHP-T-0.7 documents this constraint in prose instead.
export const DeployRequest = z
  .strictObject({
    kind: DeployKind,
    app: AppName.optional(),
    group: z.string().min(1).optional(),
    /** Required for a deploy; for a rollback the SHA comes from the target deploy's record. */
    sha: Sha40.optional(),
    /** A rollback's target: an earlier deploy of the same app (checked against the agent's ledger). */
    toDeployId: z.uuid().optional(),
    dryRun: z.boolean().optional(),
    requester: Requester.optional(),
  })
  .refine((v) => (v.app === undefined) !== (v.group === undefined), 'exactly one of app or group is required')
  .refine((v) => v.kind !== 'deploy' || v.sha !== undefined, 'a deploy needs a sha')
  .refine((v) => v.kind !== 'rollback' || (v.toDeployId !== undefined && v.app !== undefined), 'a rollback needs an app and toDeployId')
  .refine((v) => v.kind === 'rollback' || v.toDeployId === undefined, 'toDeployId is only for a rollback')
  .meta({ id: 'DeployRequest', description: 'A request to deploy a single app or a group (SHP-REQ-004); the only host-reaching data is an app name and a 40-hex SHA' });
export type DeployRequest = z.infer<typeof DeployRequest>;

export const DeployAccepted = z
  .strictObject({
    deployId: z.string().min(1),
    state: DeployTargetState,
  })
  .meta({ id: 'DeployAccepted', description: 'Returned once a deploy request is accepted' });
export type DeployAccepted = z.infer<typeof DeployAccepted>;

export const HealthResponse = z
  .strictObject({
    status: z.literal('ok'),
    schemaRevision: z.string().min(1).nullable(),
    version: z.string().min(1),
  })
  .meta({ id: 'HealthResponse', description: 'The /health response' });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const LoginRequest = z
  .strictObject({
    email: z.email(),
    password: z.string().min(1),
  })
  .meta({ id: 'LoginRequest', description: 'App-native login credentials' });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const TotpRequest = z
  .strictObject({
    code: z.string().regex(/^[0-9]{6}$/, 'exactly 6 digits'),
  })
  .meta({ id: 'TotpRequest', description: 'A TOTP code submitted during login' });
export type TotpRequest = z.infer<typeof TotpRequest>;

// ─── Phase 2 (pre-flight, lead-owned) ─────────────────────────────────────────

/** The agent's first contact: its public key, confirmed later in the console by fingerprint (SHP-D-064). */
export const EnrolRequest = z
  .strictObject({
    /** Raw 32-byte Ed25519 public key, base64. */
    publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'a base64 32-byte Ed25519 public key'),
    agentVersion: z.string().min(1).max(100),
  })
  .meta({ id: 'EnrolRequest', description: 'An agent presenting its public key for enrolment' });
export type EnrolRequest = z.infer<typeof EnrolRequest>;

export const TokenCreate = z
  .strictObject({
    label: z.string().min(1).max(100),
    /** The apps this token may act on (SHP-REQ-046); at least one. */
    apps: z.array(AppName).min(1),
    /** May this token read container logs over MCP (SHP-ADR-011, SHP-REQ-193)? Off unless asked for. */
    canReadLogs: z.boolean().optional(),
  })
  .meta({ id: 'TokenCreate', description: 'Issue an API token scoped to named apps' });
export type TokenCreate = z.infer<typeof TokenCreate>;

export const TokenCreated = z
  .strictObject({
    id: z.string().min(1),
    label: z.string(),
    prefix: z.string(),
    apps: z.array(AppName),
    /** Shown exactly once; only its hash is stored. */
    token: z.string().min(20),
  })
  .meta({ id: 'TokenCreated', description: 'A newly issued API token, shown once' });
export type TokenCreated = z.infer<typeof TokenCreated>;

/** One deploy target's state as REST and MCP report it (SHP-REQ-044). */
export const DeployStatus = z
  .strictObject({
    deployId: z.string().min(1),
    kind: DeployKind,
    app: AppName,
    sha: Sha40,
    dryRun: z.boolean(),
    state: DeployTargetState,
    currentStep: z.string().nullable(),
    requester: z.strictObject({ label: z.string(), repo: z.string().nullable(), branch: z.string().nullable() }),
    images: z.array(z.strictObject({ service: z.string(), sha: Sha40, digest: Digest, migration: z.string().nullable().optional() })),
    schemaRevision: z.string().nullable(),
    refusal: Refusal.nullable(),
    gates: z.array(z.strictObject({ gate: z.string(), pass: z.boolean(), reason: z.string() })),
    createdAt: z.string(),
    endedAt: z.string().nullable(),
    /**
     * Present only for a group deploy (SHP-REQ-078, SHP-REQ-079): every member in deploy order —
     * the canary first, then the rest by app name. The fields above still describe the *current*
     * member — the first not yet terminal, or else the last one that actually ran — so a caller
     * reading only the top level keeps working exactly as it did for a single-app deploy.
     */
    group: z
      .strictObject({
        name: z.string().min(1),
        members: z.array(
          z.strictObject({
            app: AppName,
            state: DeployTargetState,
            refusal: Refusal.nullable(),
            canary: z.boolean(),
            position: z.number().int().nonnegative(),
            targetId: z.string().min(1),
          }),
        ),
      })
      .optional(),
  })
  .meta({ id: 'DeployStatus', description: 'A deploy target and, when finished, what it shipped' });
export type DeployStatus = z.infer<typeof DeployStatus>;

/**
 * `POST /api/actions` (SHP-ADR-010). Without `service` the verb applies to the whole compose
 * project. Lives beside the other REST bodies; the agent protocol half is in actions.ts.
 */
export const ActionRequest = z
  .strictObject({
    target: ActionTarget,
    verb: LifecycleVerb,
    service: ServiceName.optional(),
    requester: Requester.optional(),
  })
  .meta({ id: 'ActionRequest', description: 'Start, stop, restart or recreate an app or stack, or one of its services' });
export type ActionRequest = z.infer<typeof ActionRequest>;

/**
 * `POST /api/stacks/:name/updates` (SHP-P-16). Without `digests` the server uses the candidates the
 * agent last reported; with them, each must be what the stack's track resolves to when the agent
 * runs it (`digest_not_tracked` otherwise).
 */
export const StackUpdateRequest = z
  .strictObject({
    digests: z.record(ServiceName, DigestRef).optional(),
    requester: Requester.optional(),
  })
  .meta({ id: 'StackUpdateRequest', description: 'Update an adopted stack to its tracked digests' });
export type StackUpdateRequest = z.infer<typeof StackUpdateRequest>;

/** `POST /api/stacks/:name/rollback`: back to an earlier successful update, from the agent's ledger. */
export const StackRollbackRequest = z
  .strictObject({
    toUpdateId: z.uuid(),
    requester: Requester.optional(),
  })
  .meta({ id: 'StackRollbackRequest', description: 'Roll an adopted stack back to an earlier update' });
export type StackRollbackRequest = z.infer<typeof StackRollbackRequest>;

// ─── SHP-P-17: volumes and prune (SHP-ADR-012) ────────────────────────────────

/**
 * `POST /api/volumes/:volume/backup` (SHP-REQ-201). The volume is the path parameter, so the body
 * names nothing: the server finds the owner from the agent's inventory and the agent archives it
 * with its own image, the volume read-only.
 */
export const VolumeBackupRequest = z
  .strictObject({})
  .meta({ id: 'VolumeBackupRequest', description: 'Back up the volume named in the path (no body fields)' });
export type VolumeBackupRequest = z.infer<typeof VolumeBackupRequest>;

/**
 * `POST /api/volumes/:volume/restore` (SHP-REQ-202): console-only, admin and step-up. The archive
 * is named by ID and must be in the agent's own ledger; the owning stack must be stopped.
 * `confirmVolume` is the volume's name typed back and must equal the path parameter.
 */
export const VolumeRestoreRequest = z
  .strictObject({
    archiveId: z.uuid(),
    confirmVolume: z.string().max(255),
  })
  .meta({ id: 'VolumeRestoreRequest', description: 'Restore a volume from an archive in the agent ledger, with the volume name typed to confirm' });
export type VolumeRestoreRequest = z.infer<typeof VolumeRestoreRequest>;

/** `DELETE /api/volumes/:volume` (SHP-REQ-203): console-only, admin and step-up, orphans only. */
export const VolumeDeleteRequest = z
  .strictObject({
    confirmVolume: z.string().max(255),
  })
  .meta({ id: 'VolumeDeleteRequest', description: 'Delete an orphan volume, with its name typed to confirm' });
export type VolumeDeleteRequest = z.infer<typeof VolumeDeleteRequest>;

const PruneAgeHours = z.int().min(24).max(8760).nullable();

/**
 * `POST /api/prune` (SHP-REQ-205). A dry run (the default) lists what would go; a real prune
 * names that dry run in `fromDryRunId` and removes only what it listed and is still eligible
 * (`dry_run_required` otherwise). `null` hours leaves that kind alone.
 */
export const PruneRequest = z
  .strictObject({
    dryRun: z.boolean().default(true),
    fromDryRunId: z.uuid().optional(),
    images: z
      .strictObject({
        dangling: z.boolean().default(true),
        unusedOlderThanHours: PruneAgeHours.default(168),
      })
      .optional(),
    buildCache: z
      .strictObject({
        olderThanHours: PruneAgeHours.default(168),
      })
      .optional(),
  })
  .refine((v) => v.dryRun || v.fromDryRunId !== undefined, {
    message: 'a prune that is not a dry run needs fromDryRunId',
    path: ['fromDryRunId'],
  })
  .meta({ id: 'PruneRequest', description: 'Dry-run or run a prune of dangling and old unused images and old build cache' });
export type PruneRequest = z.infer<typeof PruneRequest>;
