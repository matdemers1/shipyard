import { z } from 'zod';

import { AppName, Sha40 } from './primitives.js';
import { Requester, type DeployStatus } from './api.js';
import type { DeployTargetState } from './agent.js';

/**
 * Rollouts (SHP-T-12.1; SHP-REQ-151, SHP-REQ-152, SHP-REQ-153) — "Roll all" on Home.
 *
 * A rollout is several ordinary single-app deploys, each at its own SHA, shipped one at a time:
 * every member's lock is taken in one transaction, a member is dispatched only once every earlier
 * member has succeeded (its soak included), the first member that does not succeed cancels the rest
 * with `rollout_stopped`, and Shipyard's own app always ships last. Each member is a normal deploy,
 * so its live page, record, timeline row and Foreman record are the same as any other deploy's.
 *
 * Only app names and 40-hex SHAs reach the host, as with every deploy.
 */

export const RolloutItem = z
  .strictObject({
    app: AppName,
    sha: Sha40,
  })
  .meta({ id: 'RolloutItem', description: 'One app of a rollout and the SHA it ships' });
export type RolloutItem = z.infer<typeof RolloutItem>;

/** The most apps one rollout may name. */
export const MAX_ROLLOUT_ITEMS = 25;

export const RolloutRequest = z
  .strictObject({
    items: z.array(RolloutItem).min(1).max(MAX_ROLLOUT_ITEMS),
    requester: Requester.optional(),
  })
  .refine((v) => new Set(v.items.map((i) => i.app)).size === v.items.length, 'each app may appear once')
  .meta({
    id: 'RolloutRequest',
    description: 'Apps to roll one at a time, each at its own SHA; the server decides the order and always ships Shipyard last',
  });
export type RolloutRequest = z.infer<typeof RolloutRequest>;

/** One member of a rollout plan, in the order the rollout ships it. */
export interface RolloutPlanMember {
  app: string;
  sha: string;
  /** What is live now, from the recorded release; null when the app has never been deployed. */
  liveSha: string | null;
  /** True for Shipyard's own app, which always ships last. */
  self: boolean;
}

/** `POST /api/rollouts/plan`: what a rollout of these items would ship, in order, if it started now. */
export interface RolloutPlan {
  members: RolloutPlanMember[];
}

/** `POST /api/rollouts`: the accepted rollout and its members' deploy IDs, in order. */
export interface RolloutAccepted {
  rolloutId: string;
  deployIds: string[];
}

/** A rollout's status: the overall state and every member's own deploy status, in order. */
export interface RolloutStatus {
  rolloutId: string;
  requesterLabel: string;
  createdAt: string;
  /**
   * `succeeded` once every member has; otherwise the state of the first member that has not
   * succeeded — the one running, or the one that stopped the rollout.
   */
  state: DeployTargetState;
  members: (DeployStatus & { position: number; self: boolean })[];
}
