import { z } from 'zod';

import { AppName, Sha40 } from './primitives.js';
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
