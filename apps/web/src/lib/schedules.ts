import type { DeployAccepted, ScheduleEntry, ScheduleList, ScheduleRequest } from '@shipyard/schema';
import { request } from './api';

/**
 * Schedules (S9, SHP-T-5.4, SHP-REQ-080/081, SHP-D-039, SHP-D-051). A schedule names one app, one
 * full SHA and a time; every gate re-runs when it fires, and a gate that fails refuses it with the
 * reason shown here. Approval is captured when it is scheduled: scheduling from the console is the
 * approval; one a token scheduled waits for a deployer's approval before its time.
 */

export type { ScheduleEntry, ScheduleList };

export const SCHEDULE_MAX_DAYS = 30;

export const schedules = {
  list: (signal?: AbortSignal): Promise<ScheduleList> => request<ScheduleList>('/api/schedules', signal !== undefined ? { signal } : {}),
  create: (body: ScheduleRequest): Promise<ScheduleEntry> => request<ScheduleEntry>('/api/schedules', { method: 'POST', body }),
  cancel: (id: string): Promise<ScheduleEntry> => request<ScheduleEntry>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** A token-made schedule of an approval-required app: approve it now; it still fires at its time. */
  approve: (deployId: string): Promise<DeployAccepted> =>
    request<DeployAccepted>(`/api/deploys/${encodeURIComponent(deployId)}/approve`, { method: 'POST' }),
};

/** A full 40-character lowercase SHA: a schedule never names "the latest green" (SHP-D-039). */
export function shaIsValid(sha: string): boolean {
  return /^[0-9a-f]{40}$/.test(sha);
}

/** `datetime-local`'s value has no timezone; read as local time, sent to the server as ISO. */
export function localToIso(value: string): string | null {
  if (value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Why `iso` cannot be a fire time, as of `now`; null when it can. */
export function fireAtProblem(iso: string | null, now: number = Date.now()): string | null {
  if (iso === null) return 'Pick a date and time.';
  const at = Date.parse(iso);
  if (at <= now) return 'Pick a time in the future.';
  if (at - now > SCHEDULE_MAX_DAYS * 24 * 60 * 60 * 1000) return `Pick a time within the next ${String(SCHEDULE_MAX_DAYS)} days.`;
  return null;
}

/** The approval behind a schedule, in words. */
export function approvalLabel(entry: Pick<ScheduleEntry, 'approval'>): string {
  const { state, by } = entry.approval;
  switch (state) {
    case 'not_required':
      return 'No approval needed';
    case 'approved':
      return by === null ? 'Approved' : `Approved by ${by}`;
    case 'awaiting':
      return 'Awaiting approval';
    case 'denied':
      return by === null ? 'Denied' : `Denied by ${by}`;
    case 'expired':
      return 'Not approved in time';
  }
}

/** What happened to a fired or cancelled schedule, in words. */
export function outcomeLabel(entry: Pick<ScheduleEntry, 'status' | 'state'>): string {
  if (entry.status === 'cancelled') return 'Cancelled';
  switch (entry.state) {
    case 'succeeded':
      return 'Fired · succeeded';
    case 'refused':
      return 'Fired · refused';
    case 'failed':
      return 'Fired · failed';
    case 'rolled_back':
      return 'Fired · rolled back';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Fired · running';
  }
}

/** True when the outcome should change what someone does next. */
export function outcomeIsBad(entry: Pick<ScheduleEntry, 'status' | 'state'>): boolean {
  return entry.status === 'fired' && (entry.state === 'refused' || entry.state === 'failed' || entry.state === 'rolled_back');
}
