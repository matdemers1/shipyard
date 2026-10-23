// Types only: a runtime import of the schema package would put zod and every schema in the bundle.
import type {
  HostContainer,
  StackTrack,
  StackUpdatePage,
  StackUpdateRequest,
  StackUpdateState,
  StackUpdateStatus,
  StackUpdateStep,
} from '@shipyard/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefusalError, request, unreachableRefusal, type Role } from './api';
import { canChangeState } from './auth';
import { STACK_UPDATE_STATE_WORDS, STACK_UPDATE_STEP_WORDS } from './words';

/**
 * Updating an adopted stack by digest from the console (SHP-T-16.6, SHP-ADR-010; SHP-REQ-194,
 * SHP-REQ-199, SHP-REQ-200).
 *
 * The agent checks each tracked service's track and reports a candidate (SHP-REQ-194); the console
 * shows it on the stack's Host group and offers "Update…" to a deployer and above. A request names
 * only the stack, and — when the console takes the candidates — no digest at all; the agent
 * re-resolves the track and refuses a digest it does not resolve to now. A token's request waits
 * for a deployer's approval (SHP-REQ-199). Every update is kept with who asked, who approved, the
 * images before and after and how it ended: that is the stack's history, where an earlier success
 * can be rolled back to, from the agent's own ledger (SHP-REQ-200).
 *
 * Everything below the hooks is pure, so the words, the chain and the tags are unit-tested without
 * rendering.
 */

// ── What the server sends ────────────────────────────────────────────────

/** One tracked service of a stack (`GET /api/stacks`). */
export interface StackServiceView {
  service: string;
  image: string;
  track: StackTrack;
  running: string | null;
  candidate: { tag: string; digest: string } | null;
  checkedAt: string | null;
  error: string | null;
}

/** An adopted stack as `GET /api/stacks` shows it. */
export interface StackView {
  name: string;
  composeProject: string;
  updates: 'none' | 'digest';
  approval: 'tokens' | 'always' | 'never' | null;
  soakSeconds: number | null;
  services: StackServiceView[];
  reportedAt: string;
  /** The update or rollback queued, awaiting approval or running now, if any. */
  activeUpdate: StackUpdateStatus | null;
  /** The newest one that ended. */
  lastUpdate: StackUpdateStatus | null;
  /**
   * The manifest's backup step, when the server sends it: the chain names "Back up" only then. A
   * server that does not send it leaves the step out rather than promising one.
   */
  backup?: { service: string; argv?: readonly string[] } | null;
}

/** `GET /api/stack-updates/needs-you`. */
export interface StackNeeds {
  approvals: StackUpdateStatus[];
  failed: StackUpdateStatus[];
}

export const stacks = {
  list: async (signal?: AbortSignal): Promise<StackView[]> =>
    (await request<{ stacks: StackView[] }>('/api/stacks', signal === undefined ? {} : { signal })).stacks,
  update: (name: string, body: StackUpdateRequest = {}): Promise<StackUpdateStatus> =>
    request<StackUpdateStatus>(`/api/stacks/${encodeURIComponent(name)}/updates`, { method: 'POST', body }),
  rollback: (name: string, toUpdateId: string): Promise<StackUpdateStatus> =>
    request<StackUpdateStatus>(`/api/stacks/${encodeURIComponent(name)}/rollback`, { method: 'POST', body: { toUpdateId } }),
  history: (name: string, options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<StackUpdatePage> =>
    request<StackUpdatePage>(`/api/stacks/${encodeURIComponent(name)}/updates${query(options)}`, options.signal === undefined ? {} : { signal: options.signal }),
  get: (id: string, signal?: AbortSignal): Promise<StackUpdateStatus> =>
    request<StackUpdateStatus>(`/api/stack-updates/${encodeURIComponent(id)}`, signal === undefined ? {} : { signal }),
  /** Every stack update, newest first: Activity's source. */
  all: (options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<StackUpdatePage> =>
    request<StackUpdatePage>(`/api/stack-updates${query(options)}`, options.signal === undefined ? {} : { signal: options.signal }),
  needsYou: (): Promise<StackNeeds> => request<StackNeeds>('/api/stack-updates/needs-you'),
  approve: (id: string): Promise<StackUpdateStatus> => request<StackUpdateStatus>(`/api/stack-updates/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  deny: (id: string): Promise<StackUpdateStatus> => request<StackUpdateStatus>(`/api/stack-updates/${encodeURIComponent(id)}/deny`, { method: 'POST' }),
};

function query(options: { cursor?: string; limit?: number }): string {
  const params = new URLSearchParams();
  if (options.cursor !== undefined) params.set('cursor', options.cursor);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const q = params.toString();
  return q === '' ? '' : `?${q}`;
}

/** How often a running update is read: every second, as the server's contract asks. */
export const STACK_UPDATE_POLL_MS = 1_000;

/** A request held for approval can wait a long time: it is read at a gentler pace. */
export const STACK_HELD_POLL_MS = 10_000;

/** How often Host reads the stacks, with the snapshot (SHP-T-14.7). */
export const STACKS_POLL_MS = 30_000;

// ── Who may ──────────────────────────────────────────────────────────────

/** Update, roll back, approve and deny: deployer, operator and admin (SHP-REQ-199). A viewer sees none. */
export function canUpdateStacks(role: Role | undefined): boolean {
  return canChangeState(role);
}

// ── States ───────────────────────────────────────────────────────────────

const TERMINAL: readonly StackUpdateState[] = ['succeeded', 'failed', 'rolled_back', 'refused', 'denied', 'cancelled'];

export function isTerminalStackUpdate(state: StackUpdateState): boolean {
  return TERMINAL.includes(state);
}

/** Takes a plain string because a newer server can send a state this console has not met. */
export function stackUpdateStateWords(state: string): string {
  return Object.hasOwn(STACK_UPDATE_STATE_WORDS, state) ? STACK_UPDATE_STATE_WORDS[state as StackUpdateState] : state.replaceAll('_', ' ');
}

export function stackUpdateStepWords(step: string): string {
  return Object.hasOwn(STACK_UPDATE_STEP_WORDS, step) ? STACK_UPDATE_STEP_WORDS[step as StackUpdateStep] : step.replaceAll('_', ' ');
}

/** The outcome badge's tone: a rollback after a failed check is a warning, a failure or refusal danger. */
export function outcomeTone(state: StackUpdateState): 'neutral' | 'attention' | 'warning' | 'danger' {
  switch (state) {
    case 'rolled_back':
    case 'awaiting_approval':
      return 'warning';
    case 'failed':
    case 'refused':
      return 'danger';
    case 'queued':
    case 'dispatched':
    case 'running':
      return 'attention';
    default:
      return 'neutral';
  }
}

// ── Digests and tags ─────────────────────────────────────────────────────

/** `sha256:4c1e…a91f`: the algorithm, the first four and the last four hex digits. */
export function shortDigest(digest: string): string {
  const [algo, hex] = digest.includes(':') ? (digest.split(':', 2) as [string, string]) : ['', digest];
  const body = hex.length <= 12 ? hex : `${hex.slice(0, 4)}…${hex.slice(-4)}`;
  return algo === '' ? body : `${algo}:${body}`;
}

/** The tag in an image line — `postgres:16` → `16`; none for a bare repository or a digest pin. */
export function tagOfImage(image: string): string | null {
  const at = image.indexOf('@');
  const ref = at === -1 ? image : image.slice(0, at);
  const colon = ref.lastIndexOf(':');
  if (colon === -1 || colon < ref.lastIndexOf('/')) return null;
  const tag = ref.slice(colon + 1);
  return tag === '' ? null : tag;
}

/**
 * The tag a service runs now, when it can be known: from a recorded update whose images name that
 * digest (the newest first), else from the image line of the stack's running container. Null when
 * neither says — the digest is shown alone then.
 */
export function runningTag(
  service: Pick<StackServiceView, 'service' | 'running'>,
  known: readonly Pick<StackUpdateStatus, 'images' | 'previous'>[],
  containers: readonly Pick<HostContainer, 'compose' | 'image'>[] = [],
  project?: string,
): string | null {
  if (service.running !== null) {
    for (const update of known) {
      for (const image of [...update.images, ...update.previous]) {
        if (image.service === service.service && image.digest === service.running && image.tag !== null) return image.tag;
      }
    }
  }
  const container = containers.find((c) => c.compose?.service === service.service && (project === undefined || c.compose.project === project));
  return container === undefined ? null : tagOfImage(container.image);
}

/** The services with an update waiting, in the stack's order. */
export function candidates(stack: Pick<StackView, 'services'>): StackServiceView[] {
  return stack.services.filter((s) => s.candidate !== null && s.track !== 'pinned');
}

/** The first failed check, for the group's note; null when every check worked. */
export function checkError(stack: Pick<StackView, 'services'>): string | null {
  return stack.services.find((s) => s.error !== null)?.error ?? null;
}

/** What one side of a change reads as: the tag when known, else the short digest, else a dash. */
export function versionWords(tag: string | null, digest: string | null): string {
  if (tag !== null) return tag;
  return digest === null ? '—' : shortDigest(digest);
}

// ── The sheet's words ────────────────────────────────────────────────────

/** "17.x", "latest", or "pinned": what the Re-check step names. */
export function trackWords(track: StackTrack): string {
  if (track === 'pinned') return 'pinned';
  return 'semver' in track ? track.semver : track.tag;
}

/** The sheet's opening sentence: what a service follows. */
export function tracksSentence(service: Pick<StackServiceView, 'image' | 'track'>): string {
  const track = service.track;
  if (track === 'pinned') return `${service.image} is pinned; Shipyard never moves it.`;
  if ('semver' in track) return `Tracks ${service.image} at ${track.semver} — the highest ${track.semver} release the registry has.`;
  return `Tracks ${service.image} at the ${track.tag} tag — whatever it points at when the update runs.`;
}

/** "Soak 2 min", "Soak 45 s", "Soak 90 s". */
export function soakWords(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `Soak ${String(seconds / 60)} min` : `Soak ${String(seconds)} s`;
}

/**
 * The What happens chain, from the manifest (SHP-ADR-010): Re-check <track> → Back up (when the
 * stack has a backup step) → Pull by digest → Swap the image line → Health → Soak <n>.
 */
export function whatHappens(stack: Pick<StackView, 'soakSeconds' | 'backup'>, updating: readonly Pick<StackServiceView, 'track'>[]): string[] {
  const tracks = [...new Set(updating.map((s) => trackWords(s.track)))];
  const chain = [tracks.length === 0 ? 'Re-check the track' : `Re-check ${tracks.join(', ')}`];
  const backup = stack.backup ?? null;
  if (backup !== null) {
    const what = backup.argv?.slice(0, 2).join(' ') ?? '';
    chain.push(what === '' ? 'Back up' : `Back up (${what})`);
  }
  chain.push('Pull by digest', 'Swap the image line', 'Health');
  if (stack.soakSeconds !== null && stack.soakSeconds > 0) chain.push(soakWords(stack.soakSeconds));
  return chain;
}

/** What happens if the update fails: image-only rollback, and the backup when there is one. */
export function rollbackNote(from: string, hasBackup: boolean): string {
  const base = `If health or the soak fails, Shipyard puts ${from} back by its digest — images only. Data the new version changed stays changed`;
  return hasBackup ? `${base}; the backup taken first is listed under Backups.` : `${base}.`;
}

// ── Progress and results ─────────────────────────────────────────────────

/** "Soaking · 74 s of 120 s" while it soaks; the step's words otherwise; the state before a step. */
export function progressHeadline(status: Pick<StackUpdateStatus, 'state' | 'step'>, soak: { elapsed: number; of: number } | null): string {
  if (status.state === 'awaiting_approval') return STACK_UPDATE_STATE_WORDS.awaiting_approval;
  if (status.step === null) return stackUpdateStateWords(status.state);
  if (status.step === 'soaking' && soak !== null && soak.of > 0) {
    return `${STACK_UPDATE_STEP_WORDS.soaking} · ${String(Math.min(soak.elapsed, soak.of))} s of ${String(soak.of)} s`;
  }
  return stackUpdateStepWords(status.step);
}

const STEP_ORDER: readonly StackUpdateStep[] = ['verifying', 'backing_up', 'pulling', 'swapping', 'checking', 'soaking'];

/** The steps already behind it, for the banner's detail: "re-checked · backed up · pulled". */
export function stepsDone(step: StackUpdateStep | null, hasBackup: boolean): string[] {
  if (step === null || step === 'rolling_back') return [];
  const at = STEP_ORDER.indexOf(step);
  const past: Record<StackUpdateStep, string> = {
    verifying: 're-checked',
    backing_up: 'backed up',
    pulling: 'pulled',
    swapping: 'swapped',
    checking: 'healthy',
    soaking: 'soaked',
    rolling_back: 'rolled back',
  };
  return STEP_ORDER.slice(0, Math.max(0, at)).filter((s) => hasBackup || s !== 'backing_up').map((s) => past[s]);
}

/**
 * "17.1.1 → 17.1.2": what an update moved, from the images it recorded. One that did not stick
 * (rolled back, failed) names what it asked for instead — by tag when `tagFor` knows the digest
 * (the stack's candidate), else by short digest. Null when it recorded nothing to say.
 */
export function changeWords(
  update: Pick<StackUpdateStatus, 'state' | 'images' | 'previous' | 'digests'>,
  tagFor: (digest: string) => string | null = () => null,
): string | null {
  const after = update.images[0];
  const service = after?.service ?? Object.keys(update.digests ?? {})[0];
  const asked = service === undefined ? undefined : update.digests?.[service];
  const before = update.previous.find((p) => p.service === service) ?? (update.state === 'succeeded' ? undefined : after);
  const beforeWords = before === undefined ? null : versionWords(before.tag, before.digest);
  if (update.state !== 'succeeded' && asked !== undefined && after?.digest !== asked) {
    const to = tagFor(asked) ?? shortDigest(asked);
    return beforeWords === null ? `to ${to}` : `${beforeWords} → ${to}`;
  }
  if (after === undefined) return null;
  const to = versionWords(after.tag, after.digest);
  return beforeWords === null ? to : `${beforeWords} → ${to}`;
}

/**
 * The one line a finished update says: "Updated forgejo to 17.1.2", "Update of forgejo to 17.1.2
 * rolled back — 17.1.1 is running again". The refusal's message and fix follow it verbatim.
 */
export function resultHeadline(update: Pick<StackUpdateStatus, 'stack' | 'kind' | 'state' | 'images' | 'previous'>, to: string | null): string {
  const target = to === null ? '' : ` to ${to}`;
  const now = update.images[0];
  if (update.kind === 'rollback') {
    if (update.state === 'succeeded') return `Rolled ${update.stack} back${now === undefined ? target : ` to ${versionWords(now.tag, now.digest)}`}`;
    return `Rollback of ${update.stack}${target} ${stackUpdateStateWords(update.state).toLowerCase()}`;
  }
  switch (update.state) {
    case 'succeeded':
      return `Updated ${update.stack}${now === undefined ? target : ` to ${versionWords(now.tag, now.digest)}`}`;
    case 'rolled_back':
      return `Update of ${update.stack}${target} rolled back${now === undefined ? '' : ` — ${versionWords(now.tag, now.digest)} is running again`}`;
    default:
      return `Update of ${update.stack}${target} ${stackUpdateStateWords(update.state).toLowerCase()}`;
  }
}

/** Who asked, and who approved when someone did: "claude: forgejo (approved by Matthew)". */
export function requesterLine(update: Pick<StackUpdateStatus, 'requesterLabel' | 'approvedBy'>): string {
  return update.approvedBy === null ? update.requesterLabel : `${update.requesterLabel} (approved by ${update.approvedBy})`;
}

/**
 * The tags a held request moves between, from the stack's candidates and what it runs: for Needs
 * you, where the request itself names only digests.
 */
export function requestedChange(update: Pick<StackUpdateStatus, 'digests'>, stack: StackView | undefined): { from: string | null; to: string | null } {
  const entries = Object.entries(update.digests ?? {});
  const first = entries[0];
  if (first === undefined) return { from: null, to: null };
  const [service, digest] = first;
  const seen = stack?.services.find((s) => s.service === service);
  const to = seen?.candidate?.digest === digest ? seen.candidate.tag : shortDigest(digest);
  const known = [stack?.lastUpdate, stack?.activeUpdate].filter((u): u is StackUpdateStatus => u !== null && u !== undefined);
  const from = seen === undefined ? null : seen.running === null ? null : (runningTag(seen, known) ?? shortDigest(seen.running));
  return { from, to };
}

// ── Reading the stacks ───────────────────────────────────────────────────

export interface StacksData {
  /** By name. Empty until read, or when the server has no stack updates (an older one). */
  byName: ReadonlyMap<string, StackView>;
  /** The first read has answered (or failed): a sheet named in the address can say "not found" now. */
  loaded: boolean;
  refresh: () => void;
}

/**
 * `GET /api/stacks` on mount, every 30 s while the page is visible, and on `refresh` — after an
 * update is asked for or ends. A failed read keeps the last answer; an older server that has no
 * such route simply shows no candidate.
 */
export function useStacks(): StacksData {
  const [byName, setByName] = useState<ReadonlyMap<string, StackView>>(() => new Map());
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const list = await stacks.list();
      if (gen !== generation.current) return;
      setByName(new Map(list.map((s) => [s.name, s])));
      setLoaded(true);
    } catch {
      // Keep what is on screen.
      if (gen === generation.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load();
    }, STACKS_POLL_MS);
    return () => {
      generation.current += 1;
      clearInterval(timer);
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  return { byName, loaded, refresh };
}

// ── Running one update or rollback ───────────────────────────────────────

export type StackRequest = { kind: 'update'; stack: string } | { kind: 'rollback'; stack: string; toUpdateId: string };

export type StackPhase =
  | { kind: 'idle' }
  /** The POST is in flight. */
  | { kind: 'starting'; request: StackRequest }
  /** Held, queued or running: `soakStartedAt` is when this console first saw it soaking. */
  | { kind: 'following'; status: StackUpdateStatus; soakStartedAt: number | null }
  | { kind: 'done'; status: StackUpdateStatus }
  /** The server refused the request itself (locked, forbidden, updates disabled, agent offline …). */
  | { kind: 'refused'; request: StackRequest; error: RefusalError };

export function isStackBusy(phase: StackPhase): boolean {
  return phase.kind === 'starting' || phase.kind === 'following';
}

function problemOf(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

/** Polls that may fail in a row before the update is reported as lost, so one blip does not end it. */
const POLL_FAILURES_ALLOWED = 3;

/**
 * Asks for an update or a rollback, or follows one already under way, to a terminal state: every
 * second while queued, dispatched or running, every ten while it waits for approval. Stops reading
 * when the component goes away. One at a time: `run` does nothing while one is in flight.
 */
export function useStackUpdate(onEnded?: () => void): {
  phase: StackPhase;
  run: (req: StackRequest) => void;
  follow: (status: StackUpdateStatus) => void;
  reset: () => void;
} {
  const [phase, setPhase] = useState<StackPhase>({ kind: 'idle' });
  const generation = useRef(0);
  const busy = useRef(false);
  const ended = useRef(onEnded);
  ended.current = onEnded;

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const track = useCallback((gen: number, status: StackUpdateStatus, soakStartedAt: number | null, onLost: (error: RefusalError) => void): void => {
    const live = () => gen === generation.current;
    if (isTerminalStackUpdate(status.state)) {
      busy.current = false;
      setPhase({ kind: 'done', status });
      ended.current?.();
      return;
    }
    const soakAt = status.step === 'soaking' ? (soakStartedAt ?? Date.now()) : null;
    setPhase({ kind: 'following', status, soakStartedAt: soakAt });
    const next = (failures: number): void => {
      setTimeout(
        () => {
          if (!live()) return;
          stacks
            .get(status.id)
            .then((fresh) => {
              if (live()) track(gen, fresh, soakAt, onLost);
            })
            .catch((error: unknown) => {
              if (!live()) return;
              if (failures + 1 < POLL_FAILURES_ALLOWED) next(failures + 1);
              else onLost(problemOf(error));
            });
        },
        status.state === 'awaiting_approval' ? STACK_HELD_POLL_MS : STACK_UPDATE_POLL_MS,
      );
    };
    next(0);
  }, []);

  const run = useCallback(
    (req: StackRequest) => {
      if (busy.current) return;
      busy.current = true;
      const gen = ++generation.current;
      const live = () => gen === generation.current;
      const refuse = (error: RefusalError) => {
        busy.current = false;
        setPhase({ kind: 'refused', request: req, error });
      };
      setPhase({ kind: 'starting', request: req });
      const asked = req.kind === 'update' ? stacks.update(req.stack) : stacks.rollback(req.stack, req.toUpdateId);
      asked
        .then((status) => {
          if (live()) track(gen, status, null, refuse);
        })
        .catch((error: unknown) => {
          if (live()) refuse(problemOf(error));
        });
    },
    [track],
  );

  const follow = useCallback(
    (status: StackUpdateStatus) => {
      if (busy.current) return;
      busy.current = true;
      const gen = ++generation.current;
      const req: StackRequest =
        status.kind === 'rollback' ? { kind: 'rollback', stack: status.stack, toUpdateId: status.toUpdateId ?? '' } : { kind: 'update', stack: status.stack };
      track(gen, status, null, (error) => {
        busy.current = false;
        setPhase({ kind: 'refused', request: req, error });
      });
    },
    [track],
  );

  const reset = useCallback(() => {
    generation.current += 1;
    busy.current = false;
    setPhase({ kind: 'idle' });
  }, []);

  return { phase, run, follow, reset };
}

/** Seconds since `start`, ticking each second while `start` is set. */
export function useSecondsSince(start: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (start === null) return;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [start]);
  return start === null ? 0 : Math.max(0, Math.floor((now - start) / 1000));
}
