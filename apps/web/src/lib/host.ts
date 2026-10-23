// Types only: a runtime import of the schema package would put zod and every schema in the bundle.
import type { StatusDotTone } from '@d3cloud/ui';
import type { ContainerStats, ContainerTier, HostContainer, HostImage, HostInventory, HostResponse, HostSample, HostVolume } from '@shipyard/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefusalError, request, unreachableRefusal } from './api';
import { formatBytes } from './restore';
import { CONTAINER_STATE_WORDS, HEALTH_WORDS } from './words';

/**
 * The Host destination's data and model (SHP-T-14.7, SHP-REQ-178, SHP-ADR-009): the latest host
 * snapshot every agent reported — containers grouped by compose project and tier, volumes, images
 * and disk. Read-only (SHP-REQ-181): the one call here is `GET /api/host`, and nothing in this file
 * or the screen asks the server or the host to change anything.
 *
 * Everything below the hook is pure, so the grouping, the chips, the words and the sparkline are
 * unit-tested without rendering; the clock is a parameter wherever a test needs to pin it.
 */

export const host = {
  snapshot: (): Promise<HostResponse> => request<HostResponse>('/api/host'),
};

/** How often Host reads while it is open and visible, the same pace as Apps (SHP-T-13.8). */
export const HOST_POLL_MS = 30_000;

/** The agent's report interval (SHP-ADR-009): the snapshot is as fresh as the last report. */
export const REPORT_INTERVAL_MS = 60_000;

/** A snapshot older than two report intervals is stale: the agent may be down. */
export const STALE_AFTER_MS = 2 * REPORT_INTERVAL_MS;

// ── Data ─────────────────────────────────────────────────────────────────

export interface HostData {
  status: 'loading' | 'ready' | 'error';
  hosts: HostResponse['hosts'];
  error: RefusalError | null;
  /** When the screen last looked at the clock: each read, so a stale snapshot is noticed. */
  now: number;
}

/**
 * Reads `/api/host` on mount, then every 30 s while the page is visible; stops while it is hidden
 * and reads again the moment it is shown. A failed read after a good one keeps the last snapshot
 * on screen — its age (and the stale line) says how old it is — rather than blanking the page.
 */
export function useHost(): HostData {
  const [data, setData] = useState<HostData>({ status: 'loading', hosts: [], error: null, now: Date.now() });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const res = await host.snapshot();
      if (gen !== generation.current) return;
      setData({ status: 'ready', hosts: res.hosts, error: null, now: Date.now() });
    } catch (err) {
      if (gen !== generation.current) return;
      const error = err instanceof RefusalError ? err : unreachableRefusal();
      setData((prev) => (prev.status === 'ready' ? { ...prev, now: Date.now() } : { status: 'error', hosts: [], error, now: Date.now() }));
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const start = () => {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void load();
      }, HOST_POLL_MS);
    };
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (visible()) {
        void load();
        start();
      } else stop();
    };
    void load();
    if (visible()) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      // A read still in flight lands on an unmounted screen otherwise.
      generation.current += 1;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  return data;
}

// ── Freshness ────────────────────────────────────────────────────────────

/** "40 s", "3 min", "2 h", "4 d": how long ago, without the "ago". */
export function ageWords(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h`;
  return `${String(Math.floor(hours / 24))} d`;
}

/** True when the snapshot is older than two report intervals (or its time cannot be read). */
export function isStale(reportedAt: string, now: number): boolean {
  const then = Date.parse(reportedAt);
  return Number.isNaN(then) || now - then > STALE_AFTER_MS;
}

// ── Bytes ────────────────────────────────────────────────────────────────

/** The console's one byte formatter (restore.ts), with a dash for a size nobody knows. */
export function bytesWords(bytes: number | null): string {
  return bytes === null ? '—' : formatBytes(bytes);
}

// ── Tiers, states and chips ──────────────────────────────────────────────

/** Deployed groups first, then Operated, then Observed (SHP-REQ-178). */
const TIER_RANK: Record<ContainerTier, number> = { shipped: 0, operated: 1, observed: 2 };

/** True for the tier of a D3 app Shipyard deploys, the one a group links to its app page for. */
export function isDeployedTier(tier: ContainerTier): boolean {
  return TIER_RANK[tier] === 0;
}

/** The filter chips, in order. The choice lives in the address, like Activity's (SHP-T-13.13). */
export type HostChip = 'all' | 'deployed' | 'operated' | 'observed' | 'not-running';

const TIER_CHIP: Record<ContainerTier, HostChip> = { shipped: 'deployed', operated: 'operated', observed: 'observed' };

export const HOST_CHIPS: readonly { id: HostChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'deployed', label: 'Deployed' },
  { id: 'operated', label: 'Operated' },
  { id: 'observed', label: 'Observed' },
  { id: 'not-running', label: 'Not running' },
];

/** `?tier=deployed|operated|observed` or `?state=not-running`; anything else is All. */
export function chipFromParams(params: URLSearchParams): HostChip {
  if (params.get('state') === 'not-running') return 'not-running';
  const tier = params.get('tier');
  return tier === 'deployed' || tier === 'operated' || tier === 'observed' ? tier : 'all';
}

/** The address for a chip, keeping every other query parameter. */
export function paramsForChip(chip: HostChip, params: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete('tier');
  next.delete('state');
  if (chip === 'not-running') next.set('state', 'not-running');
  else if (chip !== 'all') next.set('tier', chip);
  return next;
}

export function isRunning(c: HostContainer): boolean {
  return c.state === 'running';
}

/** Not running, or running and failing its own healthcheck: its group opens by default. */
export function isTroubled(c: HostContainer): boolean {
  return !isRunning(c) || c.health === 'unhealthy';
}

export function matchesChip(c: HostContainer, chip: HostChip): boolean {
  if (chip === 'all') return true;
  if (chip === 'not-running') return !isRunning(c);
  return TIER_CHIP[c.tier] === chip;
}

export function chipCounts(containers: readonly HostContainer[]): Record<HostChip, number> {
  const counts: Record<HostChip, number> = { all: 0, deployed: 0, operated: 0, observed: 0, 'not-running': 0 };
  for (const c of containers) {
    for (const chip of HOST_CHIPS) if (matchesChip(c, chip.id)) counts[chip.id] += 1;
  }
  return counts;
}

// ── Groups ───────────────────────────────────────────────────────────────

export interface ContainerGroup {
  key: string;
  /** The compose project; null for the containers compose did not create. */
  project: string | null;
  /** The group's tier: the most trusted any of its containers has. */
  tier: ContainerTier;
  /** The Shipyard app (Deployed) or stack (Operated) it belongs to, when one is named. */
  app: string | null;
  containers: HostContainer[];
  /** Some container in it is not running, or is unhealthy. */
  troubled: boolean;
}

export const NO_COMPOSE_KEY = 'no-compose';

/**
 * Containers grouped by compose project: Deployed groups first, then Operated, then Observed, each
 * alphabetical; the containers compose did not create last, in one group. Containers sort by name
 * inside a group, so a refresh never reorders a row.
 */
export function groupContainers(containers: readonly HostContainer[]): ContainerGroup[] {
  const byKey = new Map<string, ContainerGroup>();
  for (const c of containers) {
    const project = c.compose?.project ?? null;
    const key = project === null ? NO_COMPOSE_KEY : `compose:${project}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = { key, project, tier: c.tier, app: null, containers: [], troubled: false };
      byKey.set(key, group);
    }
    group.containers.push(c);
    if (TIER_RANK[c.tier] < TIER_RANK[group.tier]) group.tier = c.tier;
    if (group.app === null && c.app !== null) group.app = c.app;
    if (isTroubled(c)) group.troubled = true;
  }
  const groups = [...byKey.values()];
  for (const g of groups) g.containers.sort((a, b) => a.name.localeCompare(b.name));
  return groups.sort((a, b) => {
    if (a.project === null) return 1;
    if (b.project === null) return -1;
    return TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.project.localeCompare(b.project);
  });
}

/** The groups open at first: every troubled one; when all are well, the first. */
export function defaultOpen(groups: readonly ContainerGroup[]): Set<string> {
  const troubled = groups.filter((g) => g.troubled).map((g) => g.key);
  if (troubled.length > 0) return new Set(troubled);
  const first = groups[0];
  return new Set(first === undefined ? [] : [first.key]);
}

// ── A container's words ──────────────────────────────────────────────────

export interface ContainerStatus {
  /** The desktop row: "Running · healthy", "Exited". */
  words: string;
  /** The phone row, where it sits beside the name: "Healthy", "Running", "Exited". */
  short: string;
  tone: StatusDotTone;
}

function capital(word: string): string {
  return word === '' ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

export function containerStatus(c: HostContainer): ContainerStatus {
  if (c.state === 'running') {
    const health = HEALTH_WORDS[c.health];
    const words = health === '' ? CONTAINER_STATE_WORDS.running : `${CONTAINER_STATE_WORDS.running} · ${health}`;
    const short = health === '' ? CONTAINER_STATE_WORDS.running : capital(health);
    const tone: StatusDotTone = c.health === 'unhealthy' ? 'danger' : 'neutral';
    return { words, short, tone };
  }
  const words = CONTAINER_STATE_WORDS[c.state];
  const tone: StatusDotTone = c.state === 'restarting' ? 'warning' : 'idle';
  return { words, short: words, tone };
}

export function restartWords(count: number): string {
  return `${String(count)} ${count === 1 ? 'restart' : 'restarts'}`;
}

export function cpuWords(stats: ContainerStats | null): string {
  return stats === null ? '—' : `${stats.cpuPercent.toFixed(1)}%`;
}

/** "312.0 MB", or "1.1 GB / 2.0 GB" when the container has a memory limit. */
export function memoryWords(stats: ContainerStats | null): string {
  if (stats === null) return '—';
  const used = formatBytes(stats.memoryBytes);
  return stats.memoryLimitBytes === null ? used : `${used} / ${formatBytes(stats.memoryLimitBytes)}`;
}

/** The phone row's second line: use when running, otherwise what it runs. */
export function phoneLine(c: HostContainer): string {
  if (isRunning(c) && c.stats !== null) {
    return `${cpuWords(c.stats)} CPU · ${memoryWords(c.stats)} · ${restartWords(c.restartCount)}`;
  }
  return `${restartWords(c.restartCount)} · ${c.image}`;
}

// ── Sparkline ────────────────────────────────────────────────────────────

/**
 * An SVG polyline's points for a CPU history, oldest to newest across `width`, scaled so the
 * busiest sample touches the top; a flat line along the bottom when every sample is 0. Null with
 * fewer than two samples: one point is not a line.
 */
export function sparkPoints(samples: readonly HostSample[] | undefined, width: number, height: number): string | null {
  if (samples === undefined || samples.length < 2) return null;
  const max = Math.max(...samples.map((s) => s.cpuPercent));
  const step = width / (samples.length - 1);
  const pad = 1;
  const usable = height - 2 * pad;
  return samples
    .map((s, i) => {
      const x = i * step;
      const y = max === 0 ? height - pad : pad + usable * (1 - s.cpuPercent / max);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

// ── Volumes ──────────────────────────────────────────────────────────────

/** How many volumes show before "Show all". */
export const VOLUMES_SHOWN = 6;

/** Orphans first (what a clean-up would look at), then the largest; an unknown size last. */
export function sortVolumes(volumes: readonly HostVolume[]): HostVolume[] {
  return [...volumes].sort(
    (a, b) =>
      Number(b.orphan) - Number(a.orphan) ||
      (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) ||
      a.name.localeCompare(b.name),
  );
}

// ── Images ───────────────────────────────────────────────────────────────

/** `ghcr.io/x/y:tag` → `ghcr.io/x/y`; a registry's port is not a tag. */
export function repositoryOf(tag: string): string {
  const colon = tag.lastIndexOf(':');
  return colon > tag.lastIndexOf('/') ? tag.slice(0, colon) : tag;
}

export interface RepositorySize {
  repository: string;
  bytes: number;
  versions: number;
}

export interface ImageSummary {
  count: number;
  bytes: number;
  unusedCount: number;
  unusedBytes: number;
  dangling: number;
  /** The three repositories taking the most space. */
  largest: RepositorySize[];
}

export function imageSummary(images: readonly HostImage[]): ImageSummary {
  const repos = new Map<string, RepositorySize>();
  let bytes = 0;
  let unusedCount = 0;
  let unusedBytes = 0;
  let dangling = 0;
  for (const image of images) {
    bytes += image.sizeBytes;
    if (image.containers === 0) {
      unusedCount += 1;
      unusedBytes += image.sizeBytes;
    }
    if (image.dangling) dangling += 1;
    const tag = image.repoTags[0];
    if (tag === undefined) continue;
    const repository = repositoryOf(tag);
    const entry = repos.get(repository) ?? { repository, bytes: 0, versions: 0 };
    entry.bytes += image.sizeBytes;
    entry.versions += 1;
    repos.set(repository, entry);
  }
  const largest = [...repos.values()].sort((a, b) => b.bytes - a.bytes || a.repository.localeCompare(b.repository)).slice(0, 3);
  return { count: images.length, bytes, unusedCount, unusedBytes, dangling, largest };
}

// ── The summary tiles ────────────────────────────────────────────────────

export interface HostTotals {
  containers: { total: number; running: number; notRunning: number };
  volumes: { count: number; bytes: number; orphaned: number };
  images: ImageSummary;
}

export function hostTotals(inventory: HostInventory): HostTotals {
  const running = inventory.containers.filter(isRunning).length;
  return {
    containers: { total: inventory.containers.length, running, notRunning: inventory.containers.length - running },
    volumes: {
      count: inventory.volumes.length,
      bytes: inventory.volumes.reduce((sum, v) => sum + (v.sizeBytes ?? 0), 0),
      orphaned: inventory.volumes.filter((v) => v.orphan).length,
    },
    images: imageSummary(inventory.images),
  };
}
