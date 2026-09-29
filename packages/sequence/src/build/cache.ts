import type { BuildSettings } from '@shipyard/schema';

/**
 * BuildKit container limits and cache garbage collection (SHP-T-7.11; SHP-REQ-131, SHP-REQ-132,
 * SHP-REQ-133). Pure decision logic only — the agent's `cache.ts` is the one thing that talks to
 * Docker and BuildKit; this module just says what to send them and when.
 */

/** The dockerode `HostConfig` fields that pin a container's CPU and memory. */
export interface BuildKitHostConfigLimits {
  /** CPU quota in nano-CPUs (`cpus * 1e9`). */
  NanoCpus: number;
  /** Memory limit in bytes. */
  Memory: number;
  /**
   * Memory + swap, in bytes. Set equal to `Memory` so the container gets no additional swap
   * beyond its memory limit — the common way to disable swap through the Engine API.
   */
  MemorySwap: number;
}

/** `BuildSettings.cpus`/`memoryMb` as the dockerode `container.update()` HostConfig (SHP-REQ-131). */
export function toHostConfigLimits(settings: Pick<BuildSettings, 'cpus' | 'memoryMb'>): BuildKitHostConfigLimits {
  const memory = Math.round(settings.memoryMb * 1024 * 1024);
  return {
    NanoCpus: Math.round(settings.cpus * 1e9),
    Memory: memory,
    MemorySwap: memory,
  };
}

/** `BuildSettings.cacheCapGb` as bytes: what `BuildKitPort.prune` is called with (SHP-REQ-132). */
export function capBytes(cacheCapGb: number): number {
  return Math.round(cacheCapGb * 1024 ** 3);
}

/** True when the CPU/memory pair actually changed — an unchanged pair means no `container.update()` call. */
export function limitsChanged(
  applied: { cpus: number; memoryMb: number } | null,
  next: Pick<BuildSettings, 'cpus' | 'memoryMb'>,
): boolean {
  return applied === null || applied.cpus !== next.cpus || applied.memoryMb !== next.memoryMb;
}

/** How often garbage collection runs on its own, absent a build ending (SHP-REQ-132): once a day. */
export const DEFAULT_GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** True once `intervalMs` has passed since `lastGcAt` — or GC has never run at all. */
export function dueForGc(lastGcAt: Date | null, now: Date, intervalMs: number = DEFAULT_GC_INTERVAL_MS): boolean {
  return lastGcAt === null || now.getTime() - lastGcAt.getTime() >= intervalMs;
}
