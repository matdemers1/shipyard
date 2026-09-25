import { z } from 'zod';

import { Digest } from './primitives.js';
import { Manifest } from './manifest.js';
import { Refusal } from './errors.js';

/**
 * The agent protocol (SHP-REQ-004): what the portless agent reports and what it
 * long-polls for, plus the state machine driving a deploy or rollback target.
 */

export const DeployTargetState = z
  .enum([
    'queued',
    'awaiting_approval',
    'locked',
    'verifying',
    'backing_up',
    'migrating',
    'pulling',
    'swapping',
    'checking',
    'soaking',
    'rolling_back',
    'succeeded',
    'failed',
    'rolled_back',
    'refused',
    'cancelled',
  ])
  .meta({ id: 'DeployTargetState', description: 'The state of a deploy or rollback target' });
export type DeployTargetState = z.infer<typeof DeployTargetState>;

/** Matches the DB's partial unique index on at-most-one active target per app. */
export const ACTIVE_STATES = [
  'locked',
  'verifying',
  'backing_up',
  'migrating',
  'pulling',
  'swapping',
  'checking',
  'soaking',
  'rolling_back',
] as const satisfies readonly DeployTargetState[];

export const SignatureHeaders = z
  .strictObject({
    'x-shipyard-key': z.string().min(1),
    'x-shipyard-timestamp': z.string().min(1),
    'x-shipyard-nonce': z.string().min(16),
    'x-shipyard-signature': z.base64(),
  })
  .meta({ id: 'SignatureHeaders', description: 'Ed25519 request signing headers used by the agent long-poll' });
export type SignatureHeaders = z.infer<typeof SignatureHeaders>;

const AgentApp = z
  .strictObject({
    manifest: Manifest,
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/, '64 lowercase hex characters'),
    running: z.record(z.string().min(1), Digest.nullable()),
  })
  .meta({ id: 'AgentApp', description: 'One app as reported by the agent, with its running image digests' });

export const AgentReport = z
  .strictObject({
    agentVersion: z.string().min(1),
    composeVersion: z.string().min(1),
    engineApiVersion: z.string().min(1),
    patExpiresAt: z.iso.datetime().nullable(),
    apps: z.array(AgentApp),
  })
  .meta({ id: 'AgentReport', description: 'What the agent reports about itself and the apps it manages' });
export type AgentReport = z.infer<typeof AgentReport>;

export const PollRequest = z
  .strictObject({
    waitSeconds: z.int().min(0).max(25),
  })
  .meta({ id: 'PollRequest', description: 'The agent long-poll request body' });
export type PollRequest = z.infer<typeof PollRequest>;

const PollTarget = z
  .strictObject({
    targetId: z.string().min(1),
    deployId: z.string().min(1),
    kind: z.enum(['deploy', 'rollback', 'restore']),
    app: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}$/, 'exactly 40 lowercase hex characters'),
    dryRun: z.boolean(),
    /** A rollback's target deploy; the agent resolves its digests from its own ledger (SHP-D-080). */
    toDeployId: z.string().min(1).optional(),
    /** The requester label, for the agent's logs and lock file. Display only. */
    requesterLabel: z.string().max(200).optional(),
  })
  .meta({ id: 'PollTarget', description: 'A target for the agent to execute' });

export const PollResponse = z
  .union([
    z.strictObject({ target: z.null() }),
    z.strictObject({ target: PollTarget }),
  ])
  .meta({ id: 'PollResponse', description: 'Either no work, or one target to execute' });
export type PollResponse = z.infer<typeof PollResponse>;

export const StepJournal = z
  .strictObject({
    targetId: z.string().min(1),
    name: z.string().min(1),
    argv: z.array(z.string()).min(1),
    phase: z.enum(['start', 'end']),
    exitCode: z.int().optional(),
    output: z.string().max(65536, 'output is truncated to 64KiB').optional(),
  })
  .meta({ id: 'StepJournal', description: 'A step journaled locally before it runs (SHP-D-029, SHP-D-081)' });
export type StepJournal = z.infer<typeof StepJournal>;

const TargetImage = z
  .strictObject({
    service: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{40}$/, 'exactly 40 lowercase hex characters'),
    digest: Digest,
  })
  .meta({ id: 'TargetImage', description: 'The image swapped in for one service' });

export const TargetResult = z
  .strictObject({
    targetId: z.string().min(1),
    state: z.enum(['succeeded', 'failed', 'rolled_back', 'refused', 'cancelled']),
    images: z.array(TargetImage),
    schemaRevision: z.string().min(1).optional(),
    refusal: Refusal.optional(),
  })
  .meta({ id: 'TargetResult', description: 'The terminal result of an executed target' });
export type TargetResult = z.infer<typeof TargetResult>;
