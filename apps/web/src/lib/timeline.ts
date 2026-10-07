import { request } from './api';
import type { StatusTone } from './appstatus';
import { stateWords } from './words';

/**
 * The console's read side of the deploy history: the timeline (S8, SHP-REQ-062) and a single
 * deploy's record (S6) — its status, journal and Foreman posts.
 */

export type DeployKind = 'deploy' | 'rollback' | 'restore';

export type DeployTargetState =
  | 'queued'
  | 'awaiting_approval'
  | 'locked'
  | 'verifying'
  | 'backing_up'
  | 'migrating'
  | 'pulling'
  | 'swapping'
  | 'checking'
  | 'soaking'
  | 'rolling_back'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'
  | 'refused'
  | 'cancelled';

/** `outcome=` on the timeline: every terminal state, plus `active` for every state that is not. */
export type TimelineOutcome = 'succeeded' | 'failed' | 'rolled_back' | 'refused' | 'cancelled' | 'active';

export const OUTCOME_OPTIONS: readonly { value: TimelineOutcome; label: string }[] = [
  { value: 'active', label: 'In progress' },
  { value: 'succeeded', label: stateWords('succeeded') },
  { value: 'failed', label: stateWords('failed') },
  { value: 'rolled_back', label: stateWords('rolled_back') },
  { value: 'refused', label: stateWords('refused') },
  { value: 'cancelled', label: stateWords('cancelled') },
];

export const KIND_OPTIONS: readonly { value: DeployKind; label: string }[] = [
  { value: 'deploy', label: 'Deploy' },
  { value: 'rollback', label: 'Rollback' },
  { value: 'restore', label: 'Restore' },
];

export interface TimelineItem {
  deployId: string;
  kind: DeployKind;
  app: string;
  sha: string;
  dryRun: boolean;
  state: DeployTargetState;
  requesterLabel: string;
  createdAt: string;
  endedAt: string | null;
  refusalCode: string | null;
  /**
   * Optional: a server that sends them lets Activity name the check and the reason on a refused
   * row, and group a rollout's deploys by id instead of by the label they carry (SHP-T-13.13).
   */
  refusalGate?: string | null;
  refusalMessage?: string | null;
  rolloutId?: string | null;
  rolloutPosition?: number | null;
}

export interface TimelinePage {
  items: TimelineItem[];
  nextCursor: string | null;
}

export interface TimelineFilters {
  app?: string;
  requester?: string;
  outcome?: TimelineOutcome;
  kind?: DeployKind;
  cursor?: string;
  limit?: number;
}

export function fetchTimeline(filters: TimelineFilters = {}): Promise<TimelinePage> {
  const params = new URLSearchParams();
  if (filters.app !== undefined && filters.app !== '') params.set('app', filters.app);
  if (filters.requester !== undefined && filters.requester !== '') params.set('requester', filters.requester);
  if (filters.outcome !== undefined) params.set('outcome', filters.outcome);
  if (filters.kind !== undefined) params.set('kind', filters.kind);
  if (filters.cursor !== undefined) params.set('cursor', filters.cursor);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  const qs = params.toString();
  return request<TimelinePage>(`/api/deploys/timeline${qs !== '' ? `?${qs}` : ''}`);
}

export interface AppSummary {
  name: string;
}

/** For the app filter's options. */
export async function fetchAppNames(): Promise<string[]> {
  const { apps } = await request<{ apps: AppSummary[] }>('/api/apps');
  return apps.map((a) => a.name);
}

// ─── The deploy record (S6) ─────────────────────────────────────────────

export interface Gate {
  gate: string;
  pass: boolean;
  reason: string;
}

export interface DeployRefusal {
  code: string;
  gate: string;
  message: string;
  fix: string;
}

export interface DeployImage {
  service: string;
  sha: string;
  digest: string;
  migration?: string | null;
}

export interface DeployGroupMember {
  app: string;
  state: DeployTargetState;
  refusal: DeployRefusal | null;
  canary: boolean;
  position: number;
  targetId: string;
}

export interface DeployGroup {
  name: string;
  members: DeployGroupMember[];
}

export interface DeployStatus {
  deployId: string;
  kind: DeployKind;
  app: string;
  sha: string;
  dryRun: boolean;
  state: DeployTargetState;
  currentStep: string | null;
  requester: { label: string; repo: string | null; branch: string | null };
  images: DeployImage[];
  schemaRevision: string | null;
  refusal: DeployRefusal | null;
  gates: Gate[];
  createdAt: string;
  endedAt: string | null;
  /** Present only for a group deploy: every member in deploy order (SHP-REQ-078, SHP-REQ-079). */
  group?: DeployGroup;
}

export interface ForemanPost {
  service: string;
  idempotencyKey: string;
  delivered: boolean;
  attempts: number;
  lastError: string | null;
  nextAt: string;
}

export interface ForemanStatus {
  posts: ForemanPost[];
  stuck: boolean;
}

export function fetchForemanStatus(id: string): Promise<ForemanStatus> {
  return request<ForemanStatus>(`/api/deploys/${encodeURIComponent(id)}/foreman`);
}

// ─── Presentation helpers ─────────────────────────────────────────────────

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function isTerminal(state: DeployTargetState): boolean {
  return ['succeeded', 'failed', 'rolled_back', 'refused', 'cancelled'].includes(state);
}

export type BadgeTone = StatusTone;

/** The same four tones as `stateTone`: a deploy still moving is `attention`, a cancelled one `warning` (SHP-T-13.2). */
export function outcomeTone(state: DeployTargetState): BadgeTone {
  switch (state) {
    case 'succeeded':
      return 'neutral';
    case 'failed':
    case 'refused':
    case 'rolled_back':
      return 'danger';
    case 'cancelled':
      return 'warning';
    default:
      return 'attention';
  }
}

const RELATIVE_UNITS: readonly { limit: number; divisor: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { limit: 60, divisor: 1, unit: 'second' },
  { limit: 3600, divisor: 60, unit: 'minute' },
  { limit: 86400, divisor: 3600, unit: 'hour' },
  { limit: 2592000, divisor: 86400, unit: 'day' },
  { limit: 31536000, divisor: 2592000, unit: 'month' },
  { limit: Infinity, divisor: 31536000, unit: 'year' },
];

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 minutes ago", "just now" — no dependency, one formatter shared by the timeline and record. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((now.getTime() - then) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 5) return 'just now';
  for (const { limit, divisor, unit } of RELATIVE_UNITS) {
    if (abs < limit) return rtf.format(Math.round(-seconds / divisor), unit);
  }
  return rtf.format(Math.round(-seconds / 31536000), 'year');
}


// ─── Activity's time and duration words (SHP-T-13.13) ──────────────────────

const SHORT_TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole calendar days from `then`'s day to `now`'s day, in local time. */
function daysBetween(then: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
}

/**
 * A feed row's time: "12m ago", "3h ago", "Yesterday 11:57 AM", "Mon 11:57 AM" within the week,
 * "Oct 1, 11:57 AM" after it. No seconds. A time ahead of `now` (a schedule) reads absolute.
 */
export function formatFeedTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  const clock = then.toLocaleTimeString('en-US', SHORT_TIME);
  if (seconds >= 0 && seconds < 60) return 'just now';
  if (seconds >= 0 && seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  const days = daysBetween(then, now);
  if (seconds >= 0 && days === 0) return `${String(Math.floor(seconds / 3600))}h ago`;
  if (seconds >= 0 && days === 1) return `Yesterday ${clock}`;
  if (seconds >= 0 && seconds < 7 * 86_400) return `${then.toLocaleDateString('en-US', { weekday: 'short' })} ${clock}`;
  const date = then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(then.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return `${date}, ${clock}`;
}

/** When a schedule is due: "Today 9:00 AM", "Thu 9:00 AM" within the week, "Oct 14, 9:00 AM" beyond. */
export function formatDue(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const clock = at.toLocaleTimeString('en-US', SHORT_TIME);
  const days = daysBetween(now, at);
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Tomorrow ${clock}`;
  if (days > 1 && days < 7) return `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${clock}`;
  const date = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return `${date}, ${clock}`;
}

/** The heading over a day's rows: "Today", "Yesterday", "Oct 4" (with the year when it is not this one). */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const days = daysBetween(at, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/** One calendar day's key in local time, for grouping rows. */
export function dayKey(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getFullYear())}-${String(at.getMonth() + 1)}-${String(at.getDate())}`;
}

/** "45s", "5m 52s", "1h 2m": whole seconds up to a minute, then minutes and seconds, then hours and minutes. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${String(total)}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(total % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}
