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
  MaintenanceState,
  MaintenanceStatus,
  MaintenanceStep,
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

// ── Volumes and prune (SHP-ADR-012, SHP-P-17) ────────────────────────────
//
// Every word the volume and prune screens say (SHP-T-17.6): the Host volumes list and its archives,
// the back-up confirmation, the restore, delete and prune sheets, the progress banner and results,
// Needs you and Activity. The components and lib/maintenance.ts only compose these; the guard in
// test/words.test.ts fails if they spell copy of their own.

/** The months as an archive's time says them: "Oct 21 22:40". */
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const TODAY = 'Today';
export const YESTERDAY = 'Yesterday';

/** Where a maintenance job is, and how it ended. A total record over the schema's enum. */
export const MAINTENANCE_STATE_WORDS: Record<MaintenanceState, string> = {
  queued: 'Queued',
  dispatched: 'Sent to the agent',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  refused: 'Refused',
  cancelled: 'Cancelled',
};

/** The step a running job is on, as the in-progress banner says it. */
export const MAINTENANCE_STEP_WORDS: Record<MaintenanceStep, string> = {
  queued: 'Queued',
  stopping: 'Stopping',
  archiving: 'Archiving',
  restoring: 'Restoring',
  starting: 'Starting',
  checking: 'Checking health',
  deleting: 'Deleting',
  listing: 'Listing',
  pruning: 'Pruning',
  retaining: 'Removing old archives',
};

/** "Archiving · forgejo_data"; a prune names no volume. */
export function maintenanceProgressWords(step: string, volume: string | null): string {
  return volume === null ? step : `${step} · ${volume}`;
}

/** What a job is, by its kind: Activity's badge on a job that did not succeed. */
export const MAINTENANCE_KIND_WORDS: Record<MaintenanceStatus['kind'], string> = {
  'volume-backup': 'Backup',
  'volume-restore': 'Restore',
  'volume-delete': 'Delete',
  prune: 'Prune',
};

/** What a job did, once it worked: Activity's badge. */
export const MAINTENANCE_DONE_WORDS: Record<MaintenanceStatus['kind'], string> = {
  'volume-backup': 'Backed up',
  'volume-restore': 'Restored',
  'volume-delete': 'Deleted',
  prune: 'Pruned',
};

export const VOLUME_WORDS = {
  heading: 'Volumes',
  hint: 'Back up and restore owned volumes, delete orphans. Observed volumes are shown, never touched.',
  none: 'No named volumes.',
  noMounts: 'No container mounts it',
  orphaned: 'Orphaned',
  observed: 'Observed — no actions',
  backUp: 'Back up',
  restore: 'Restore…',
  remove: 'Delete…',
  prune: 'Prune…',
  archives: 'Archives',
  quiesced: 'Quiesced',
  liveCopy: 'Live copy',
  noArchives: 'No archives yet. Back up takes the first.',
  loadingArchives: 'Loading the archives',
  newestFirst: 'newest first',
  asking: 'Asking the server',
  dryRun: 'Dry run',
} as const;

/** A volume's name in the list, when Docker gave it no name of its own. */
export function anonymousVolumeWords(name: string): string {
  return `${name.slice(0, 6)}…${name.slice(-4)} (anonymous)`;
}

/** "Archives · 3", the toggle's visible words; null while the count is being read. */
export function archivesCountWords(count: number | null): string {
  return count === null ? VOLUME_WORDS.archives : `${VOLUME_WORDS.archives} · ${String(count)}`;
}

/** The toggle's full name: "Archives · 3 of bindery_pgdata". */
export function archivesOfWords(count: number | null, volume: string): string {
  return `${archivesCountWords(count)} of ${volume}`;
}

/** "Back up bindery_pgdata", "Restore… bindery_pgdata", "Delete… kardashev_pgdata": the row buttons' full names. */
export function volumeActionLabel(action: 'backUp' | 'restore' | 'remove', volume: string): string {
  return `${VOLUME_WORDS[action]} ${volume}`;
}

/** An archive row's Restore…: "Restore… the Oct 21 22:40 archive of forgejo_data". */
export function restoreArchiveLabel(time: string, volume: string): string {
  return `${VOLUME_WORDS.restore} the ${time} archive of ${volume}`;
}

/** The archives list's caption: "5 archives · newest first". */
export function archivesCaptionWords(count: number): string {
  return `${String(count)} ${count === 1 ? 'archive' : 'archives'} · ${VOLUME_WORDS.newestFirst}`;
}

/** A volume claimed by an app or stack's compose label that nothing mounts: neither delete nor back up. */
export function claimedVolumeWords(owner: string): string {
  return `Nothing mounts it; ${owner} claims it, so it is never deleted from here`;
}

export function showingVolumesWords(shown: number, total: number): string {
  return `Showing ${String(shown)} of ${String(total)} · orphans first · Delete… appears only on volumes no container mounts, running or stopped`;
}

export function showAllVolumesWords(total: number): string {
  return `Show all ${String(total)}`;
}

export function showFirstVolumesWords(count: number): string {
  return `Show the first ${String(count)}`;
}

// The back-up confirmation (SHP-REQ-201). Quiesce is the manifest's, never asked here.

export function backUpTitle(volume: string): string {
  return `Back up ${volume}?`;
}

export function backUpVolumeWords(volume: string): string {
  return `Copies ${volume} into a new archive in the agent's own ledger. The owner's manifest decides whether it is stopped for the copy, and how many archives are kept: the oldest beyond that is removed.`;
}

export const BACK_UP_FOOT = 'Deployer, operator or admin. Recorded in Activity.';

// The restore sheet (SHP-REQ-202).

export function restoreTitle(volume: string): string {
  return `Restore ${volume}`;
}

export function restoreIntroWords(volume: string, owner: string, containers: number): string {
  return `Puts one archive back into ${volume}. Shipyard stops ${owner} (${String(containers)} ${containers === 1 ? 'container' : 'containers'}) for the restore and starts it again after.`;
}

export const RESTORE_WARNING_TITLE = 'The volume’s current contents are replaced';

export function restoreWarningWords(volume: string, size: string): string {
  return `Everything in ${volume} now (${size}) is overwritten by the archive you pick. Anything written after that archive was taken is lost. Back up first if you might want it.`;
}

export const WHAT_HAPPENS_TITLE = 'What happens';
export const ARCHIVE_TITLE = 'Archive';
export const NEWEST_FIRST = 'Newest first';

/** Stop the owner → empty the volume → unpack the archive → start the owner → health. */
export function archiveChainWords(volume: string, owner: string, containers: number, archiveTime: string | null): string[] {
  return [
    `Stop ${owner} (${String(containers)} ${containers === 1 ? 'container' : 'containers'})`,
    `Empty ${volume}`,
    archiveTime === null ? 'Unpack the archive' : `Unpack the ${archiveTime} archive`,
    `Start ${owner}`,
    'Health',
  ];
}

export function typeToConfirmWords(volume: string): string {
  return `Type ${volume} to confirm`;
}

export const NAME_MATCHES = 'Matches the volume name';
export const NAME_DOES_NOT_MATCH = 'Not a match yet: type the name exactly, capitals included';
export const AUTHENTICATOR_CODE = 'Authenticator code';
export const RESTORE_STEP_UP_HELP = 'Step-up: a fresh 6-digit code from your authenticator, asked again because restore replaces data.';
export const DELETE_STEP_UP_HELP = 'Step-up: a fresh 6-digit code from your authenticator.';
export const RESTORE_FOOT = 'Admin · console only. Restore is never offered over MCP.';
export const NO_ARCHIVE_TO_RESTORE = 'This volume has no archive to restore yet.';
export const VOLUME_NOT_FOUND = 'Volume not found';

export function volumeNotFoundWords(volume: string): string {
  return `The host reports no volume named ${volume}. It may have been removed; the list on Host is current.`;
}

export function restoreVerb(volume: string): string {
  return `Restore ${volume}`;
}

// The delete sheet (SHP-REQ-203).

export function deleteTitle(volume: string): string {
  return `Delete ${volume}`;
}

export function deleteIntroWords(project: string | null): string {
  return project === null
    ? 'No container mounts this volume, running or stopped, and no compose project labels it.'
    : `No container mounts this volume, running or stopped. Its compose label says it last belonged to ${project}.`;
}

export const DELETE_FACTS = {
  label: 'About this volume',
  size: 'Size',
  created: 'Created',
  driver: 'Driver',
  project: 'Project label',
  mountedBy: 'Mounted by',
  noContainer: 'No container, running or stopped',
  unknown: '—',
} as const;

export const DELETE_WARNING_TITLE = 'This cannot be undone';

export function deleteWarningWords(size: string): string {
  return `Deleting removes the volume and its ${size} of data. Shipyard keeps no archive of orphans, and Docker has no trash.`;
}

export function deleteInUseWords(volume: string): string {
  return `If a container mounts ${volume} before you press Delete, Shipyard refuses with volume_in_use and deletes nothing. Deployed and Operated volumes never offer Delete.`;
}

export const DELETE_FOOT = 'Admin · console only. Never offered over MCP.';

export function deleteVerb(volume: string): string {
  return `Delete ${volume}`;
}

// The prune sheet (SHP-REQ-205).

export const PRUNE_TITLE = 'Prune images and build cache';
export const PRUNE_INTRO = 'What Docker would remove right now. Prune these removes exactly this list; anything that changed since the dry run is left alone.';
export const PRUNE_NO_VOLUMES = 'Volumes are never pruned. Delete orphaned volumes one at a time from their row.';
export const PRUNE_LISTING = 'Listing what a prune would remove';
export const PRUNE_RUN_AGAIN = 'Run the dry run again';
export const PRUNE_THESE = 'Prune these';
export const PRUNE_NOTHING = 'Nothing to prune';
export const PRUNE_NOTHING_WORDS = 'No dangling image, unused image or build cache entry is old enough to remove.';

export const PRUNE_GROUP_WORDS = {
  dangling: { title: 'Dangling images', hint: 'Untagged layers no container uses' },
  unused: { title: 'Unused images, older than 7 days', hint: 'Tagged, but no container (running or stopped) uses them' },
  cache: { title: 'Build cache, older than 7 days', hint: 'BuildKit entries not used in a week' },
} as const;

/** "3.2 GB back". */
export function reclaimWords(size: string): string {
  return `${size} back`;
}

/** "18 items · dry run at 14:31". */
export function pruneSummaryWords(count: number, clock: string): string {
  return `${String(count)} ${count === 1 ? 'item' : 'items'} · dry run at ${clock}`;
}

/** A group's total: "5 · 1.4 GB". */
export function pruneGroupTotalWords(count: number, size: string): string {
  return `${String(count)} · ${size}`;
}

/** An item's detail: "untagged · 12 days", "unused · 21 days", "cache · 9 days". */
export function pruneItemDetailWords(reason: 'dangling' | 'unused' | 'old-cache', days: number | null): string {
  const what = reason === 'dangling' ? 'untagged' : reason === 'unused' ? 'unused' : 'cache';
  return days === null ? what : `${what} · ${String(days)} ${days === 1 ? 'day' : 'days'}`;
}

export function pruneFootWords(count: number | null): string {
  return count === null
    ? 'Deployer, operator or admin. Recorded in Activity.'
    : `Deployer, operator or admin. Removes only the ${String(count)} ${count === 1 ? 'item' : 'items'} above; recorded in Activity.`;
}

// Results, inline and in Activity.

/** "Backed up forgejo_data · 1.1 GB". */
export function backedUpWords(volume: string, size: string | null): string {
  return size === null ? `Backed up ${volume}` : `Backed up ${volume} · ${size}`;
}

/** "Quiesced · 1 older archive removed", "Live copy". */
export function backedUpDetailWords(quiesced: boolean, removed: number): string {
  const how = quiesced ? 'quiesced' : 'live copy';
  return removed === 0 ? how : `${how} · ${String(removed)} older ${removed === 1 ? 'archive' : 'archives'} removed`;
}

export function restoredWords(volume: string): string {
  return `Restored ${volume}`;
}

export function deletedWords(volume: string): string {
  return `Deleted ${volume}`;
}

/** "Freed 3.2 GB". */
export function freedWords(size: string): string {
  return `Freed ${size}`;
}

/** "Removed 5 dangling images, 4 unused images and 9 build-cache entries · no volumes touched". */
export function freedDetailWords(dangling: number, unused: number, cache: number): string {
  const parts = [
    `${String(dangling)} dangling ${dangling === 1 ? 'image' : 'images'}`,
    `${String(unused)} unused ${unused === 1 ? 'image' : 'images'}`,
    `${String(cache)} build-cache ${cache === 1 ? 'entry' : 'entries'}`,
  ];
  return `Removed ${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''} · no volumes touched`;
}

/** "Didn’t delete kardashev_pgdata · volume_in_use": what did not happen, and the code that says why. */
export function didNotWords(kind: MaintenanceStatus['kind'], volume: string | null, code: string | null): string {
  const verb = { 'volume-backup': 'back up', 'volume-restore': 'restore', 'volume-delete': 'delete', prune: 'prune' }[kind];
  const what = volume === null ? `Didn’t ${verb}` : `Didn’t ${verb} ${volume}`;
  return code === null ? what : `${what} · ${code}`;
}

/** Activity's name for a prune, which names no volume. */
export const IMAGES_AND_CACHE = 'Images and build cache';

/** A dry run in Activity: "Dry run · 18 items, 3.2 GB". */
export function dryRunWords(count: number, size: string): string {
  return `${VOLUME_WORDS.dryRun} · ${String(count)} ${count === 1 ? 'item' : 'items'}, ${size}`;
}

/** Activity's chip for the volume and prune jobs. */
export const MAINTENANCE_CHIP = 'Maintenance';

// Needs you.

/** "backup failed — <message>": a volume whose latest backup did not work; its fix is the second line. */
export function failedBackupWords(state: string, message: string | null): string {
  const what = state === 'refused' ? 'backup refused' : 'backup failed';
  return message === null ? what : `${what} — ${message}`;
}

/** "/DATA is 93.4% full · 61.2 GB free". */
export function lowDiskWords(mount: string, usedPercent: number, free: string): string {
  return `${mount} is ${String(usedPercent)}% full · ${free} free`;
}

export const OPEN_VOLUME = 'Open volume';
export const OPEN_DISK = 'Open disk';

export function openVolumeOnHostWords(volume: string): string {
  return `Open ${volume} on Host`;
}

export function openDiskOnHostWords(mount: string): string {
  return `Open ${mount} on Host`;
}

/** The Host footnote: the three tiers, and what is acted on. */
export const HOST_FOOTNOTE =
  'Deployed is a D3 app Shipyard deploys; Operated is a third-party stack you adopted with a manifest; Observed is everything else Docker runs, shown and never touched. No environment, command or labels ever leave the host.';

/** The rest of a long prune group, in one row: "7 more entries · 170.0 MB". */
export function morePruneItemsWords(count: number, size: string): string {
  return `${String(count)} more ${count === 1 ? 'entry' : 'entries'} · ${size}`;
}
