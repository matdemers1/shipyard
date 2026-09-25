import { z } from 'zod';

import { AppName, Digest, Sha40 } from './primitives.js';
import { Refusal } from './errors.js';
import { DeployTargetState } from './agent.js';

/**
 * REST API request/response shapes (SHP-REQ-004). Kept transform/refinement-free
 * where practical so z.toJSONSchema (SHP-T-0.7) can render them directly.
 */

export const Requester = z
  .strictObject({
    repo: z.string().min(1),
    branch: z.string().min(1),
    label: z.string().min(1),
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
    sha: Sha40,
    dryRun: z.boolean().optional(),
    requester: Requester.optional(),
  })
  .refine((v) => (v.app === undefined) !== (v.group === undefined), 'exactly one of app or group is required')
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
    images: z.array(z.strictObject({ service: z.string(), sha: Sha40, digest: Digest })),
    schemaRevision: z.string().nullable(),
    refusal: Refusal.nullable(),
    gates: z.array(z.strictObject({ gate: z.string(), pass: z.boolean(), reason: z.string() })),
    createdAt: z.string(),
    endedAt: z.string().nullable(),
  })
  .meta({ id: 'DeployStatus', description: 'A deploy target and, when finished, what it shipped' });
export type DeployStatus = z.infer<typeof DeployStatus>;
