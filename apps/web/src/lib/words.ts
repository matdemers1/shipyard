// Types only: a runtime import of the schema package would put zod and every schema in the bundle.
import type {
  ActionState,
  BuildState,
  ContainerHealth,
  ContainerState,
  ContainerTier,
  DeployTargetState,
  Gate,
  LifecycleVerb,
  StackUpdateState,
  StackUpdateStep,
} from '@shipyard/schema';
import type { CommitEntry, CommitsInfo } from './home';

/**
 * One vocabulary for the console (SHP-T-13.3, SHP-REQ-165, SHP-REQ-171): Deploy, Live, Waiting,
 * Ready, CI, Images, Checks, Refused, Rolled back, Soak, Drift, Frozen. Every state label, verb and
 * check name a person reads comes from this file, and the MCP tool descriptions use the same words
 * (apps/server/src/mcp/tools.ts), so the console and a connected Claude never name one thing two
 * ways. A guard test (test/words.test.ts) fails when a label the approved design retired — "Ship",
 * "Roll all", "Confirm" — comes back, or when a deploy state or gate has no words here.
 *
 * Identifiers elsewhere (`shipSha`, the rollout routes and API) keep their names: only the words a
 * person reads change.
 */

/** A commit's short form, the way every label here names it. */
function short(sha: string): string {
  return sha.slice(0, 7);
}

// ── Verbs ────────────────────────────────────────────────────────────────

/** The primary action names the SHA it will deploy — never "Ship", "Confirm" or a bare "Roll" (SHP-ADR-006). */
export function deployVerb(sha: string): string {
  return `Deploy ${short(sha)}`;
}

/** The rollback sheet's primary: names the release that comes back. */
export function rollBackVerb(sha: string): string {
  return `Roll back to ${short(sha)}`;
}

/** The approver's primary: approving is deploying, so it names the SHA too. */
export function approveVerb(sha: string): string {
  return `Approve and deploy ${short(sha)}`;
}

/** The rollout's name where a title or feed stands alone: "Deploy all ready", "Deploy all ready 2/5". */
export const DEPLOY_ALL_READY = 'Deploy all ready';

/** The Home button over every ready app: "Deploy all ready (3)". */
export function deployAllReadyVerb(count: number): string {
  return `${DEPLOY_ALL_READY} (${String(count)})`;
}

export const VERBS = {
  rollBack: 'Roll back',
  freeze: 'Freeze',
  unfreeze: 'Unfreeze',
  deny: 'Deny',
} as const;

// ── Deploy states ────────────────────────────────────────────────────────

/**
 * A deploy's state in the words the badge, the progress page and the lists share. A total record
 * over the schema's enum: a state the server gains fails the typecheck here, not a badge in
 * production. In-flight states say which step ("Soaking", "Pulling") rather than one "Active" for
 * queued, held and soaking alike (SHP-DA-013).
 */
export const DEPLOY_STATE_WORDS: Record<DeployTargetState, string> = {
  queued: 'Queued',
  awaiting_approval: 'Waiting for approval',
  locked: 'Waiting for the agent',
  verifying: 'Verifying',
  backing_up: 'Backing up',
  migrating: 'Migrating',
  pulling: 'Pulling',
  swapping: 'Swapping',
  checking: 'Checking',
  soaking: 'Soaking',
  rolling_back: 'Rolling back',
  succeeded: 'Succeeded',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  refused: 'Refused',
  cancelled: 'Cancelled',
};

/** Takes a plain string because a newer server can send a state this console has not met. */
export function stateWords(state: string): string {
  return Object.hasOwn(DEPLOY_STATE_WORDS, state)
    ? DEPLOY_STATE_WORDS[state as DeployTargetState]
    : state.replaceAll('_', ' ');
}

/** A build's state: the same words as a deploy where the state is the same. */
export const BUILD_STATE_WORDS: Record<BuildState, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  refused: 'Refused',
};

// ── App status ───────────────────────────────────────────────────────────

/**
 * What an app's status badge says (appstatus.ts picks which). Ready is a commit that passed CI with
 * its images built; Waiting is commits ahead of live that are not deployable yet; Live is what the
 * host runs.
 */
export const STATUS_WORDS = {
  ready: 'Ready',
  waiting: 'Waiting',
  waitingForApproval: 'Waiting for approval',
  deploying: 'Deploying',
  rollingBack: 'Rolling back',
  drift: 'Drift',
  frozen: 'Frozen',
  upToDate: 'Up to date',
  ciRunning: 'CI running',
  ciFailed: 'CI failed',
  building: 'Building',
  buildFailed: 'Build failed',
} as const;

/**
 * Per-commit build state, for the waiting list: GitHub CI's, or Shipyard's own build's. "Images"
 * says whether the commit has any to deploy; "CI" is what GitHub reported.
 */
export function ciWords(ci: CommitEntry['ci'], source: CommitsInfo['buildSource'] = 'github'): string {
  if (source === 'shipyard') {
    switch (ci) {
      case 'success':
        return 'Built';
      case 'failure':
        return STATUS_WORDS.buildFailed;
      case 'pending':
        return STATUS_WORDS.building;
      case 'none':
        return 'Not built';
    }
  }
  switch (ci) {
    case 'success':
      return 'CI passed';
    case 'failure':
      return STATUS_WORDS.ciFailed;
    case 'pending':
      return STATUS_WORDS.ciRunning;
    case 'none':
      return 'No images';
  }
}

// ── Checks ───────────────────────────────────────────────────────────────

/**
 * The disk-space check. The deploy sequence reports it as `disk`, which is not one of the schema's
 * Gate values (the Gate enum is the refusal catalogue's), so its name lives here.
 */
const DISK_CHECK = 'Disk has space';

/**
 * Every deploy gate's human name (SHP-REQ-171): "CI passed", not "G5". This mirrors the schema's
 * `GATE_DESCRIPTIONS` word for word — the schema holds the catalogue, the console holds a copy
 * because importing the catalogue at runtime would add zod and every schema to the phone-first
 * bundle (about 44 kB gzipped). A total record over `Gate`, so a gate the server gains fails the
 * typecheck here, and test/words.test.ts fails if a name drifts from `GATE_DESCRIPTIONS`.
 */
export const CHECK_NAMES: Record<Gate, string> = {
  G1: 'Allowed',
  G2: 'Not frozen',
  G3: 'No drift',
  G4: 'Not locked',
  G5: 'CI passed',
  G6: 'On the default branch',
  G7: 'Ahead of live',
  G8: 'Images in GHCR',
  G9: 'Env names present',
  G10: 'No contract release since',
  G11: 'Approved',
  none: 'Not a check',
};

/**
 * A deploy check's human name, with the gate code shown beside it as secondary text. G6 reads "On
 * main" when the caller knows the default branch, and "On the default branch" when it does not. A
 * code this console does not know — a newer server's — falls back to the code itself rather than
 * hiding it.
 */
export function checkName(gate: string, options: { branch?: string | null } = {}): string {
  if (gate === 'disk') return DISK_CHECK;
  if (!Object.hasOwn(CHECK_NAMES, gate)) return gate;
  const branch = options.branch ?? null;
  return gate === 'G6' && branch !== null && branch !== '' ? `On ${branch}` : CHECK_NAMES[gate as Gate];
}

// ── Host ─────────────────────────────────────────────────────────────────

/**
 * A container's tier as the console says it (SHP-ADR-008 amendment, SHP-REQ-165): the API value
 * for a D3 app Shipyard deploys keeps its name, but a person reads **Deployed** — the retired verb
 * never comes back as a label. A total record, so a tier the schema gains fails the typecheck here.
 */
export const TIER_WORDS: Record<ContainerTier, string> = {
  shipped: 'Deployed',
  operated: 'Operated',
  observed: 'Observed',
};

/** Docker's container states, as the Host destination says them (SHP-REQ-178). */
export const CONTAINER_STATE_WORDS: Record<ContainerState, string> = {
  created: 'Created',
  running: 'Running',
  paused: 'Paused',
  restarting: 'Restarting',
  removing: 'Removing',
  exited: 'Exited',
  dead: 'Dead',
};

/** A running container's own healthcheck, after "Running · "; nothing when it declares none. */
export const HEALTH_WORDS: Record<ContainerHealth, string> = {
  healthy: 'healthy',
  unhealthy: 'unhealthy',
  starting: 'starting',
  none: '',
};

// ── Lifecycle actions (SHP-ADR-010) ──────────────────────────────────────

/** The buttons: what a person asks for. Total records, so a verb the schema gains fails the typecheck. */
export const LIFECYCLE_VERB_WORDS: Record<LifecycleVerb, string> = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  recreate: 'Recreate',
};

/** While it runs: the in-progress banner's headline. */
export const LIFECYCLE_ACTIVE_WORDS: Record<LifecycleVerb, string> = {
  start: 'Starting',
  stop: 'Stopping',
  restart: 'Restarting',
  recreate: 'Recreating',
};

/** Once it worked: the Activity badge and the result line. */
export const LIFECYCLE_PAST_WORDS: Record<LifecycleVerb, string> = {
  start: 'Started',
  stop: 'Stopped',
  restart: 'Restarted',
  recreate: 'Recreated',
};

/** A whole compose project at once, from a Host group's header. */
export const RESTART_STACK = 'Restart stack';

/** Where a lifecycle action is, in words: the same words as a deploy where the state is the same. */
export const ACTION_STATE_WORDS: Record<ActionState, string> = {
  queued: 'Queued',
  dispatched: 'Sent to the agent',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  refused: 'Refused',
  cancelled: 'Cancelled',
};

// ── Stack updates (SHP-ADR-010, SHP-P-16) ────────────────────────────────
//
// Every word the stack-update screens say (SHP-T-16.6): the group header, the update sheet and its
// chain, the progress banner and results, the history, Needs you and Activity. The components and
// lib/stacks.ts only compose these; test/words.test.ts fails if they spell copy of their own.

/**
 * Where a stack update or rollback is, and how it ended (SHP-REQ-200): the deploy's words where the
 * state is the same. A total record over the schema's enum, so a state it gains fails the typecheck.
 */
export const STACK_UPDATE_STATE_WORDS: Record<StackUpdateState, string> = {
  queued: 'Queued',
  awaiting_approval: 'Waiting for approval',
  dispatched: 'Sent to the agent',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  refused: 'Refused',
  denied: 'Denied',
  cancelled: 'Cancelled',
};

/** The step a running update is on, as the in-progress banner says it. */
export const STACK_UPDATE_STEP_WORDS: Record<StackUpdateStep, string> = {
  verifying: 'Re-checking the track',
  backing_up: 'Backing up',
  pulling: 'Pulling by digest',
  swapping: 'Swapping the image line',
  checking: 'Checking health',
  soaking: 'Soaking',
  rolling_back: 'Rolling back',
};

/** The steps already behind a running update, for the banner's detail. */
export const STACK_STEP_DONE_WORDS: Record<StackUpdateStep, string> = {
  verifying: 're-checked',
  backing_up: 'backed up',
  pulling: 'pulled',
  swapping: 'swapped',
  checking: 'healthy',
  soaking: 'soaked',
  rolling_back: 'rolled back',
};

/**
 * The soak, while it runs. The status carries no time the soak began, so the banner names its
 * length rather than a countdown that would start over on every reload.
 */
export function soakingWords(seconds: number): string {
  return `${STACK_UPDATE_STEP_WORDS.soaking} · ${String(seconds)} s soak`;
}

/** The group header's button: opens the update sheet. */
export const UPDATE_STACK = 'Update…';

/** The group header's link to the stack's history, and the sheet's section. */
export const STACK_HISTORY = 'History';

/** "History of forgejo": the link's full name. */
export function historyOfWords(stack: string): string {
  return `${STACK_HISTORY} of ${stack}`;
}

/** The update sheet's primary: names the tag it will update to. */
export function updateToVerb(tag: string): string {
  return `Update to ${tag}`;
}

/** The history sheet's way to the update sheet. */
export function updateToLinkWords(tag: string): string {
  return `${updateToVerb(tag)}…`;
}

/** The group header's badge: the candidate the agent found (SHP-REQ-194). */
export function updateAvailableWords(from: string, to: string): string {
  return `Update available · ${from} → ${to}`;
}

/** A failed registry check, said on the group header. */
export function checkFailedWords(error: string): string {
  return `Couldn't check for updates: ${error}`;
}

/** The approver's primary on a held stack update (SHP-REQ-199): approving is updating. */
export const APPROVE_AND_UPDATE = 'Approve and update';

/** …and on a held rollback: approving is rolling back. */
export const APPROVE_AND_ROLL_BACK = 'Approve and roll back';

/** A held request, said where it waits. */
export const WAITING_FOR_DEPLOYER = 'Waiting for a deployer to approve';

/** Under it: who asked, and where it is approved. */
export function heldHintWords(requester: string): string {
  return `Requested by ${requester}. It runs once a deployer approves it in Needs you.`;
}

/** The history's rollback confirmation, title and primary: names the stack and what comes back. */
export function stackRollBackVerb(stack: string, to: string): string {
  return `Roll back ${stack} to ${to}`;
}

/** What the rollback confirmation says it does: the agent's ledger, images only. */
export const STACK_ROLL_BACK_CONSEQUENCE = "Shipyard puts back the images that update ran, by digest, from the agent's own ledger. Images only: data stays as it is.";

/** The rollback target when the update recorded no image. */
export const AN_EARLIER_UPDATE = 'an earlier update';

/** Activity's chip for the source. */
export const STACK_UPDATES = 'Stack updates';

// The update sheet.

export const UPDATE_SHEET_COLUMNS = { service: 'Service', running: 'Running', to: 'Update to' } as const;
export const WHAT_HAPPENS = 'What happens';
export const UPDATE_HISTORY = 'Update history';
export const RUNNING_NOW = 'Running now';
export const STACK_UPDATE_NONE = 'Every tracked service runs what its track resolves to now.';
export const STACK_NOT_FOUND = 'Stack not found';
export const LOADING_HISTORY = 'Loading the history';
export const NO_UPDATES_YET = 'No updates yet';

/** The update sheet's title. */
export function updateStackTitle(stack: string): string {
  return `Update ${stack}`;
}

export function stackNotFoundWords(stack: string): string {
  return `No adopted stack is named ${stack}. It may have been retired since the link was made.`;
}

export function noUpdatesYetWords(stack: string): string {
  return `An update or rollback of ${stack} shows up here with who asked and how it ended.`;
}

/** A stack adopted with `updates: none`, opened at its update sheet. */
export function updatesNoneWords(stack: string): string {
  return `${stack} is adopted with updates: none. Shipyard only starts, stops, restarts and recreates it.`;
}

/** What a service follows: the sheet's opening sentence. */
export function tracksWords(image: string, track: { kind: 'pinned' } | { kind: 'semver'; range: string } | { kind: 'tag'; tag: string }): string {
  switch (track.kind) {
    case 'pinned':
      return `${image} is pinned; Shipyard never moves it.`;
    case 'semver':
      return `Tracks ${image} at ${track.range} — the highest ${track.range} release the registry has.`;
    case 'tag':
      return `Tracks ${image} at the ${track.tag} tag — whatever it points at when the update runs.`;
  }
}

/** The What happens chain's steps (SHP-ADR-010). */
export const CHAIN_WORDS = {
  recheckTrack: 'Re-check the track',
  backUp: 'Back up',
  pull: 'Pull by digest',
  swap: 'Swap the image line',
  health: 'Health',
  pinned: 'pinned',
} as const;

export function recheckWords(tracks: readonly string[]): string {
  return tracks.length === 0 ? CHAIN_WORDS.recheckTrack : `Re-check ${tracks.join(', ')}`;
}

/** "Back up (forgejo dump)": the backup step, named by its program and subcommand when known. */
export function backUpWords(what: string): string {
  return what === '' ? CHAIN_WORDS.backUp : `${CHAIN_WORDS.backUp} (${what})`;
}

/** "Soak 2 min", "Soak 45 s", "Soak 90 s". */
export function soakWords(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `Soak ${String(seconds / 60)} min` : `Soak ${String(seconds)} s`;
}

/** What happens if the update fails: image-only rollback, and the backup when there is one. */
export function rollbackNoteWords(from: string, hasBackup: boolean): string {
  const base = `If health or the soak fails, Shipyard puts ${from} back by its digest — images only. Data the new version changed stays changed`;
  return hasBackup ? `${base}; the backup taken first is listed under Backups.` : `${base}.`;
}

/** The rollback note's "from" when nothing runs yet. */
export const WHAT_RUNS_NOW = 'what runs now';

// Progress and results.

export const STACK_PROGRESS_WORDS = {
  updating: 'Updating',
  rollingBack: 'Rolling back',
  asking: 'Asking Shipyard',
} as const;

export function requestedByWords(requester: string): string {
  return `requested by ${requester}`;
}

/** Who asked, and who approved when someone did: "claude: forgejo (approved by Matthew)". */
export function requesterLineWords(requester: string, approvedBy: string | null): string {
  return approvedBy === null ? requester : `${requester} (approved by ${approvedBy})`;
}

/**
 * The one line a finished update or rollback says: "Updated forgejo to 17.1.2", "Update of forgejo
 * to 17.1.2 rolled back — 17.1.1 is running again". `target` is what it asked for, `now` what runs
 * after it, either null when unknown. The refusal's message and fix follow it verbatim.
 */
export function stackResultWords(kind: 'update' | 'rollback', state: StackUpdateState, stack: string, target: string | null, now: string | null): string {
  const to = target === null ? '' : ` to ${target}`;
  const stateWord = STACK_UPDATE_STATE_WORDS[state].toLowerCase();
  if (kind === 'rollback') {
    if (state === 'succeeded') return `Rolled ${stack} back${now === null ? to : ` to ${now}`}`;
    return `Rollback of ${stack}${to} ${stateWord}`;
  }
  if (state === 'succeeded') return `Updated ${stack}${now === null ? to : ` to ${now}`}`;
  if (state === 'rolled_back') return `Update of ${stack}${to} rolled back${now === null ? '' : ` — ${now} is running again`}`;
  return `Update of ${stack}${to} ${stateWord}`;
}

/** What a history or Activity row moved: "Update 17.1.1 → 17.1.2", "Rollback · 17.0.4". */
export const STACK_KIND_WORDS = { update: 'Update', rollback: 'Rollback' } as const;

export function stackChangeWords(kind: 'update' | 'rollback', change: string | null): string {
  if (change === null) return STACK_KIND_WORDS[kind];
  return kind === 'rollback' ? `${STACK_KIND_WORDS.rollback} · ${change}` : `${STACK_KIND_WORDS.update} ${change}`;
}

/** "to 17.1.2": an asked-for target with nothing recorded before it. */
export function toWords(target: string): string {
  return `to ${target}`;
}

// Needs you.

/** "update 17.1.1 → 17.1.2 · asked by claude: homelab upkeep": a held stack request (SHP-REQ-199). */
export function heldStackWords(kind: 'update' | 'rollback', from: string | null, to: string | null, requester: string): string {
  const what =
    kind === 'rollback'
      ? 'rollback'
      : to === null
        ? 'update'
        : from === null
          ? `update to ${to}`
          : `update ${from} → ${to}`;
  return `${what} · asked by ${requester}`;
}

export const HELD_STACK_FALLBACK = 'update waiting for approval';
export const FAILED_STACK_FALLBACK = 'update did not finish';

/** "update rolled back — <message>": a failed or rolled-back stack update; its fix follows on its own line. */
export function failedStackWords(kind: 'update' | 'rollback', state: StackUpdateState, message: string | null): string {
  const what = `${kind} ${STACK_UPDATE_STATE_WORDS[state].toLowerCase()}`;
  return message === null ? what : `${what} — ${message}`;
}

export const OPEN_STACK = 'Open stack';

export function openStackOnHostWords(stack: string): string {
  return `Open ${stack} on Host`;
}

/** The deny button's full name and the deny confirmation's title. */
export function denyStackWords(stack: string, kind: 'update' | 'rollback'): string {
  return `${VERBS.deny} the ${stack} ${kind}`;
}

export const DENY_STACK_CONSEQUENCE = 'It will not run. It can be requested again later.';

/** A sheet's own controls, the way the container sheet names them. */
export const SHEET_WORDS = { close: 'Close', cancel: 'Cancel', done: 'Done' } as const;

/** The Roll back button's full name on a history row: "Roll back to 17.0.4". */
export function rollBackToWords(to: string): string {
  return `${VERBS.rollBack} to ${to}`;
}

/** The update button's full name on a group header: "Update… forgejo". */
export function updateStackLabel(stack: string): string {
  return `${UPDATE_STACK} ${stack}`;
}

/** The approver's primary on a held stack request: what approving does, by its kind (SHP-REQ-199). */
export function approveStackVerb(kind: 'update' | 'rollback'): string {
  return kind === 'rollback' ? APPROVE_AND_ROLL_BACK : APPROVE_AND_UPDATE;
}

/** Its full name: "Approve and update forgejo". */
export function approveStackLabel(kind: 'update' | 'rollback', stack: string): string {
  return `${approveStackVerb(kind)} ${stack}`;
}
