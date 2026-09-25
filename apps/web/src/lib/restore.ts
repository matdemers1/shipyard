import type { DeployAccepted, RestoreCandidate, RestoreCandidates } from '@shipyard/schema';
import { request } from './api';

/**
 * Guided restore (S7, SHP-T-5.6, SHP-REQ-083..085). The candidates come only from the server,
 * which lists the backups the agent reported its deploys took; the agent re-checks its own ledger.
 * The console asks for the app's name typed exactly before it sends anything (SHP-D-038).
 */

export type { RestoreCandidate, RestoreCandidates };

const path = (app: string): string => `/api/apps/${encodeURIComponent(app)}/restore`;

export const restore = {
  candidates: (app: string, signal?: AbortSignal): Promise<RestoreCandidates> =>
    request<RestoreCandidates>(path(app), signal !== undefined ? { signal } : {}),
  start: (app: string, backupDeployId: string, confirm: string): Promise<DeployAccepted> =>
    request<DeployAccepted>(path(app), { method: 'POST', body: { backupDeployId, confirm } }),
};

/** The typed confirmation must be the app's name exactly: no trimming, no case folding. */
export function confirmMatches(typed: string, app: string): boolean {
  return typed === app;
}

/** The loss window in plain words, as the confirm sheet and the list say it. */
export function lossSentence(candidate: Pick<RestoreCandidate, 'lossWindow'>): string {
  return `Writes made in the last ${candidate.lossWindow} will be lost.`;
}

/** Bytes for a person: "512 B", "4.0 KB", "1.2 GB". */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'size unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${String(value)} B` : `${value.toFixed(1)} ${units[unit] ?? ''}`;
}
