import type { DeployTargetState } from '@shipyard/schema';
import { request } from './api';
import type { AppDetail, HistoryTarget } from './appdetail';
import type { CommitDeploy } from '../components/pipeline';
import { formatSpan } from '../components/pipeline/stages';

/**
 * The commit page's data (SHP-T-13.9, SHP-REQ-157, SHP-REQ-158): the jobs of a commit's GitHub
 * Actions run, and the working-out of what the page says about a commit's images. Everything here
 * is a pure function of what the server has already answered, except the one fetch, so a test pins
 * a bar's width or an image's wording without a DOM.
 */

export type JobState = 'success' | 'failure' | 'running' | 'queued' | 'skipped' | 'cancelled';

/** One job of the run, as `GET /api/apps/:app/commits/:sha/run` answers. */
export interface RunJob {
  id: number;
  name: string;
  state: JobState;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  url: string | null;
}

export interface RunSummary {
  id: number;
  url: string | null;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunJobs {
  run: RunSummary | null;
  jobs: RunJob[];
}

/** The only request data that reaches the server from this page: an app name and a full lower-case SHA. */
export const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Fetches a commit's run and jobs. The server caches by run id and Shipyard never polls, so this is
 * called once when the page opens (SHP-REQ-157). Not for a `build: shipyard` app: it has no run.
 */
export function fetchRunJobs(app: string, sha: string, signal?: AbortSignal): Promise<RunJobs> {
  return request<RunJobs>(`/api/apps/${encodeURIComponent(app)}/commits/${sha}/run`, signal === undefined ? {} : { signal });
}

export const JOB_STATE_WORDS: Record<JobState, string> = {
  success: 'Passed',
  failure: 'Failed',
  running: 'Running',
  queued: 'Queued',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

/** The first job that failed, in the order GitHub lists them. */
export function failedJob(jobs: readonly RunJob[]): RunJob | null {
  return jobs.find((j) => j.state === 'failure') ?? null;
}

// ── The timeline ────────────────────────────────────────────────────────

export interface JobBar {
  /** Percent of the track's width. */
  left: number;
  width: number;
}

export interface Timeline {
  /** The run's length on the axis, in milliseconds. */
  totalMs: number;
  /** A bar per job id; a job that has not started has none. */
  bars: Map<number, JobBar>;
  ticks: { at: number; label: string }[];
}

/** The tick spacings a person reads at a glance, in seconds. */
const TICK_STEPS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

function tickLabel(seconds: number): string {
  if (seconds === 0) return '0';
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) return `${String(seconds / 60)}m`;
  return `${String(seconds / 3600)}h`;
}

/**
 * Each job's bar, positioned by its start and end relative to the run's start. A job still running
 * ends at `now`; one that never started has no bar. The axis ends at the latest of the run's own end
 * and every job's, so a bar can never run past its track.
 */
export function timeline(run: RunSummary | null, jobs: readonly RunJob[], now: number = Date.now()): Timeline | null {
  const starts = jobs.map((j) => (j.startedAt === null ? NaN : Date.parse(j.startedAt))).filter((t) => !Number.isNaN(t));
  const runStart = run?.startedAt ? Date.parse(run.startedAt) : NaN;
  const origin = Number.isNaN(runStart) ? Math.min(...starts) : Math.min(runStart, ...starts);
  if (!Number.isFinite(origin)) return null;

  const end = (j: RunJob): number => {
    if (j.completedAt !== null) return Date.parse(j.completedAt);
    return j.state === 'running' ? now : Date.parse(j.startedAt ?? '');
  };
  const ends = jobs.map(end).filter((t) => !Number.isNaN(t));
  const runEnd = run?.completedAt ? Date.parse(run.completedAt) : NaN;
  const finish = Math.max(origin, ...ends, ...(Number.isNaN(runEnd) ? [] : [runEnd]));
  const totalMs = Math.max(finish - origin, 1000);

  const bars = new Map<number, JobBar>();
  for (const j of jobs) {
    if (j.startedAt === null || j.state === 'skipped') continue;
    const from = Date.parse(j.startedAt);
    const to = end(j);
    if (Number.isNaN(from) || Number.isNaN(to)) continue;
    const left = Math.min(100, Math.max(0, ((from - origin) / totalMs) * 100));
    // A job of a second still gets a bar you can see and tap.
    const width = Math.min(100 - left, Math.max(((to - from) / totalMs) * 100, 1.5));
    bars.set(j.id, { left, width });
  }

  const totalSeconds = totalMs / 1000;
  const step = TICK_STEPS.find((s) => totalSeconds / s <= 4) ?? TICK_STEPS[TICK_STEPS.length - 1] ?? 3600;
  const ticks: Timeline['ticks'] = [];
  for (let s = 0; s <= totalSeconds; s += step) ticks.push({ at: (s / totalSeconds) * 100, label: tickLabel(s) });
  return { totalMs, bars, ticks };
}

/** A job's length for a row: "48s", "2m 03s"; "—" before it has one. */
export function jobSpan(job: RunJob): string {
  return job.durationMs === null ? '—' : formatSpan(job.durationMs);
}

// ── What a deploy of this commit says about its images ──────────────────

/** States in which the agent has got past its verify step, so it has seen the image digests. */
const PAST_VERIFY: readonly DeployTargetState[] = [
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
];

export interface ImageVerification {
  verified: boolean;
  /** What verified it, in words: "Verified by a dry run". Null while expected. */
  by: string | null;
  /** The digest per service, when the page holds them; a dry run's are not kept on the target. */
  digests: Record<string, string>;
}

function targetsOf(detail: AppDetail, sha: string): HistoryTarget[] {
  return detail.targets.filter((t) => t.sha === sha);
}

/**
 * Whether Shipyard has verified this commit's image digests (SHP-REQ-158): the live release was
 * verified when it deployed, a dry run that succeeded verified them, and so did a deploy that got
 * past its verify step. Green CI alone is Expected, never Verified.
 */
export function imageVerification(detail: AppDetail, sha: string): ImageVerification {
  const digests: Record<string, string> = {};
  for (const release of [...detail.rollbackTargets, ...detail.needsRestore]) {
    if (release.sha !== sha) continue;
    for (const image of release.images) digests[image.service] = image.digest;
  }
  if (detail.liveSha === sha && detail.digests !== null) Object.assign(digests, detail.digests);

  if (detail.liveSha === sha) return { verified: true, by: 'Verified when it deployed', digests };
  const mine = targetsOf(detail, sha);
  if (mine.some((t) => !t.dryRun && PAST_VERIFY.includes(t.state as DeployTargetState))) {
    return { verified: true, by: 'Verified by a deploy', digests };
  }
  if (mine.some((t) => t.dryRun && t.state === 'succeeded')) return { verified: true, by: 'Verified by a dry run', digests };
  return { verified: false, by: null, digests };
}

/** An image the manifest names for a service, with the tag a build of this commit carries. */
export interface ImageRef {
  service: string;
  /** `ghcr.io/<repo>/<service>:sha-<sha7>`; the tag in GHCR carries all forty characters. */
  ref: string;
  /** The full tag, for the title attribute. */
  fullRef: string;
}

function imageName(detail: AppDetail, service: string, config: unknown): string {
  if (typeof config === 'object' && config !== null) {
    const image = (config as { image?: unknown }).image;
    if (typeof image === 'string' && image !== '') return image;
  }
  return `ghcr.io/${detail.repo ?? detail.name}/${service}`;
}

/** The services the manifest names, in its order, each with the image a build of `sha` would push. */
export function imageRefs(detail: AppDetail, sha: string): ImageRef[] {
  const services = typeof detail.manifest === 'object' && detail.manifest !== null ? (detail.manifest as { services?: unknown }).services : undefined;
  if (typeof services !== 'object' || services === null) return [];
  return Object.entries(services as Record<string, unknown>).map(([service, config]) => {
    const name = imageName(detail, service, config);
    return { service, ref: `${name}:sha-${sha.slice(0, 7)}`, fullRef: `${name}:sha-${sha}` };
  });
}

/** The workflow file the manifest names: "ci.yml". */
export function workflowName(detail: AppDetail): string | null {
  const workflow = typeof detail.manifest === 'object' && detail.manifest !== null ? (detail.manifest as { workflow?: unknown }).workflow : undefined;
  return typeof workflow === 'string' && workflow !== '' ? workflow : null;
}

/**
 * The deploy of this commit the lane should show: the app's newest real deploy, when it is of this
 * commit. An older deploy of it that something later replaced would claim a "Deployed" the app no
 * longer has.
 */
export function commitDeploy(detail: AppDetail, sha: string): CommitDeploy | null {
  const real = detail.targets.filter((t) => !t.dryRun && t.kind !== 'rollback');
  const newest = [...real].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (newest?.sha !== sha) return null;
  return {
    state: newest.state as DeployTargetState,
    startedAt: newest.startedAt ?? newest.createdAt,
    ...(detail.soakSeconds === null ? {} : { soakSeconds: detail.soakSeconds }),
  };
}
