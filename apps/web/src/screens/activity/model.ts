import type { StageState } from '../../components/pipeline';
import { STAGE_LABEL, isTerminalBuild, type BuildState, type BuildSummary } from '../../lib/builds';
import type { ScheduleEntry } from '../../lib/schedules';
import {
  OUTCOME_OPTIONS,
  formatDuration,
  isTerminal,
  type DeployTargetState,
  type TimelineFilters,
  type TimelineItem,
  type TimelineOutcome,
} from '../../lib/timeline';
import { DEPLOY_ALL_READY, checkName, stateWords } from '../../lib/words';

/**
 * Activity's model (SHP-T-13.13, SHP-REQ-164): the filters in the address, the one feed made of
 * four stored things (deploys, builds, past schedules and a rollout's deploys as one row), and the
 * words each row says. Pure functions: nothing here fetches, and the clock is a parameter where a
 * test needs to pin it.
 */

// ── Filters, in the URL ──────────────────────────────────────────────────

/** The kind chips. `refusal` is a deploy outcome, not a stored kind. */
export type ActivityKind = 'deploy' | 'rollback' | 'refusal' | 'build' | 'schedule' | 'restore';

export const KIND_CHIPS: readonly { value: ActivityKind; label: string }[] = [
  { value: 'deploy', label: 'Deploys' },
  { value: 'rollback', label: 'Rollbacks' },
  // The old timeline's Kind select offered restores; keep a way to them (SHP-T-13.13 verification).
  { value: 'restore', label: 'Restores' },
  { value: 'refusal', label: 'Refusals' },
  { value: 'build', label: 'Builds' },
  { value: 'schedule', label: 'Schedules' },
];

const KIND_VALUES: readonly string[] = KIND_CHIPS.map((k) => k.value);

export interface ActivityFilters {
  app?: string;
  requester?: string;
  outcome?: TimelineOutcome;
  kind?: ActivityKind;
}

export function filtersFromParams(params: URLSearchParams): ActivityFilters {
  const app = params.get('app') ?? '';
  const requester = params.get('requester') ?? '';
  const outcome = params.get('outcome') ?? '';
  const kind = params.get('kind') ?? '';
  return {
    ...(app !== '' ? { app } : {}),
    ...(requester !== '' ? { requester } : {}),
    ...(OUTCOME_OPTIONS.some((o) => o.value === outcome) ? { outcome: outcome as TimelineOutcome } : {}),
    ...(KIND_VALUES.includes(kind) ? { kind: kind as ActivityKind } : {}),
  };
}

export function hasFilters(filters: ActivityFilters): boolean {
  return Object.keys(filters).length > 0;
}

/** Which of the stored things a filter set reads. */
export interface Sources {
  deploys: boolean;
  builds: boolean;
  /** Past schedules as rows. The upcoming card has its own rule: `showUpcoming`. */
  scheduleRows: boolean;
  showUpcoming: boolean;
}

export function sourcesFor(filters: ActivityFilters): Sources {
  const kind = filters.kind;
  return {
    deploys: kind !== 'build' && kind !== 'schedule',
    builds: kind === undefined || kind === 'build',
    scheduleRows: kind === undefined || kind === 'schedule' || kind === 'refusal',
    showUpcoming: kind === undefined || kind === 'schedule',
  };
}

/** What the timeline endpoint is asked: the Refusals chip is its `refused` outcome, the rest its own kinds. */
export function timelineFilters(filters: ActivityFilters): TimelineFilters {
  const out: TimelineFilters = {};
  if (filters.app !== undefined) out.app = filters.app;
  if (filters.requester !== undefined) out.requester = filters.requester;
  if (filters.kind === 'refusal') out.outcome = 'refused';
  else if (filters.outcome !== undefined) out.outcome = filters.outcome;
  if (filters.kind === 'deploy' || filters.kind === 'rollback' || filters.kind === 'restore') out.kind = filters.kind;
  return out;
}

// ── Matching what the server did not filter ──────────────────────────────

function contains(haystack: string, needle: string | undefined): boolean {
  return needle === undefined || haystack.toLowerCase().includes(needle.toLowerCase());
}

function outcomeMatches(outcome: TimelineOutcome | undefined, state: string): boolean {
  if (outcome === undefined) return true;
  if (outcome === 'active') return !isTerminal(state as DeployTargetState) && !isTerminalBuild(state as BuildState);
  return state === outcome;
}

export function buildMatches(build: BuildSummary, filters: ActivityFilters): boolean {
  return contains(build.requesterLabel, filters.requester) && outcomeMatches(filters.outcome, build.state);
}

/** A past schedule's own outcome: cancelled, or the state its deploy reached. */
export function scheduleOutcome(entry: ScheduleEntry): string {
  return entry.status === 'cancelled' ? 'cancelled' : entry.state;
}

export function scheduleMatches(entry: ScheduleEntry, filters: ActivityFilters): boolean {
  if (filters.app !== undefined && entry.app !== filters.app) return false;
  if (!contains(entry.by, filters.requester) && !contains(entry.requester.label, filters.requester)) return false;
  const outcome = filters.kind === 'refusal' ? 'refused' : filters.outcome;
  return outcomeMatches(outcome, scheduleOutcome(entry));
}

// ── The feed ─────────────────────────────────────────────────────────────

export interface RolloutMember {
  item: TimelineItem;
  /** 1-based place in the rollout. */
  position: number;
}

export type FeedEntry =
  | { type: 'deploy'; key: string; at: string; item: TimelineItem }
  | { type: 'build'; key: string; at: string; build: BuildSummary }
  | { type: 'schedule'; key: string; at: string; entry: ScheduleEntry }
  | {
      type: 'rollout';
      key: string;
      at: string;
      /** In deploy order. */
      members: RolloutMember[];
      /** How many apps the rollout covers, from the label each deploy carries. */
      total: number;
      requester: string;
      rolloutId: string | null;
    };

/** "<who> · roll all 3/5": the label every member of a rollout carries (the server's `memberLabel`). */
const ROLLOUT_SUFFIX = /^(.*) · (?:roll all|deploy all ready) (\d+)\/(\d+)$/i;

interface RolloutTag {
  key: string;
  base: string;
  position: number;
  total: number;
  rolloutId: string | null;
}

function rolloutTag(item: TimelineItem): RolloutTag | null {
  const m = ROLLOUT_SUFFIX.exec(item.requesterLabel);
  const rolloutId = item.rolloutId ?? null;
  // The server names the rollout and each member's place in it; the label is the fallback for an
  // older server (SHP-T-13.13 verification). Positions here are 1-based, as the label writes them.
  if (rolloutId !== null) {
    const position = item.rolloutPosition !== null && item.rolloutPosition !== undefined ? item.rolloutPosition + 1 : Number(m?.[2] ?? 0);
    return { key: rolloutId, base: m?.[1] ?? item.requesterLabel, position, total: Number(m?.[3] ?? 0), rolloutId };
  }
  if (m === null) return null;
  const base = m[1] ?? '';
  return { key: `${base}|${m[3] ?? ''}`, base, position: Number(m[2]), total: Number(m[3]), rolloutId: null };
}

/** Members of one rollout are minutes apart; two rollouts by the same person are never this close. */
const ROLLOUT_WINDOW_MS = 6 * 60 * 60 * 1000;

/** When a schedule's row sits in the feed: when it fired or was cancelled, else when it is due. */
export function scheduleAt(entry: ScheduleEntry): string {
  return entry.firedAt ?? entry.cancelledAt ?? entry.fireAt;
}

/**
 * Folds a rollout's deploys into one entry, placed where its newest member is. A member is
 * recognised by the label it carries; a server that also sends `rolloutId` makes that the key.
 */
export function groupRollouts(entries: readonly FeedEntry[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  const open = new Map<string, Extract<FeedEntry, { type: 'rollout' }>>();
  for (const entry of entries) {
    if (entry.type !== 'deploy') {
      out.push(entry);
      continue;
    }
    const tag = rolloutTag(entry.item);
    if (tag === null) {
      out.push(entry);
      continue;
    }
    const group = open.get(tag.key);
    const oldest = group?.members[group.members.length - 1];
    // A rollout id is exact; only label-matched members need the time window to tell two apart.
    const near =
      oldest !== undefined &&
      (tag.rolloutId !== null || Date.parse(oldest.item.createdAt) - Date.parse(entry.item.createdAt) < ROLLOUT_WINDOW_MS);
    if (group !== undefined && near && !group.members.some((m) => m.position === tag.position)) {
      group.members.push({ item: entry.item, position: tag.position });
      continue;
    }
    const fresh: Extract<FeedEntry, { type: 'rollout' }> = {
      type: 'rollout',
      key: `rollout:${tag.rolloutId ?? entry.item.deployId}`,
      at: entry.at,
      members: [{ item: entry.item, position: tag.position }],
      total: tag.total,
      requester: tag.base,
      rolloutId: tag.rolloutId,
    };
    open.set(tag.key, fresh);
    out.push(fresh);
  }
  for (const entry of out) {
    if (entry.type !== 'rollout') continue;
    entry.members.sort((a, b) => a.position - b.position);
    // Without a label the total is unknown: at least as many as the members seen.
    entry.total = Math.max(entry.total, entry.members.length);
  }
  return out;
}

/** Newest first. */
export function byTimeDesc(a: { at: string; key: string }, b: { at: string; key: string }): number {
  const diff = Date.parse(b.at) - Date.parse(a.at);
  return diff !== 0 ? diff : a.key < b.key ? 1 : -1;
}

// ── Words ────────────────────────────────────────────────────────────────

/** A refusal in one line: "Refused — Not frozen — web is frozen". The check by its name, never its code. */
export function refusalLine(gate: string | null | undefined, message: string | null | undefined, code: string | null | undefined): string {
  const parts = ['Refused'];
  if (gate !== null && gate !== undefined && gate !== '' && gate !== 'none') parts.push(checkName(gate));
  if (message !== null && message !== undefined && message !== '') parts.push(message);
  else if (parts.length === 1 && code !== null && code !== undefined && code !== '') parts.push(code.replaceAll('_', ' '));
  return parts.join(' — ');
}

/** What a deploy row says: the verb and the outcome in the console's one vocabulary. */
export function deployHeadline(item: Pick<TimelineItem, 'kind' | 'state' | 'refusalCode' | 'refusalGate' | 'refusalMessage'>): string {
  switch (item.state) {
    case 'succeeded':
      return item.kind === 'rollback' ? stateWords('rolled_back') : item.kind === 'restore' ? 'Restored' : 'Deployed';
    case 'failed':
      return item.kind === 'rollback' ? 'Rollback failed' : item.kind === 'restore' ? 'Restore failed' : 'Deploy failed';
    case 'refused':
      return refusalLine(item.refusalGate, item.refusalMessage, item.refusalCode);
    default:
      return stateWords(item.state);
  }
}

/** What a past schedule's row says. */
export function scheduleHeadline(entry: ScheduleEntry): string {
  if (entry.status === 'cancelled' || entry.state === 'cancelled') return 'Scheduled deploy cancelled';
  if (entry.state === 'refused') return refusalLine(entry.refusal?.gate, entry.refusal?.message, entry.refusal?.code);
  if (entry.state === 'succeeded') return 'Scheduled deploy · Deployed';
  if (entry.state === 'failed') return 'Scheduled deploy · Deploy failed';
  if (entry.state === 'rolled_back') return 'Scheduled deploy · Rolled back';
  return `Scheduled deploy · ${stateWords(entry.state)}`;
}

/** What a build row says: "Build passed", "Build failed at test". */
export function buildHeadline(build: Pick<BuildSummary, 'state' | 'failedStage'>): string {
  switch (build.state) {
    case 'succeeded':
      return 'Build passed';
    case 'failed':
      return build.failedStage === null ? 'Build failed' : `Build failed at ${STAGE_LABEL[build.failedStage].toLowerCase()}`;
    case 'cancelled':
      return 'Build cancelled';
    case 'refused':
      return 'Build refused';
    case 'running':
      return 'Building';
    case 'queued':
      return 'Build queued';
  }
}

/** Who asked: "console · Matt", "schedule · Matt", a connected Claude's own label, or the rollout's name. */
export function requesterWords(label: string, rollout?: { position: number; total: number }): string {
  if (rollout !== undefined) return `${DEPLOY_ALL_READY} ${String(rollout.position)}/${String(rollout.total)}`;
  const consoleMatch = /^(.*) \(console\)$/.exec(label);
  if (consoleMatch !== null) return `console · ${consoleMatch[1] ?? ''}`;
  const scheduled = /^(.*) \(scheduled\)$/.exec(label);
  if (scheduled !== null) return `schedule · ${scheduled[1] ?? ''}`;
  return label;
}

export function deployRequester(item: TimelineItem): string {
  const tag = rolloutTag(item);
  return tag === null ? requesterWords(item.requesterLabel) : requesterWords(tag.base, { position: tag.position, total: tag.total });
}

export function durationBetween(start: string | null, end: string | null): string | null {
  if (start === null || end === null) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return ms >= 1000 ? formatDuration(ms) : null;
}

// ── Pipeline marks ───────────────────────────────────────────────────────

export function deployNode(state: DeployTargetState): StageState {
  switch (state) {
    case 'succeeded':
      return 'done';
    case 'failed':
    case 'refused':
    case 'rolled_back':
      return 'failed';
    case 'cancelled':
      return 'skipped';
    case 'queued':
      return 'waiting';
    case 'awaiting_approval':
    case 'locked':
      return 'held';
    default:
      return 'running';
  }
}

export function buildNode(state: BuildState): StageState {
  switch (state) {
    case 'succeeded':
      return 'done';
    case 'failed':
    case 'refused':
      return 'failed';
    case 'cancelled':
      return 'skipped';
    case 'queued':
      return 'waiting';
    case 'running':
      return 'running';
  }
}

/** How a rollout reads as one row: its node, and the words after the duration. */
export function rolloutSummary(members: readonly RolloutMember[], total: number): { node: StageState; words: string } {
  const states = members.map((m) => m.item.state);
  const deployed = states.filter((s) => s === 'succeeded').length;
  const stopped = members.find((m) => ['failed', 'refused', 'rolled_back'].includes(m.item.state));
  if (deployed === total) return { node: 'done', words: 'all deployed' };
  if (stopped !== undefined) return { node: 'failed', words: `stopped at ${stopped.item.app} · ${String(deployed)} of ${String(total)} deployed` };
  if (states.every(isTerminal)) return { node: 'skipped', words: `${String(deployed)} of ${String(total)} deployed` };
  return { node: 'running', words: `${String(deployed)} of ${String(total)} deployed · in progress` };
}
