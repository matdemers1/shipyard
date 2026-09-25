import { request } from './api';

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
  { value: 'active', label: 'Active' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'rolled_back', label: 'Rolled back' },
  { value: 'refused', label: 'Refused' },
  { value: 'cancelled', label: 'Cancelled' },
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

export function fetchDeployStatus(id: string): Promise<DeployStatus> {
  return request<DeployStatus>(`/api/deploys/${encodeURIComponent(id)}`);
}

export interface DeployStep {
  name: string;
  argv: string[];
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  output: string | null;
}

/** `GET /api/deploys/:id/steps`, built alongside this task; the journal (SHP-T-3.7 reads only). */
export async function fetchDeploySteps(id: string): Promise<DeployStep[]> {
  const { steps } = await request<{ steps: DeployStep[] }>(`/api/deploys/${encodeURIComponent(id)}/steps`);
  return steps;
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

export function outcomeLabel(state: DeployTargetState): string {
  switch (state) {
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'rolled_back':
      return 'Rolled back';
    case 'refused':
      return 'Refused';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Active';
  }
}

export type BadgeTone = 'neutral' | 'attention' | 'danger';

export function outcomeTone(state: DeployTargetState): BadgeTone {
  switch (state) {
    case 'succeeded':
      return 'neutral';
    case 'failed':
    case 'refused':
    case 'rolled_back':
      return 'danger';
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
