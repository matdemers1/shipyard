import { z } from 'zod';

import type { DeployTargetState } from './agent.js';
import { Requester } from './api.js';
import type { Refusal } from './errors.js';
import { AppName, Sha40 } from './primitives.js';

/**
 * Scheduled deploy API contracts (SHP-T-5.4, SHP-REQ-080/081, SHP-D-039, SHP-D-051).
 *
 * A schedule names one app and one specific 40-hex SHA — never "the latest green" — and a time.
 * At that time every gate re-runs: the server's (unknown app, drift, freeze, lock) and then the
 * agent's (CI, default branch, ahead of live, digests, env, disk), exactly as for a deploy
 * requested then. A gate that fails refuses the deploy and the refusal is recorded on it.
 *
 * Approval is captured when the deploy is scheduled, never at fire time: a console user scheduling
 * an approval-required app is the approval; a token scheduling one leaves it awaiting a deployer's
 * approval, and unapproved at its fire time it is refused.
 */

/** The furthest ahead a deploy may be scheduled. */
export const SCHEDULE_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

export const ScheduleRequest = z
  .strictObject({
    app: AppName,
    sha: Sha40,
    /** ISO datetime; in the future and at most 30 days out. */
    fireAt: z.iso.datetime({ offset: true }),
    /** Required for a token (who it acts for, shown to anyone the deploy locks out); ignored for a console user. */
    requester: Requester.optional(),
  })
  .meta({ id: 'ScheduleRequest', description: 'POST /api/schedules body' });
export type ScheduleRequest = z.infer<typeof ScheduleRequest>;

/*
 * The shapes below are responses only (the server writes them; nothing parses them), so they are
 * plain types rather than Zod schemas, and carry no fixtures.
 */

/**
 * The approval behind a schedule:
 * - `not_required` — the app's manifest does not require approval.
 * - `approved` — given, by `approval.by` at `approval.at` (at scheduling for a console user).
 * - `awaiting` — a token scheduled an approval-required app; a deployer has not approved it yet.
 * - `denied` — a deployer denied it; the schedule is cancelled.
 * - `expired` — its fire time came with no approval; the deploy was refused.
 */
export type ScheduleApprovalState = 'not_required' | 'approved' | 'awaiting' | 'denied' | 'expired';

/** Where a schedule is: waiting to fire, fired (see the deploy's state), or cancelled before firing. */
export type ScheduleStatus = 'upcoming' | 'fired' | 'cancelled';

export interface ScheduleEntry {
  id: string;
  deployId: string;
  app: string;
  sha: string;
  fireAt: string;
  firedAt: string | null;
  cancelledAt: string | null;
  status: ScheduleStatus;
  /** Who scheduled it: the console user, or the token's requester label. */
  by: string;
  requester: { label: string; repo: string | null; branch: string | null };
  approval: { state: ScheduleApprovalState; by: string | null; at: string | null };
  /** The deploy's own state: `queued` while upcoming, then whatever the deploy reached. */
  state: DeployTargetState;
  /** Why it was refused (or cancelled), when it was. */
  refusal: Refusal | null;
  createdAt: string;
}

/** `GET /api/schedules`. */
export interface ScheduleList {
  /** Not yet fired and not cancelled, soonest first. */
  upcoming: ScheduleEntry[];
  /** Fired or cancelled, most recent first. */
  past: ScheduleEntry[];
}
