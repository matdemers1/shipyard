import type { BadgeTone } from '@d3cloud/ui';
import type { CommitEntry, CommitsInfo } from './home';
import { STATUS_WORDS, stateWords } from './words';

/**
 * One app's state in plain words (SHP-T-3.10): what it is doing and why, derived from what the
 * server already answers. Apps' rows, its Needs you list and app detail's status panel all read
 * this, so they never tell a different story about the same app. Apps lists rows alphabetically and
 * never by status (SHP-D-089): a row that moved under the thumb on refresh would be a mis-tap on a
 * deploy console.
 *
 * The case this exists for: "10 waiting" with nothing ready. Waiting counts every commit on the
 * default branch ahead of the recorded release, but GitHub runs the image workflow once per push,
 * on the newest commit of that push — so most waiting commits never get a run of their own and
 * have no images. They are not lost: they deploy inside the next green commit after them.
 *
 * Every label and headline here takes its words from ./words (SHP-T-13.3); `shipSha` stays the
 * field's name, and what it holds is the commit the Deploy button names.
 */

export type StatusKind =
  | 'deploying'
  | 'approval'
  | 'drift'
  | 'frozen'
  | 'ready'
  | 'ci-running'
  | 'ci-failed'
  | 'no-images'
  | 'up-to-date'
  | 'never-deployed'
  | 'github-unavailable'
  | 'no-repo';

/**
 * Every status is one of the library's four tones and nothing else (SHP-T-13.2). Derived from
 * `Badge`'s own prop type so a tone the library drops or adds fails the typecheck here, rather than
 * rendering an unstyled badge: `neutral` is quietly fine, `attention` should change what you do
 * next (and marks work in flight), `warning` is degraded or held and needs a look but not action
 * now, `danger` is blocked or failed. There is no success tone (D-016).
 */
export type StatusTone = BadgeTone;

export interface AppStatus {
  kind: StatusKind;
  /** One of the library's four tones: `attention` where it should change what you do next, `warning` for degraded or held, `danger` for blocked or failed. */
  tone: StatusTone;
  /** A badge's worth: "Ready". */
  label: string;
  /** One line, the thing to know: "Ready to deploy 1a2b3c4". */
  headline: string;
  /** Why, in a sentence or two. */
  detail: string;
  /** The SHA a deployer can deploy now, when there is one. */
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
  /** Commits after the one that would deploy; they wait for a later green commit. */
  afterShip: number;
}

/** What the status needs to know about an app. Apps and app detail both have these facts. */
export interface StatusInput {
  repo: string | null;
  liveSha: string | null;
  defaultBranch?: string | null;
  commits: CommitsInfo | null;
  drift: unknown;
  active: { holder: string; state: string; currentStep: string | null } | null;
  approval: { sha: string; requester: { label: string } } | undefined;
  /** A freeze holds now (SHP-REQ-077); absent from a server older than SHP-T-12.2. */
  frozen?: boolean;
}

export function sha7(sha: string | null): string {
  return sha === null ? '—' : sha.slice(0, 7);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * A deploy state's tone. Only a finished-and-fine or not-yet-started deploy is neutral: every state
 * in between is "Running" or "Active" on the badge, and a neutral badge is a transparent one in
 * light mode, so in-flight states are `attention` (SHP-T-13.2). A cancelled deploy ended on someone's
 * say-so, not a fault, but its app may be half-moved: `warning`, worth a look and not an alarm.
 */
export function stateTone(state: string): StatusTone {
  switch (state) {
    case 'failed':
    case 'rolled_back':
    case 'refused':
      return 'danger';
    case 'cancelled':
      return 'warning';
    case 'queued':
    case 'succeeded':
      return 'neutral';
    default:
      // awaiting_approval, locked, verifying, backing_up, migrating, pulling, swapping, checking,
      // soaking, rolling_back — and any state a newer server adds, which is more likely in flight
      // than finished.
      return 'attention';
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
 * deployable. Commits after it without a run belong to the same push. Exported so a CI-failed row
 * links to the run that failed, the same commit the status names.
 */
export function newestWithRun(entries: CommitEntry[]): CommitEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && entry.ci !== 'none') return entry;
  }
  return undefined;
}

/** Why the commits after the deploy target are not in it yet. */
function afterShipNote(entries: CommitEntry[], shipSha: string, shipyard: boolean): string {
  const index = entries.findIndex((c) => c.sha === shipSha);
  const after = entries.slice(index + 1);
  if (after.length === 0) return '';
  if (after.some((c) => c.ci === 'pending')) {
    return ` ${plural(after.length, 'newer commit')} ${after.length === 1 ? 'is' : 'are'} still being built; wait if you want ${after.length === 1 ? 'it' : 'them'} too.`;
  }
  if (after.some((c) => c.ci === 'failure')) {
    return ` ${shipyard ? 'A newer build failed' : 'CI failed on a newer commit'}, so ${plural(after.length, 'commit')} after this one can't deploy yet.`;
  }
  return ` ${plural(after.length, 'newer commit')} ${after.length === 1 ? 'has' : 'have'} no images yet and will deploy with a later green commit.`;
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
      label: active.state === 'rolling_back' ? STATUS_WORDS.rollingBack : STATUS_WORDS.deploying,
      headline: active.state === 'rolling_back' ? `${STATUS_WORDS.rollingBack} now` : `${STATUS_WORDS.deploying} now`,
      detail: `${active.holder} holds this app; it is at “${step}”. Nothing else can deploy it until this finishes.`,
      shipSha: null,
    };
  }

  if (approval !== undefined) {
    return {
      kind: 'approval',
      tone: 'attention',
      label: STATUS_WORDS.waitingForApproval,
      headline: `Waiting for approval to deploy ${sha7(approval.sha)}`,
      detail: `${approval.requester.label} asked to deploy it. A deployer has to review and approve before anything changes.`,
      shipSha: null,
    };
  }

  if (input.drift !== null && input.drift !== undefined) {
    return {
      kind: 'drift',
      tone: 'danger',
      label: STATUS_WORDS.drift,
      headline: 'Running something Shipyard did not deploy',
      detail:
        'The containers on the host no longer match the recorded release — most often a deploy done by hand. New deploys are refused until someone adopts what is running or redeploys the recorded release.',
      shipSha: null,
    };
  }

  // A freeze refuses every new deploy (G2), so it wins over "ready": offering Deploy here would only
  // lead to a refusal. A deploy already running finishes, so `active` stays above it.
  if (input.frozen === true) {
    const ship = commits?.newestGreen ?? null;
    const waiting = ship !== null && ship !== liveSha && entries.some((c) => c.sha === ship);
    return {
      kind: 'frozen',
      tone: 'warning',
      label: STATUS_WORDS.frozen,
      headline: 'Frozen — new deploys are refused',
      detail: `${waiting ? `${sha7(ship)} is ready to deploy once it is unfrozen. ` : ''}Rollbacks and restores still work while it is frozen.`,
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
      tone: 'warning',
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
      label: STATUS_WORDS.ready,
      headline: `Ready to deploy ${sha7(ship)}`,
      detail: `${shipyard ? 'Shipyard built its images.' : 'Its images are built and CI passed.'} Deploying it brings live forward by ${plural(includes, 'commit')}.${afterShipNote(entries, ship, shipyard)}`,
      shipSha: ship,
    };
  }

  if (summary.ahead === 0) {
    return {
      kind: 'up-to-date',
      tone: 'neutral',
      label: STATUS_WORDS.upToDate,
      headline: STATUS_WORDS.upToDate,
      detail: `Live is the newest commit on ${branch}. Nothing to deploy.`,
      shipSha: null,
    };
  }

  const decider = newestWithRun(entries);
  if (decider?.ci === 'pending') {
    return {
      kind: 'ci-running',
      tone: 'neutral',
      label: shipyard ? STATUS_WORDS.building : STATUS_WORDS.ciRunning,
      headline: `${builder} is building ${sha7(decider.sha)}`,
      detail: `${aheadWords} since live, none deployable yet. When this ${shipyard ? 'build succeeds' : 'run passes'}, ${sha7(decider.sha)} becomes the one to deploy.`,
      shipSha: null,
    };
  }

  if (decider?.ci === 'failure') {
    return {
      kind: 'ci-failed',
      tone: 'danger',
      label: shipyard ? STATUS_WORDS.buildFailed : STATUS_WORDS.ciFailed,
      headline: shipyard ? `Shipyard's build of ${sha7(decider.sha)} failed` : `CI failed on ${sha7(decider.sha)}`,
      detail: shipyard
        ? `${aheadWords} since live, and the newest build failed, so nothing new is deployable. Open the build to see which stage failed, then push a fix or rebuild it.`
        : `${aheadWords} since live, and the newest build failed, so no images were published. Fix it and push again — a green push makes all of them deployable.`,
      shipSha: null,
    };
  }

  return {
    kind: 'no-images',
    tone: 'neutral',
    label: STATUS_WORDS.waiting,
    headline: `${aheadWords} since live, none ${shipyard ? 'built' : 'with images'}`,
    detail: shipyard
      ? `Shipyard builds this app itself, and none of these has a succeeded build yet. Pushes to ${branch} build on their own; to build one now, queue it from Builds (or ask Claude to run shipyard_build).`
      : `GitHub builds images once per push, for its newest commit, and none of these has a finished build on ${branch} yet. A new push's build shows up here within a minute; if none ever does, check the manifest's workflow name.`,
    shipSha: null,
  };
}
