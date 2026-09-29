import type { CommitEntry, CommitsInfo } from './home';

/**
 * One app's state in plain words (SHP-T-3.10): what it is doing and why, derived from what the
 * server already answers. Home's cards and app detail's status panel both read this, so the two
 * never tell a different story about the same app.
 *
 * The case this exists for: "10 waiting" with nothing to ship. Waiting counts every commit on the
 * default branch ahead of the recorded release, but GitHub runs the image workflow once per push,
 * on the newest commit of that push — so most waiting commits never get a run of their own and
 * have no images. They are not lost: they ship inside the next green commit after them.
 */

export type StatusKind =
  | 'deploying'
  | 'approval'
  | 'drift'
  | 'ready'
  | 'ci-running'
  | 'ci-failed'
  | 'no-images'
  | 'up-to-date'
  | 'never-deployed'
  | 'github-unavailable'
  | 'no-repo';

export type StatusTone = 'neutral' | 'attention' | 'danger';

export interface AppStatus {
  kind: StatusKind;
  /** `attention` where it should change what you do next; `danger` for blocked or failed. */
  tone: StatusTone;
  /** A badge's worth: "Ready to ship". */
  label: string;
  /** One line, the thing to know: "Ready to ship 1a2b3c4". */
  headline: string;
  /** Why, in a sentence or two. */
  detail: string;
  /** The SHA a deployer can ship now, when there is one. */
  shipSha: string | null;
}

/** The facts about the commits ahead of live, counted by CI state. */
export interface CommitSummary {
  /** Every commit on the default branch ahead of the recorded release. */
  ahead: number;
  /** How many of those Shipyard asked GitHub about (the newest ten). */
  checked: number;
  green: number;
  failed: number;
  running: number;
  /** No image-workflow run on a push to the default branch — no images to deploy. */
  noRun: number;
  /** Commits after the one that would ship; they wait for a later green commit. */
  afterShip: number;
}

/** What the status needs to know about an app. Home and app detail both have these facts. */
export interface StatusInput {
  repo: string | null;
  liveSha: string | null;
  defaultBranch?: string | null;
  commits: CommitsInfo | null;
  drift: unknown;
  active: { holder: string; state: string; currentStep: string | null } | null;
  approval: { sha: string; requester: { label: string } } | undefined;
}

export function sha7(sha: string | null): string {
  return sha === null ? '—' : sha.slice(0, 7);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** Deploy states in words a person uses. */
const STATE_WORDS: Record<string, string> = {
  queued: 'Queued',
  awaiting_approval: 'Waiting for approval',
  locked: 'Starting',
  verifying: 'Checking the commit',
  backing_up: 'Backing up',
  migrating: 'Running migrations',
  pulling: 'Pulling images',
  swapping: 'Swapping containers',
  checking: 'Health check',
  soaking: 'Soaking',
  rolling_back: 'Rolling back',
  succeeded: 'Succeeded',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  refused: 'Refused',
  cancelled: 'Cancelled',
};

export function stateWords(state: string): string {
  return STATE_WORDS[state] ?? state.replaceAll('_', ' ');
}

export function stateTone(state: string): StatusTone {
  if (state === 'failed' || state === 'rolled_back' || state === 'refused') return 'danger';
  if (state === 'awaiting_approval') return 'attention';
  return 'neutral';
}

/** Per-commit build state in words, for the waiting list: GitHub CI's, or Shipyard's own build's. */
export function ciWords(ci: CommitEntry['ci'], source: CommitsInfo['buildSource'] = 'github'): string {
  if (source === 'shipyard') {
    switch (ci) {
      case 'success':
        return 'Built';
      case 'failure':
        return 'Build failed';
      case 'pending':
        return 'Building';
      case 'none':
        return 'Not built';
    }
  }
  switch (ci) {
    case 'success':
      return 'Images built';
    case 'failure':
      return 'CI failed';
    case 'pending':
      return 'CI running';
    case 'none':
      return 'No images';
  }
}

export function ciTone(ci: CommitEntry['ci']): StatusTone {
  if (ci === 'failure') return 'danger';
  if (ci === 'success') return 'attention';
  return 'neutral';
}

export function summarizeCommits(commits: CommitsInfo | null): CommitSummary {
  const entries = commits?.commits ?? [];
  const ahead = Math.max(commits?.ahead ?? 0, entries.length);
  const green = commits?.newestGreen ?? null;
  const shipIndex = green === null ? -1 : entries.findIndex((c) => c.sha === green);
  return {
    ahead,
    checked: entries.length,
    green: entries.filter((c) => c.ci === 'success').length,
    failed: entries.filter((c) => c.ci === 'failure').length,
    running: entries.filter((c) => c.ci === 'pending').length,
    noRun: entries.filter((c) => c.ci === 'none').length,
    afterShip: shipIndex === -1 ? 0 : entries.length - shipIndex - 1,
  };
}

/**
 * The newest commit that has a CI run at all: that run decides whether the latest push is
 * deployable. Commits after it without a run belong to the same push.
 */
function newestWithRun(entries: CommitEntry[]): CommitEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && entry.ci !== 'none') return entry;
  }
  return undefined;
}

/** Why the commits after the ship target are not in it yet. */
function afterShipNote(entries: CommitEntry[], shipSha: string, shipyard: boolean): string {
  const index = entries.findIndex((c) => c.sha === shipSha);
  const after = entries.slice(index + 1);
  if (after.length === 0) return '';
  if (after.some((c) => c.ci === 'pending')) {
    return ` ${plural(after.length, 'newer commit')} ${after.length === 1 ? 'is' : 'are'} still being built; wait if you want ${after.length === 1 ? 'it' : 'them'} too.`;
  }
  if (after.some((c) => c.ci === 'failure')) {
    return ` ${shipyard ? 'A newer build failed' : 'CI failed on a newer commit'}, so ${plural(after.length, 'commit')} after this one can't ship yet.`;
  }
  return ` ${plural(after.length, 'newer commit')} ${after.length === 1 ? 'has' : 'have'} no images yet and will ship with a later green commit.`;
}

export function appStatus(input: StatusInput): AppStatus {
  const { liveSha, commits, active, approval } = input;
  const branch = input.defaultBranch ?? 'the default branch';
  const summary = summarizeCommits(commits);
  const entries = commits?.commits ?? [];
  const aheadWords = plural(summary.ahead, 'commit');
  // A `build: shipyard` app's images come from Shipyard's own builds, not GitHub CI (SHP-T-3.11).
  const shipyard = commits?.buildSource === 'shipyard';
  const builder = shipyard ? 'Shipyard' : 'CI';

  if (active !== null) {
    const step = active.currentStep ?? stateWords(active.state).toLowerCase();
    return {
      kind: 'deploying',
      tone: 'attention',
      label: active.state === 'rolling_back' ? 'Rolling back' : 'Deploying',
      headline: active.state === 'rolling_back' ? 'Rolling back now' : 'Deploying now',
      detail: `${active.holder} holds this app; it is at “${step}”. Nothing else can deploy it until this finishes.`,
      shipSha: null,
    };
  }

  if (approval !== undefined) {
    return {
      kind: 'approval',
      tone: 'attention',
      label: 'Needs approval',
      headline: `Waiting for approval to ship ${sha7(approval.sha)}`,
      detail: `${approval.requester.label} asked to deploy it. A deployer has to review and approve before anything changes.`,
      shipSha: null,
    };
  }

  if (input.drift !== null && input.drift !== undefined) {
    return {
      kind: 'drift',
      tone: 'danger',
      label: 'Drift',
      headline: 'Running something Shipyard did not deploy',
      detail:
        'The containers on the host no longer match the recorded release — most often a deploy done by hand. New deploys are refused until someone adopts what is running or redeploys the recorded release.',
      shipSha: null,
    };
  }

  if (input.repo === null) {
    return {
      kind: 'no-repo',
      tone: 'neutral',
      label: 'No repository',
      headline: 'Not linked to a repository',
      detail: 'The manifest names no GitHub repository, so Shipyard has no commits to offer. Rollbacks and restores still work.',
      shipSha: null,
    };
  }

  if (commits === null || commits.source === 'unavailable') {
    return {
      kind: 'github-unavailable',
      tone: 'neutral',
      label: 'GitHub unreachable',
      headline: "Can't see new commits",
      detail:
        commits === null
          ? 'Shipyard could not read this app’s commits just now. It tries again on the next refresh.'
          : 'Shipyard could not reach GitHub, so it will not offer a deploy — its checks fail closed. It tries again shortly.',
      shipSha: null,
    };
  }

  if (liveSha === null) {
    return {
      kind: 'never-deployed',
      tone: 'neutral',
      label: 'No release yet',
      headline: 'No release recorded',
      detail:
        'Shipyard has never deployed this app, so it has nothing to compare new commits against. Open it to adopt what is running as the first release.',
      shipSha: null,
    };
  }

  const ship = commits.newestGreen;
  if (ship !== null && ship !== liveSha && entries.some((c) => c.sha === ship)) {
    const index = entries.findIndex((c) => c.sha === ship);
    const includes = Math.max(1, summary.ahead - (entries.length - index - 1));
    return {
      kind: 'ready',
      tone: 'attention',
      label: 'Ready to ship',
      headline: `Ready to ship ${sha7(ship)}`,
      detail: `${shipyard ? 'Shipyard built its images.' : 'Its images are built and CI passed.'} Shipping it brings live forward by ${plural(includes, 'commit')}.${afterShipNote(entries, ship, shipyard)}`,
      shipSha: ship,
    };
  }

  if (summary.ahead === 0) {
    return {
      kind: 'up-to-date',
      tone: 'neutral',
      label: 'Up to date',
      headline: 'Up to date',
      detail: `Live is the newest commit on ${branch}. Nothing to ship.`,
      shipSha: null,
    };
  }

  const decider = newestWithRun(entries);
  if (decider?.ci === 'pending') {
    return {
      kind: 'ci-running',
      tone: 'neutral',
      label: 'Building',
      headline: `${builder} is building ${sha7(decider.sha)}`,
      detail: `${aheadWords} since live, none deployable yet. When this ${shipyard ? 'build succeeds' : 'run passes'}, ${sha7(decider.sha)} becomes the one to ship.`,
      shipSha: null,
    };
  }

  if (decider?.ci === 'failure') {
    return {
      kind: 'ci-failed',
      tone: 'danger',
      label: shipyard ? 'Build failed' : 'CI failed',
      headline: shipyard ? `Shipyard's build of ${sha7(decider.sha)} failed` : `CI failed on ${sha7(decider.sha)}`,
      detail: shipyard
        ? `${aheadWords} since live, and the newest build failed, so nothing new is deployable. Open the build to see which stage failed, then push a fix or rebuild it.`
        : `${aheadWords} since live, and the newest build failed, so no images were published. Fix it and push again — a green push makes all of them shippable.`,
      shipSha: null,
    };
  }

  return {
    kind: 'no-images',
    tone: 'neutral',
    label: 'Nothing to ship',
    headline: `${aheadWords} since live, none ${shipyard ? 'built' : 'with images'}`,
    detail: shipyard
      ? `Shipyard builds this app itself, and none of these has a succeeded build yet. Pushes to ${branch} build on their own; to build one now, queue it from Builds (or ask Claude to run shipyard_build).`
      : `GitHub builds images once per push, for its newest commit, and none of these has a finished build on ${branch} yet. A new push's build shows up here within a minute; if none ever does, check the manifest's workflow name.`,
    shipSha: null,
  };
}

/** Where Home puts an app: what needs you first, then what is quietly fine. */
export function statusRank(kind: StatusKind): number {
  const order: StatusKind[] = [
    'approval',
    'drift',
    'deploying',
    'ready',
    'ci-failed',
    'ci-running',
    'no-images',
    'github-unavailable',
    'never-deployed',
    'no-repo',
    'up-to-date',
  ];
  return order.indexOf(kind);
}
