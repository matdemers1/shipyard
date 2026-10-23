import { z } from 'zod';

import { AppName, Digest } from './primitives.js';
import { Refusal } from './errors.js';

/**
 * Updating an adopted stack by digest (SHP-ADR-010, SHP-P-16): the job the server hands an agent
 * that advertises `stack-updates`, its progress and result, and the REST shapes. What reaches the
 * host is a stack name the host's own manifest defines and, per service, a `sha256:` digest — the
 * agent re-resolves the stack's track and refuses a digest it does not resolve to now
 * (`digest_not_tracked`, SHP-REQ-195). A rollback names an earlier update; the agent takes the
 * digests from its own ledger, never from the request (non-negotiable 7).
 */

const ServiceKey = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, 'a compose service name');

export const StackUpdateJob = z
  .union([
    z.strictObject({
      updateId: z.uuid(),
      kind: z.literal('update'),
      stack: AppName,
      digests: z.record(ServiceKey, Digest).refine((v) => Object.keys(v).length > 0, 'at least one service'),
      requesterLabel: z.string().max(200).optional(),
    }),
    z.strictObject({
      updateId: z.uuid(),
      kind: z.literal('rollback'),
      stack: AppName,
      /** The earlier update whose digests the agent restores from its own ledger. */
      toUpdateId: z.uuid(),
      requesterLabel: z.string().max(200).optional(),
    }),
  ])
  .meta({ id: 'StackUpdateJob', description: 'Update an adopted stack to digests, or roll it back to an earlier update' });
export type StackUpdateJob = z.infer<typeof StackUpdateJob>;

export const StackUpdateStep = z
  .enum(['verifying', 'backing_up', 'pulling', 'swapping', 'checking', 'soaking', 'rolling_back'])
  .meta({ id: 'StackUpdateStep', description: 'Where a running stack update is' });
export type StackUpdateStep = z.infer<typeof StackUpdateStep>;

export const StackUpdateProgress = z
  .strictObject({
    updateId: z.uuid(),
    step: StackUpdateStep,
  })
  .meta({ id: 'StackUpdateProgress', description: 'A running stack update moved to a new step' });
export type StackUpdateProgress = z.infer<typeof StackUpdateProgress>;

const StackImage = z.strictObject({
  service: ServiceKey,
  /** The tag the image line names (the track's tag at the time), or null for a pinned digest. */
  tag: z.string().min(1).max(128).nullable(),
  digest: Digest,
});

export const StackUpdateResult = z
  .strictObject({
    updateId: z.uuid(),
    state: z.enum(['succeeded', 'failed', 'rolled_back', 'refused']),
    /** What runs now (after success, or after an automatic rollback). */
    images: z.array(StackImage).max(50),
    /** What ran before; recorded so the console can say what changed. */
    previous: z.array(StackImage).max(50),
    refusal: Refusal.optional(),
    /** The backup the update took, when the stack has a backup step. */
    backupArtifact: z.strictObject({ path: z.string().min(1), size: z.int().min(0), createdAt: z.iso.datetime() }).optional(),
  })
  .meta({ id: 'StackUpdateResult', description: 'The terminal result of a stack update or rollback' });
export type StackUpdateResult = z.infer<typeof StackUpdateResult>;

export const StackUpdateState = z
  .enum(['queued', 'awaiting_approval', 'dispatched', 'running', 'succeeded', 'failed', 'rolled_back', 'refused', 'denied', 'cancelled'])
  .meta({ id: 'StackUpdateState', description: 'Where a stack update is' });
export type StackUpdateState = z.infer<typeof StackUpdateState>;

export const StackUpdateStatus = z
  .strictObject({
    id: z.uuid(),
    stack: AppName,
    kind: z.enum(['update', 'rollback']),
    state: StackUpdateState,
    step: StackUpdateStep.nullable(),
    /** Requested digests per service (an update); null for a rollback until it finishes. */
    digests: z.record(ServiceKey, Digest).nullable(),
    images: z.array(StackImage),
    previous: z.array(StackImage),
    toUpdateId: z.uuid().nullable(),
    requesterLabel: z.string().max(200),
    approvedBy: z.string().max(200).nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    endedAt: z.iso.datetime({ offset: true }).nullable(),
    refusal: Refusal.nullable(),
  })
  .meta({ id: 'StackUpdateStatus', description: 'A stack update or rollback and its outcome' });
export type StackUpdateStatus = z.infer<typeof StackUpdateStatus>;

export const StackUpdatePage = z
  .strictObject({
    items: z.array(StackUpdateStatus),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'StackUpdatePage', description: 'Stack updates, newest first' });
export type StackUpdatePage = z.infer<typeof StackUpdatePage>;
