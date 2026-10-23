// Types only: a runtime import of the schema package would put zod and every schema in the bundle.
import type {
  ContainerTier,
  HostContainer,
  HostInventory,
  HostVolume,
  MaintenancePage,
  MaintenanceState,
  MaintenanceStatus,
  MaintenanceStep,
  PruneItem,
  PruneRequest,
  VolumeArchive,
  VolumeDeleteRequest,
  VolumeRestoreRequest,
} from '@shipyard/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefusalError, request, unreachableRefusal, type Role } from './api';
import { canChangeState } from './auth';
import { isDeployedTier } from './host';
import { formatBytes } from './restore';
import {
  MAINTENANCE_STATE_WORDS,
  MAINTENANCE_STEP_WORDS,
  MONTHS,
  TIER_WORDS,
  TODAY,
  YESTERDAY,
  archiveChainWords,
  maintenanceProgressWords,
} from './words';

/**
 * Volume backups, restores, orphan deletes and prune from the console (SHP-T-17.6, SHP-ADR-012 and
 * its 2026-10-23 amendment; SHP-REQ-201, SHP-REQ-202, SHP-REQ-203, SHP-REQ-205).
 *
 * - **Back up** (SHP-REQ-201): a deployer and up, for a volume a Deployed app or an Operated stack
 *   owns. The body names nothing; whether the owner is stopped for the copy is the manifest's.
 * - **Restore** (SHP-REQ-202) and **delete** (SHP-REQ-203): an admin, in the console, with the
 *   volume's name typed exactly and a step-up from the last ten minutes — a person's own session,
 *   never a token. Delete is offered only on an orphan nothing claims.
 * - **Prune** (SHP-REQ-205): a deployer and up, and only from a dry run: the real prune names the
 *   dry run it follows (`fromDryRunId`) and removes only what that listed.
 *
 * A job is followed by polling `GET /api/maintenance/:id` every second while it is queued, sent or
 * running, and stops when it ends or the screen goes. Everything below the hooks is pure, so the
 * gating, the order, the words and the prune groups are unit-tested without rendering.
 */

// ── What the server sends ────────────────────────────────────────────────

export interface LowDisk {
  mount: string;
  usedPercent: number;
  freeBytes: number;
}

/** `GET /api/maintenance/needs-you`. */
export interface MaintenanceNeeds {
  failedBackups: MaintenanceStatus[];
  lowDisk: LowDisk[];
}

export type { MaintenanceStatus, VolumeArchive, PruneItem };

function query(options: { cursor?: string; limit?: number }): string {
  const params = new URLSearchParams();
  if (options.cursor !== undefined) params.set('cursor', options.cursor);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const q = params.toString();
  return q === '' ? '' : `?${q}`;
}

const volumePath = (volume: string): string => `/api/volumes/${encodeURIComponent(volume)}`;

export const maintenance = {
  backup: (volume: string): Promise<MaintenanceStatus> => request<MaintenanceStatus>(`${volumePath(volume)}/backup`, { method: 'POST', body: {} }),
  restore: (volume: string, body: VolumeRestoreRequest): Promise<MaintenanceStatus> =>
    request<MaintenanceStatus>(`${volumePath(volume)}/restore`, { method: 'POST', body }),
  remove: (volume: string, body: VolumeDeleteRequest): Promise<MaintenanceStatus> =>
    request<MaintenanceStatus>(`${volumePath(volume)}/delete`, { method: 'POST', body }),
  archives: async (volume: string, signal?: AbortSignal): Promise<VolumeArchive[]> =>
    (await request<{ archives: VolumeArchive[] }>(`${volumePath(volume)}/archives`, signal === undefined ? {} : { signal })).archives,
  prune: (body: PruneRequest): Promise<MaintenanceStatus> => request<MaintenanceStatus>('/api/prune', { method: 'POST', body }),
  get: (id: string, signal?: AbortSignal): Promise<MaintenanceStatus> =>
    request<MaintenanceStatus>(`/api/maintenance/${encodeURIComponent(id)}`, signal === undefined ? {} : { signal }),
  /** Every maintenance job, newest first: Activity's source. */
  list: (options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<MaintenancePage> =>
    request<MaintenancePage>(`/api/maintenance${query(options)}`, options.signal === undefined ? {} : { signal: options.signal }),
  needsYou: (): Promise<MaintenanceNeeds> => request<MaintenanceNeeds>('/api/maintenance/needs-you'),
  /**
   * A fresh step-up on this session (SHP-ADR-012 amendment). Not session-bearing: a wrong code is a
   * 401, and that must say "wrong code", not sign the person out.
   */
  stepUp: (code: string): Promise<{ ok: true; until: string }> =>
    request<{ ok: true; until: string }>('/api/auth/step-up', { method: 'POST', body: { code }, sessionBearing: false }),
};

/** A running job is read every second, as the server's contract asks. */
export const MAINTENANCE_POLL_MS = 1_000;

/** Reads that may fail in a row before the console stops following and says so. */
const POLL_FAILURES_ALLOWED = 3;

// ── Who may ──────────────────────────────────────────────────────────────

/** Back up and prune: deployer, operator and admin (SHP-REQ-201, SHP-REQ-205). */
export function canBackUpOrPrune(role: Role | undefined): boolean {
  return canChangeState(role);
}

/** Restore and delete: an admin, in the console (SHP-REQ-202, SHP-REQ-203). */
export function canRestoreOrDelete(role: Role | undefined): boolean {
  return role === 'admin';
}

// ── Which volumes are whose ──────────────────────────────────────────────

/**
 * - `owned`: a container of a Deployed app's or an adopted stack's compose project mounts it —
 *   back up and restore.
 * - `orphan`: nothing mounts it and no app or stack claims its compose project — delete.
 * - `claimed`: nothing mounts it, but its compose label names an app's or a stack's project. The
 *   server refuses to delete it (`volume_not_owned`) and cannot back it up with nothing mounting it,
 *   so it offers neither; its archives, if any, stay readable.
 * - `observed`: only Observed containers mount it — shown, never touched.
 */
export type VolumeKind = 'owned' | 'orphan' | 'claimed' | 'observed';

export interface VolumeRow {
  volume: HostVolume;
  kind: VolumeKind;
  /** The tier the badge shows; null for an orphan. */
  tier: ContainerTier | null;
  /** The app or stack it belongs to, with its compose project. */
  owner: VolumeOwnerRef | null;
  /** How many containers the owner runs: what a quiesced backup or a restore stops. */
  ownerContainers: number;
}

/**
 * An unretired app (`GET /api/apps`, with the compose project its manifest names) or an adopted
 * stack (`GET /api/stacks`): the only things that own a volume, as the server's `volumeIndex` reads
 * them (SHP-ADR-012). A container that merely says it belongs to an app owns nothing by itself.
 */
export interface VolumeOwnerRef {
  kind: 'app' | 'stack';
  name: string;
  project: string | null;
}

/** How often Host reads the apps for volume owners: the pace it reads the snapshot. */
export const OWNER_APPS_POLL_MS = 30_000;

/**
 * The unretired apps and their compose projects (`GET /api/apps`), read on mount and every 30 s
 * while the page is visible. Null until the first answer, and while every read has failed: who owns
 * a volume is unknown then, so nothing is offered on it.
 */
export function useOwnerApps(): readonly { name: string; composeProject?: string | null }[] | null {
  const [apps, setApps] = useState<readonly { name: string; composeProject?: string | null }[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      request<{ apps: { name: string; composeProject?: string | null }[] }>('/api/apps')
        .then((res) => {
          if (live) setApps(res.apps);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') load();
    }, OWNER_APPS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return apps;
}

/** The owners from the console's own lists: apps (with their compose project) and adopted stacks. */
export function volumeOwners(apps: readonly { name: string; composeProject?: string | null }[], stacks: readonly { name: string; composeProject: string }[]): VolumeOwnerRef[] {
  return [
    ...apps.map((a): VolumeOwnerRef => ({ kind: 'app', name: a.name, project: a.composeProject ?? null })),
    ...stacks.map((st): VolumeOwnerRef => ({ kind: 'stack', name: st.name, project: st.composeProject })),
  ];
}

// The API's tier names, read from the words' keys: the retired verb is never spelled as a literal.
const TIERS = Object.keys(TIER_WORDS) as ContainerTier[];
const APP_TIER: ContainerTier = TIERS.find(isDeployedTier) ?? 'operated';

function tierOf(owner: VolumeOwnerRef): ContainerTier {
  return owner.kind === 'app' ? APP_TIER : 'operated';
}

/** The container's agent-given tier names this owner: Deployed for an app, Operated for a stack. */
function tieredTo(c: HostContainer, owner: VolumeOwnerRef): boolean {
  return c.app === owner.name && c.tier !== 'observed' && (isDeployedTier(c.tier) ? owner.kind === 'app' : owner.kind === 'stack');
}

/**
 * Every volume with whose it is, the way the server's `volumeIndex` and delete check decide it
 * (SHP-ADR-012, SHP-REQ-203): owned when a container that mounts it is in the compose project of an
 * unretired app or adopted stack — or the agent tiered that container to one of them by name. An
 * orphan whose compose label names one of their projects is claimed (a `compose down` leaves it so)
 * and is never offered Delete; a retired app owns nothing.
 */
export function volumeRows(inventory: Pick<HostInventory, 'containers' | 'volumes'>, owners: readonly VolumeOwnerRef[]): VolumeRow[] {
  const byName = new Map(inventory.containers.map((c) => [c.name, c]));
  const byProject = new Map<string, VolumeOwnerRef>();
  for (const o of owners) if (o.project !== null && !byProject.has(o.project)) byProject.set(o.project, o);
  const countFor = (owner: VolumeOwnerRef): number =>
    inventory.containers.filter((c) => (owner.project !== null && c.compose?.project === owner.project) || tieredTo(c, owner)).length;
  const row = (volume: HostVolume, kind: VolumeKind, owner: VolumeOwnerRef | null): VolumeRow => ({
    volume,
    kind,
    tier: owner === null ? (kind === 'observed' ? 'observed' : null) : tierOf(owner),
    owner,
    ownerContainers: owner === null ? 0 : countFor(owner),
  });

  return inventory.volumes.map((volume) => {
    if (volume.orphan || volume.mountedBy.length === 0) {
      const claimed = volume.composeProject === null ? undefined : byProject.get(volume.composeProject);
      return claimed === undefined ? row(volume, 'orphan', null) : row(volume, 'claimed', claimed);
    }
    for (const name of [...volume.mountedBy].sort()) {
      const c = byName.get(name);
      if (c === undefined) continue;
      const project = c.compose?.project ?? null;
      const owner = (project === null ? undefined : byProject.get(project)) ?? owners.find((o) => tieredTo(c, o));
      if (owner !== undefined) return row(volume, 'owned', owner);
    }
    return row(volume, 'observed', null);
  });
}

const KIND_RANK: Record<VolumeKind, number> = { orphan: 0, owned: 1, claimed: 1, observed: 2 };

/** Orphans first (what a clean-up looks at), then owned, then Observed; the largest first in each. */
export function sortVolumeRows(rows: readonly VolumeRow[]): VolumeRow[] {
  return [...rows].sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      (b.volume.sizeBytes ?? -1) - (a.volume.sizeBytes ?? -1) ||
      a.volume.name.localeCompare(b.volume.name),
  );
}

export interface RowActions {
  backUp: boolean;
  restore: boolean;
  remove: boolean;
}

/**
 * What a row offers this reader: Back up to a deployer and up on an owned volume; Restore… to an
 * admin on an owned volume with an archive; Delete… to an admin on a true orphan; nothing on an
 * Observed one, ever.
 */
export function rowActions(row: Pick<VolumeRow, 'kind'>, role: Role | undefined, archiveCount: number | null): RowActions {
  return {
    backUp: row.kind === 'owned' && canBackUpOrPrune(role),
    restore: row.kind === 'owned' && canRestoreOrDelete(role) && (archiveCount ?? 0) > 0,
    remove: row.kind === 'orphan' && canRestoreOrDelete(role),
  };
}

/** The typed confirmation must be the volume's name exactly: case-sensitive, nothing trimmed. */
export function confirmMatches(typed: string, volume: string): boolean {
  return typed === volume;
}

/** Six digits, as the authenticator shows them; a space typed between the halves is dropped. */
export function normaliseCode(typed: string): string {
  return typed.replace(/\s+/g, '');
}

export function isCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

// ── Words a job says ─────────────────────────────────────────────────────

const ACTIVE: readonly MaintenanceState[] = ['queued', 'dispatched', 'running'];

export function isMaintenanceActive(state: MaintenanceState): boolean {
  return ACTIVE.includes(state);
}

/** Takes a plain string because a newer server can send a state this console has not met. */
export function maintenanceStateWords(state: string): string {
  return Object.hasOwn(MAINTENANCE_STATE_WORDS, state) ? MAINTENANCE_STATE_WORDS[state as MaintenanceState] : state.replaceAll('_', ' ');
}

export function maintenanceStepWords(step: string): string {
  return Object.hasOwn(MAINTENANCE_STEP_WORDS, step) ? MAINTENANCE_STEP_WORDS[step as MaintenanceStep] : step.replaceAll('_', ' ');
}

/** The banner's headline: "Archiving · forgejo_data", "Pruning", "Sent to the agent · forgejo_data". */
export function progressHeadline(status: Pick<MaintenanceStatus, 'state' | 'step' | 'volume'>): string {
  const step = status.state === 'running' && status.step !== null ? maintenanceStepWords(status.step) : maintenanceStateWords(status.state);
  return maintenanceProgressWords(step, status.volume);
}

/** The restore's own account names the safety archive it took first; that line, verbatim, or null. */
export function safetyArchiveLine(output: string | null | undefined): string | null {
  if (output === null || output === undefined) return null;
  const line = output.split('\n').find((l) => /^Safety archive of /.test(l.trim()));
  return line === undefined ? null : line.trim();
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "Today 14:20", "Yesterday 09:05", "Oct 21 22:40": an archive's time, on the 24-hour clock. */
export function archiveTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `${TODAY} ${clock}`;
  if (days === 1) return `${YESTERDAY} ${clock}`;
  const date = `${MONTHS[at.getMonth()] ?? ''} ${String(at.getDate())}`;
  return at.getFullYear() === now.getFullYear() ? `${date} ${clock}` : `${date}, ${String(at.getFullYear())} ${clock}`;
}

/** The restore sheet's What happens chain (SHP-REQ-202): stop, empty, unpack, start, health. */
export function restoreChain(volume: string, owner: { name: string } | null, containers: number, archive: Pick<VolumeArchive, 'createdAt'> | null, now: Date = new Date()): string[] {
  return archiveChainWords(volume, owner?.name ?? volume, containers, archive === null ? null : archiveTime(archive.createdAt, now));
}

// ── Prune ────────────────────────────────────────────────────────────────

export type PruneGroupId = 'dangling' | 'unused' | 'cache';

export interface PruneGroup {
  id: PruneGroupId;
  items: PruneItem[];
  bytes: number;
}

const GROUP_OF: Record<PruneItem['reason'], PruneGroupId> = { dangling: 'dangling', unused: 'unused', 'old-cache': 'cache' };
const GROUP_ORDER: readonly PruneGroupId[] = ['dangling', 'unused', 'cache'];

/** A dry run's items as the sheet groups them, the largest first in each; empty groups left out. */
export function pruneGroups(items: readonly PruneItem[]): PruneGroup[] {
  const groups = new Map<PruneGroupId, PruneGroup>(GROUP_ORDER.map((id) => [id, { id, items: [], bytes: 0 }]));
  for (const item of items) {
    const group = groups.get(GROUP_OF[item.reason]);
    if (group === undefined) continue;
    group.items.push(item);
    group.bytes += item.sizeBytes;
  }
  for (const g of groups.values()) g.items.sort((a, b) => b.sizeBytes - a.sizeBytes || a.id.localeCompare(b.id));
  return GROUP_ORDER.map((id) => groups.get(id)).filter((g): g is PruneGroup => g !== undefined && g.items.length > 0);
}

/** `sha256:1c9e4f…07ab`: an image ID shortened; a ref or a cache record ID as it is. */
export function pruneItemName(item: Pick<PruneItem, 'id' | 'ref'>): string {
  if (item.ref !== null && item.ref !== '') return item.ref;
  const m = /^sha256:([0-9a-f]{64})$/.exec(item.id);
  const hex = m?.[1];
  return hex === undefined ? item.id : `sha256:${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/** Whole days since `iso`, or null when it is not known. */
export function daysSince(iso: string | null, now: number = Date.now()): number | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.max(0, Math.floor((now - at) / 86_400_000));
}

export function bytes(n: number | null): string {
  return formatBytes(n);
}

// ── Following a job ──────────────────────────────────────────────────────

export type MaintenancePhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'following'; status: MaintenanceStatus }
  | { kind: 'refused'; error: RefusalError }
  | { kind: 'done'; status: MaintenanceStatus };

function problemOf(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

/** True while a request is being asked or followed. */
export function isMaintenanceBusy(phase: MaintenancePhase): boolean {
  return phase.kind === 'starting' || phase.kind === 'following';
}

/**
 * Asks for a maintenance job and follows it: `run(start)` calls `start` (which may step up first),
 * then reads the job every second while it is queued, sent or running, and stops when it ends —
 * or when the component unmounts, or `reset` is called. A refusal, from the request or the step-up
 * before it, is the phase's error, verbatim.
 */
export function useMaintenanceJob(onEnded?: (status: MaintenanceStatus) => void): {
  phase: MaintenancePhase;
  run: (start: () => Promise<MaintenanceStatus>) => void;
  reset: () => void;
} {
  const [phase, setPhase] = useState<MaintenancePhase>({ kind: 'idle' });
  // `generation` only moves when a new request replaces the one being followed (or `reset`).
  // Unmounting clears `mounted` instead: StrictMode's simulated unmount and remount sets it again
  // before the request in flight answers, so that answer is followed; a real unmount stops the poll
  // at its next tick.
  const generation = useRef(0);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ended = useRef(onEnded);
  ended.current = onEnded;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const track = useCallback((gen: number, status: MaintenanceStatus): void => {
    const live = () => gen === generation.current && mounted.current;
    if (!isMaintenanceActive(status.state)) {
      setPhase({ kind: 'done', status });
      ended.current?.(status);
      return;
    }
    setPhase({ kind: 'following', status });
    const next = (failures: number): void => {
      timer.current = setTimeout(() => {
        if (!live()) return;
        maintenance
          .get(status.id)
          .then((fresh) => {
            if (live()) track(gen, fresh);
          })
          .catch((error: unknown) => {
            if (!live()) return;
            if (failures + 1 < POLL_FAILURES_ALLOWED) next(failures + 1);
            else setPhase({ kind: 'refused', error: problemOf(error) });
          });
      }, MAINTENANCE_POLL_MS);
    };
    next(0);
  }, []);

  const run = useCallback(
    (start: () => Promise<MaintenanceStatus>) => {
      stop();
      const gen = generation.current;
      const live = () => gen === generation.current && mounted.current;
      setPhase({ kind: 'starting' });
      start()
        .then((status) => {
          if (live()) track(gen, status);
        })
        .catch((error: unknown) => {
          if (live()) setPhase({ kind: 'refused', error: problemOf(error) });
        });
    },
    [stop, track],
  );

  const reset = useCallback(() => {
    stop();
    setPhase({ kind: 'idle' });
  }, [stop]);

  return { phase, run, reset };
}

/** A volume's archives, newest first; read again whenever `reloads` changes. */
export function useArchives(volume: string, enabled: boolean, reloads = 0): { archives: VolumeArchive[] | null; error: RefusalError | null } {
  const [state, setState] = useState<{ archives: VolumeArchive[] | null; error: RefusalError | null }>({ archives: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    maintenance
      .archives(volume, controller.signal)
      .then((archives) => {
        setState({ archives, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((prev) => ({ archives: prev.archives, error: problemOf(error) }));
      });
    return () => {
      controller.abort();
    };
  }, [volume, enabled, reloads]);
  return state;
}

// ── Step-up (SHP-ADR-012 amendment) ──────────────────────────────────────

export interface StepUp {
  /** What is in the code field. */
  code: string;
  setCode: (code: string) => void;
  /** The step-up's own refusal, or the request's `step_up_required`: shown by the code field. */
  error: RefusalError | null;
  /** Six digits are typed: the danger button may enable. */
  ready: boolean;
  /**
   * Wraps a restore or delete (SHP-ADR-012 amendment): steps up with the typed code first, then
   * asks. The code is spent either way, so the field empties. A refused step-up, or a request the
   * server still answers `step_up_required`, is shown by the code field and asks for a new code.
   */
  guard: (request: () => Promise<MaintenanceStatus>) => () => Promise<MaintenanceStatus>;
}

export function useStepUp(): StepUp {
  const [code, setCode] = useState('');
  const [error, setError] = useState<RefusalError | null>(null);
  const clean = normaliseCode(code);
  const ready = isCode(clean);
  const guard = useCallback(
    (req: () => Promise<MaintenanceStatus>) => async (): Promise<MaintenanceStatus> => {
      setError(null);
      setCode('');
      try {
        await maintenance.stepUp(clean);
      } catch (err) {
        const refusal = problemOf(err);
        setError(refusal);
        throw refusal;
      }
      try {
        return await req();
      } catch (err) {
        if (err instanceof RefusalError && err.code === 'step_up_required') setError(err);
        throw err;
      }
    },
    [clean],
  );
  return { code, setCode, error, ready, guard };
}
