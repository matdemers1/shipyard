// Types only: a runtime import of the schema package would put zod and every schema in the bundle.
import type { BuildState, DeployTargetState, Gate } from '@shipyard/schema';
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
