import { z } from 'zod';

import { AppName, Sha40 } from './primitives.js';

/**
 * Guided restore API contracts (SHP-T-5.6, SHP-REQ-083..085, SHP-D-038). Console only: the app's
 * own restore command against a backup a deploy took, stating the loss window in time and
 * requiring the app's name to be typed. The request names a deploy, never a path: the agent finds
 * the artifact in its own ledger (SHP-REQ-085).
 */

/** At most one completed restore per app in this many hours (SHP-REQ-084). */
export const RESTORE_LIMIT_HOURS = 24;

export const RestoreRequest = z
  .strictObject({
    /** The deploy whose backup artifact is restored. */
    backupDeployId: z.uuid(),
    /** The app's name, typed by hand; must equal it exactly. */
    confirm: z.string().min(1).max(63),
  })
  .meta({ id: 'RestoreRequest', description: 'POST /api/apps/:app/restore body' });
export type RestoreRequest = z.infer<typeof RestoreRequest>;

export const RestoreCandidate = z
  .strictObject({
    /** The deploy that took this backup: the ID a restore request names. */
    backupDeployId: z.uuid(),
    /** What that deploy was (a restore's own safety backup is a candidate too). */
    backupDeployKind: z.enum(['deploy', 'rollback', 'restore']),
    /** The SHA that deploy asked for. */
    backupDeploySha: Sha40,
    /** The artifact's path on the host, as the agent reported it. Display only. */
    path: z.string().min(1),
    size: z.int().min(0).nullable(),
    createdAt: z.iso.datetime(),
    /** Seconds since the backup was taken: writes made since then are lost by restoring it. */
    lossWindowSeconds: z.int().min(0),
    /** The loss window in words, e.g. "3 hours 12 minutes". */
    lossWindow: z.string().min(1),
    /** The release the agent will run with this data, when the server can tell. */
    releaseSha: Sha40.nullable(),
    /** False while a restore of this app completed within the last 24 hours. */
    available: z.boolean(),
  })
  .meta({ id: 'RestoreCandidate', description: 'A backup a deploy took, offered for restore' });
export type RestoreCandidate = z.infer<typeof RestoreCandidate>;

export const RestoreCandidates = z
  .strictObject({
    app: AppName,
    /** Set while the 24-hour limit holds: when the last restore completed and when it frees up. */
    limited: z.strictObject({ lastRestoreAt: z.iso.datetime(), freesAt: z.iso.datetime() }).nullable(),
    /** Newest first. */
    candidates: z.array(RestoreCandidate),
  })
  .meta({ id: 'RestoreCandidates', description: 'GET /api/apps/:app/restore response' });
export type RestoreCandidates = z.infer<typeof RestoreCandidates>;

function plural(n: number, unit: string): string {
  return `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * A loss window in plain words, at most two units: "45 seconds", "3 hours 12 minutes",
 * "2 days 4 hours". Never rounds a non-zero window down to nothing.
 */
export function lossWindowText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return plural(s, 'second');
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(rest, 'minute')}`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? plural(days, 'day') : `${plural(days, 'day')} ${plural(rest, 'hour')}`;
}
