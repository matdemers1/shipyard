import type { DeployStatus, DeployTargetState } from '@shipyard/schema';
import { sha7, stateWords } from '../../lib/appstatus';
import type { CommitEntry } from '../../lib/home';
import type { DeployStep } from '../../lib/progress';

/**
 * The pipeline's one stage model (SHP-T-13.7, SHP-REQ-156): a commit's progress as six stages —
 * Push, CI, Images, Checks, Deploy, Live — each in one of six states. Home rows, the app page, the
 * commit page and the deploy page all draw the same list, through `PipeMini`, `PipeLane` and
 * `StepList`, so two screens never tell a different story about the same commit.
 *
 * Everything here is a pure function of data the screens already hold: nothing fetches, and the
 * clock is a parameter, so a test pins "2m" and a screen re-renders on its own poll.
 *
 * Two rules shape the wording. Images read "Expected" until a dry run or deploy has verified the
 * digests (SHP-REQ-158): green CI means GitHub says it pushed them, not that Shipyard has seen the
 * digests. And downstream of a failure reads Skipped or Blocked, never Waiting — a stage that will
 * not happen must not look like one that is merely next.
 */

export type StageKey = 'push' | 'ci' | 'images' | 'checks' | 'deploy' | 'live';

/** `held` is blocked by something upstream; `skipped` will not happen at all. */
export type StageState = 'done' | 'running' | 'waiting' | 'failed' | 'held' | 'skipped';

export interface Stage {
  key: StageKey;
  label: 'Push' | 'CI' | 'Images' | 'Checks' | 'Deploy' | 'Live';
  state: StageState;
  /** The headline value: "Expected", "#412 · 14m 08s", "Soaking 34s". */
  detail: string;
  /** A second, quieter line: "Expected from green CI; verified on deploy". */
  note?: string;
  /** Where the stage points to, when it does: CI's GitHub Actions run (SHP-REQ-167). */
  href?: string;
  /** The link's text, without the arrow the component adds: "Open run #412". */
  linkLabel?: string;
}

export const STAGE_ORDER: readonly { key: StageKey; label: Stage['label'] }[] = [
  { key: 'push', label: 'Push' },
  { key: 'ci', label: 'CI' },
  { key: 'images', label: 'Images' },
  { key: 'checks', label: 'Checks' },
  { key: 'deploy', label: 'Deploy' },
  { key: 'live', label: 'Live' },
];

/** A state in words — always shown beside its icon, never colour alone. */
export const STATE_LABEL: Record<StageState, string> = {
  done: 'Done',
  running: 'Running',
  waiting: 'Waiting',
  failed: 'Failed',
  held: 'Blocked',
  skipped: 'Skipped',
};

/** "Pipeline: Push done, CI running, Images waiting, …" — the name a screen reader hears for a lane. */
export function stagesSummary(stages: readonly Stage[]): string {
  return `Pipeline: ${stages.map((s) => `${s.label} ${STATE_LABEL[s.state].toLowerCase()}`).join(', ')}`;
}

// ── Small helpers ───────────────────────────────────────────────────────

/** "34s", "2m 05s", "14m 08s", "1h 02m". */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${String(total)}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${String(m)}m ${String(total % 60).padStart(2, '0')}s`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "just now", "14m ago", "1h ago", "3d ago" — short enough for a 375 px row. */
export function agoShort(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'unknown';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${String(h)}h ago`;
  return `${String(Math.round(h / 24))}d ago`;
}

/** Milliseconds from one instant to another, or null when either is missing or unreadable. */
function between(from: string | null | undefined, to: string | number | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined) return null;
  const a = Date.parse(from);
  const b = typeof to === 'number' ? to : Date.parse(to);
  return Number.isNaN(a) || Number.isNaN(b) ? null : b - a;
}

function join(parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');
}

/** A `note` property only when there is one, so the optional field is never set to undefined. */
function noted(note: string | null | undefined): { note?: string } {
  return note === null || note === undefined || note === '' ? {} : { note };
}

function stage(key: StageKey, state: StageState, detail: string, extra: Partial<Stage> = {}): Stage {
  const label = STAGE_ORDER.find((s) => s.key === key)?.label ?? 'Push';
  return { key, label, state, detail, ...extra };
}

// ── A commit's lane ─────────────────────────────────────────────────────

/** A deploy of this commit, if one is under way or has ended. */
export interface CommitDeploy {
  state: DeployTargetState;
  /** When the deploy entered its current state; the soak timer counts from here. */
  startedAt?: string | null;
  soakSeconds?: number;
  /** Why it was refused or failed, in a sentence. */
  reason?: string | null;
}

export interface CommitStagesInput {
  commit: CommitEntry;
  /** When the commit was pushed; falls back to the CI run's start, which a push starts. */
  pushedAt?: string | null;
  branch?: string | null;
  author?: string | null;
  liveSha: string | null;
  /** Absent reads as `github`, the default build source. */
  buildSource?: 'github' | 'shipyard';
  /** A dry run or deploy has verified this commit's image digests (SHP-REQ-158). */
  verifiedDigests?: boolean;
  /** The CI job that failed, when the commit page has fetched the run's jobs. */
  failedJob?: string | null;
  deploy?: CommitDeploy | null;
  now?: number;
}

const PLAN_NOTE = 'Back up → Migrate → Pull → Swap → Check → Soak';

function planNote(soakSeconds: number | undefined): string {
  return soakSeconds === undefined ? PLAN_NOTE : `${PLAN_NOTE} ${String(soakSeconds)}s`;
}

function ciStage(input: CommitStagesInput, now: number): Stage {
  const { commit } = input;
  const shipyard = input.buildSource === 'shipyard';
  // A `build: shipyard` app has no GitHub run to link to; the server sends `run: null` for it, but a
  // stale cache must not grow a link either.
  const run = shipyard ? null : (commit.run ?? null);
  const tag = run === null ? null : `#${String(run.id)}`;
  const link: Partial<Stage> = run?.url ? { href: run.url, linkLabel: `Open run ${tag ?? ''}`.trim() } : {};
  const took = run === null ? null : between(run.startedAt, run.completedAt);
  const tookWords = took === null ? null : formatSpan(took);

  switch (commit.ci) {
    case 'success':
      return shipyard
        ? stage('ci', 'done', 'Shipyard build passed', { note: 'Built by Shipyard, not GitHub Actions' })
        : stage('ci', 'done', join([tag, tookWords]) || 'Passed', link);
    case 'failure': {
      if (shipyard) return stage('ci', 'failed', 'Shipyard build failed');
      const job = input.failedJob ?? null;
      return stage('ci', 'failed', job === null ? 'Failed' : `Failed at ${job}`, {
        ...link,
        ...noted(join([job, tag === null ? null : `run ${tag}`, tookWords])),
      });
    }
    case 'pending': {
      if (shipyard) return stage('ci', 'running', 'Shipyard build running');
      const elapsed = between(run?.startedAt, now);
      return stage('ci', 'running', join(['CI running', elapsed === null ? null : formatSpan(elapsed), tag]), link);
    }
    case 'none':
      return shipyard
        ? stage('ci', 'waiting', 'No build yet', { note: 'Shipyard has not built this commit' })
        : stage('ci', 'waiting', 'No run yet', { note: 'No image workflow has run for this commit' });
  }
}

/** What the Checks, Deploy and Live stages say once a deploy is in play, and whether it verified the images. */
interface Tail {
  checks: Stage;
  /** The deploy got past its verify step, so Shipyard has seen the digests. */
  imagesVerified: boolean;
  deploy: Stage;
  live: Stage;
}

function deployTail(deploy: CommitDeploy, sha: string, liveSha: string | null, now: number, dryRun = false): Tail {
  const { state } = deploy;
  const live = liveSha === null ? 'Nothing is live yet' : `${sha7(liveSha)} is live`;
  const reason = noted(deploy.reason);
  const waitingDeploy = stage('deploy', 'waiting', 'Not started', { note: planNote(deploy.soakSeconds) });
  const waitingLive = stage('live', 'waiting', live, { note: 'This commit goes live after soak' });
  const heldLive = stage('live', 'held', live, { note: 'This commit did not ship' });

  if (dryRun && (state === 'succeeded' || state === 'failed' || state === 'refused')) {
    // A dry run checks and verifies and stops; saying "Deploy: done" would be a lie.
    return {
      checks:
        state === 'succeeded'
          ? stage('checks', 'done', 'Passed', { note: 'Dry run' })
          : stage('checks', 'failed', state === 'refused' ? 'Refused' : 'Failed', reason),
      imagesVerified: state === 'succeeded',
      deploy: stage('deploy', 'skipped', 'Dry run', { note: 'Nothing was deployed' }),
      live: stage('live', 'skipped', live, { note: 'A dry run never changes what is live' }),
    };
  }

  switch (state) {
    case 'queued':
      return { checks: stage('checks', 'waiting', 'Queued'), imagesVerified: false, deploy: waitingDeploy, live: waitingLive };
    case 'awaiting_approval':
      return { checks: stage('checks', 'waiting', 'Waiting for approval'), imagesVerified: false, deploy: waitingDeploy, live: waitingLive };
    case 'locked':
    case 'verifying':
      return { checks: stage('checks', 'running', stateWords(state)), imagesVerified: false, deploy: waitingDeploy, live: waitingLive };
    case 'refused':
      return {
        checks: stage('checks', 'failed', 'Refused', reason),
        imagesVerified: false,
        deploy: stage('deploy', 'held', 'Blocked', { note: 'The gates refused it' }),
        live: heldLive,
      };
    case 'cancelled':
      return {
        checks: stage('checks', 'skipped', 'Not run'),
        imagesVerified: false,
        deploy: stage('deploy', 'skipped', 'Cancelled'),
        live: stage('live', 'skipped', live, { note: 'The deploy was cancelled' }),
      };
    case 'soaking': {
      const elapsed = between(deploy.startedAt, now);
      return {
        checks: stage('checks', 'done', 'Passed'),
        imagesVerified: true,
        deploy: stage('deploy', 'running', elapsed === null ? 'Soaking' : `Soaking ${formatSpan(elapsed)}`, {
          ...(deploy.soakSeconds === undefined ? {} : { note: `Soak is ${String(deploy.soakSeconds)}s` }),
        }),
        live: waitingLive,
      };
    }
    case 'succeeded':
      return {
        checks: stage('checks', 'done', 'Passed'),
        imagesVerified: true,
        deploy: stage('deploy', 'done', 'Deployed'),
        live: stage('live', 'done', `${sha7(sha)} is live`, { note: 'Soak passed' }),
      };
    case 'failed':
      return {
        checks: stage('checks', 'done', 'Passed'),
        imagesVerified: false,
        deploy: stage('deploy', 'failed', 'Failed', reason),
        live: heldLive,
      };
    case 'rolled_back':
      return {
        checks: stage('checks', 'done', 'Passed'),
        imagesVerified: true,
        deploy: stage('deploy', 'failed', 'Rolled back', { note: deploy.reason ?? 'The previous release is back' }),
        live: heldLive,
      };
    case 'rolling_back':
      return {
        checks: stage('checks', 'done', 'Passed'),
        imagesVerified: true,
        deploy: stage('deploy', 'running', stateWords(state)),
        live: heldLive,
      };
    case 'backing_up':
    case 'migrating':
    case 'pulling':
    case 'swapping':
    case 'checking':
      return {
        checks: stage('checks', 'done', 'Passed'),
        imagesVerified: true,
        deploy: stage('deploy', 'running', stateWords(state)),
        live: waitingLive,
      };
  }
}

/**
 * A commit's six stages (SHP-REQ-156). Reads the commit's CI, its run, the live SHA, and a deploy of
 * it when there is one; the Images stage reads Expected until `verifiedDigests` or a deploy past
 * its verify step says otherwise (SHP-REQ-158), and CI links to the run (SHP-REQ-167).
 */
export function commitStages(input: CommitStagesInput): Stage[] {
  const { commit, liveSha } = input;
  const now = input.now ?? Date.now();
  const shipyard = input.buildSource === 'shipyard';
  const pushedAt = input.pushedAt ?? commit.run?.startedAt ?? null;

  const push = stage('push', 'done', join([pushedAt === null ? null : agoShort(pushedAt, now), input.branch]) || sha7(commit.sha), {
    ...(input.author ? { note: `by ${input.author}` } : {}),
  });
  const ci = ciStage(input, now);
  const buildWord = shipyard ? 'build' : 'CI';

  // The commit that is live went through the whole lane, whatever CI's record says now.
  if (commit.sha === liveSha && (input.deploy === null || input.deploy === undefined || input.deploy.state === 'succeeded')) {
    return [
      push,
      ci,
      stage('images', 'done', 'Verified', { note: 'Digests verified when it deployed' }),
      stage('checks', 'done', 'Passed'),
      stage('deploy', 'done', 'Deployed'),
      stage('live', 'done', `${sha7(commit.sha)} is live`),
    ];
  }

  const live = liveSha === null ? 'Nothing is live yet' : `${sha7(liveSha)} is live`;

  if (commit.ci === 'failure') {
    // Nothing downstream of a red CI will happen: Skipped or Blocked, never Waiting.
    return [
      push,
      ci,
      stage('images', 'skipped', 'Not built', { note: shipyard ? 'Nothing was built' : 'Nothing was pushed to GHCR' }),
      stage('checks', 'held', `Blocked by ${buildWord}`, { note: `Would refuse: ${shipyard ? 'build succeeded' : 'CI passed'} (G5)` }),
      stage('deploy', 'held', 'Blocked', { note: `Needs a green ${buildWord}` }),
      stage('live', 'held', live, { note: 'This commit cannot ship yet' }),
    ];
  }

  const ciGreen = commit.ci === 'success';
  const tail = ciGreen && input.deploy ? deployTail(input.deploy, commit.sha, liveSha, now) : null;
  const verified = input.verifiedDigests === true || tail?.imagesVerified === true;

  const images: Stage = !ciGreen
    ? stage('images', 'waiting', 'After CI', { note: shipyard ? 'Expected once the build passes' : 'Expected once CI is green' })
    : verified
      ? stage('images', 'done', 'Verified', { note: 'Digests verified' })
      : stage('images', 'waiting', 'Expected', {
          note: shipyard ? 'Expected from the Shipyard build; verified on deploy' : 'Expected from green CI; verified on deploy',
        });

  return [
    push,
    ci,
    images,
    tail?.checks ?? stage('checks', 'waiting', 'Run when you deploy', { note: 'when you deploy' }),
    tail?.deploy ?? stage('deploy', 'waiting', 'Not started', { note: planNote(input.deploy?.soakSeconds) }),
    tail?.live ?? stage('live', 'waiting', live, { note: 'This commit goes live after soak' }),
  ];
}

// ── A deploy's lane ─────────────────────────────────────────────────────

export interface DeployStagesOptions {
  now?: number;
  soakSeconds?: number;
}

/**
 * A deploy's six stages for the deploy page (SHP-REQ-156). Push and CI are what the request carried
 * — a deploy is refused at G5 if CI was red — Images are verified once the deploy holds digests,
 * Checks come from the gates, and Deploy and Live follow the target's state.
 */
export function deployStages(status: DeployStatus, steps: readonly DeployStep[], options: DeployStagesOptions = {}): Stage[] {
  const now = options.now ?? Date.now();
  const { refusal, gates } = status;
  // The soak timer counts from the recorded soak step; before that, from the deploy's start.
  const soakStartedAt = steps.find((s) => s.name === 'soak')?.startedAt ?? status.createdAt;
  const tail = deployTail(
    {
      state: status.state,
      startedAt: soakStartedAt,
      ...(options.soakSeconds === undefined ? {} : { soakSeconds: options.soakSeconds }),
      reason: refusal?.message ?? null,
    },
    status.sha,
    null,
    now,
    status.dryRun,
  );

  const ciRefused = refusal?.gate === 'G5';
  const push = stage('push', 'done', join([sha7(status.sha), status.requester.branch]), {
    note: `requested by ${status.requester.label}`,
  });
  const ci = ciRefused
    ? stage('ci', 'failed', 'Not green', { note: refusal.message })
    : stage('ci', 'done', 'Passed', { note: gates.find((g) => g.gate === 'G5')?.reason ?? 'Green when it was requested' });

  const imageCount = status.images.length;
  const images: Stage = ciRefused
    ? stage('images', 'skipped', 'Not built', { note: 'Nothing was pushed to GHCR' })
    : imageCount > 0 || tail.imagesVerified
      ? stage('images', 'done', 'Verified', {
          note: imageCount > 0 ? `${String(imageCount)} image${imageCount === 1 ? '' : 's'}, digests verified` : 'Digests verified',
        })
      : refusal?.gate === 'G8'
        ? stage('images', 'failed', 'Not in GHCR', { note: refusal.message })
        : stage('images', 'waiting', 'Expected', { note: 'Expected from green CI; verified on deploy' });

  const failedGate = gates.find((g) => !g.pass);
  const checks: Stage = ciRefused
    ? stage('checks', 'held', 'Blocked by CI', { note: 'Refused at G5' })
    : failedGate
      ? stage('checks', 'failed', `${failedGate.gate} failed`, { note: failedGate.reason })
      : gates.length > 0
        ? stage('checks', 'done', `${String(gates.length)} passed`)
        : tail.checks;

  const blocked = ciRefused || failedGate !== undefined;
  const deploy = blocked ? stage('deploy', 'held', 'Blocked', { note: 'The gates refused it' }) : tail.deploy;
  const live: Stage = blocked ? { ...tail.live, state: 'held' } : tail.live;
  return [push, ci, images, checks, deploy, live];
}

// ── The deploy page's step list ─────────────────────────────────────────

export interface StepRow {
  /** The agent's step name: "backup", "soak". */
  key: string;
  label: string;
  state: StageState;
  /** The timer or duration: "12s", "34s of 60s", "exit 1 · 3s"; empty when there is nothing to time. */
  detail: string;
}

/** The steps every deploy plans, in order; the agent names them lower-case. */
export const PLANNED_STEPS: readonly { key: string; label: string }[] = [
  { key: 'backup', label: 'Back up' },
  { key: 'migrate', label: 'Migrate' },
  { key: 'pull', label: 'Pull' },
  { key: 'swap', label: 'Swap' },
  { key: 'check', label: 'Check' },
  { key: 'soak', label: 'Soak' },
];

const TERMINAL: readonly DeployTargetState[] = ['succeeded', 'failed', 'rolled_back', 'refused', 'cancelled'];

function titleCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1).replaceAll('_', ' ');
}

/**
 * Every planned step listed up front with its timer. A step the deploy has not reached is
 * waiting; one it will never reach — the deploy ended, or a later step already ran, as when an app
 * has nothing to back up or migrate — is skipped. "Roll back" appears only when one happened.
 * The verify step is the Checks stage's, not a row here.
 */
export function deploySteps(
  steps: readonly DeployStep[],
  state: DeployTargetState,
  options: { now?: number; soakSeconds?: number } = {},
): StepRow[] {
  const now = options.now ?? Date.now();
  const ended = TERMINAL.includes(state);
  const recorded = new Map(steps.map((s) => [s.name.toLowerCase(), s]));
  const rolled = recorded.has('rollback') || state === 'rolling_back' || state === 'rolled_back';
  const plan = [
    ...PLANNED_STEPS,
    ...(rolled ? [{ key: 'rollback', label: 'Roll back' }] : []),
    ...[...recorded.keys()]
      .filter((k) => k !== 'verify' && k !== 'rollback' && !PLANNED_STEPS.some((p) => p.key === k))
      .map((k) => ({ key: k, label: titleCase(k) })),
  ];
  // Planned steps before one that already ran were not needed by this app.
  const lastPlannedRecorded = PLANNED_STEPS.reduce((last, p, i) => (recorded.has(p.key) ? i : last), -1);

  return plan.map((p, i): StepRow => {
    const step = recorded.get(p.key);
    if (step === undefined) {
      const skipped = ended || i < lastPlannedRecorded;
      const soakLength = p.key === 'soak' && options.soakSeconds !== undefined ? `${String(options.soakSeconds)}s` : '';
      return { key: p.key, label: p.label, state: skipped ? 'skipped' : 'waiting', detail: skipped ? '' : soakLength };
    }
    if (step.endedAt === null) {
      const elapsed = formatSpan(between(step.startedAt, now) ?? 0);
      const of = p.key === 'soak' && options.soakSeconds !== undefined ? ` of ${String(options.soakSeconds)}s` : '';
      return { key: p.key, label: p.label, state: 'running', detail: `${elapsed}${of}` };
    }
    const failed = step.exitCode !== null && step.exitCode !== 0;
    const took = between(step.startedAt, step.endedAt);
    return {
      key: p.key,
      label: p.label,
      state: failed ? 'failed' : 'done',
      detail: join([failed && `exit ${String(step.exitCode)}`, took === null ? null : formatSpan(took)]),
    };
  });
}
