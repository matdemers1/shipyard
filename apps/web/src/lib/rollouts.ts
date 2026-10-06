import type { RolloutAccepted, RolloutItem, RolloutPlan, RolloutStatus } from '@shipyard/schema';
import { useEffect, useRef, useState } from 'react';
import { RefusalError, request, unreachableRefusal } from './api';
import type { AppStatus } from './appstatus';
import type { HomeApp } from './home';
import { isTerminal } from './progress';

/**
 * "Roll all" (SHP-T-12.2, SHP-REQ-154): every app Home calls ready to ship, rolled one at a time —
 * each at the SHA its card would ship, the next only once the one before has soaked. The server
 * decides the order (Shipyard's own app always last, SHP-REQ-152), so the sheet shows the order the
 * plan endpoint answers, never one worked out here.
 */

/** The fewest ready apps for which Home offers Roll all; one app is just its own Ship button. */
export const MIN_ROLL_ALL = 2;

/**
 * The apps Roll all would ship: those whose status is "ready to ship" with a SHA to ship, and not
 * frozen (a frozen app would refuse the whole rollout). Deploying, drifted and approval-waiting apps
 * already have another status, so they are never "ready".
 */
export function rolloutCandidates(rows: readonly { app: HomeApp; status: AppStatus }[]): RolloutItem[] {
  const items: RolloutItem[] = [];
  for (const { app, status } of rows) {
    if (status.kind !== 'ready' || status.shipSha === null || app.frozen === true) continue;
    items.push({ app: app.name, sha: status.shipSha });
  }
  return items;
}

/** `POST /api/rollouts/plan` — the order the rollout would ship in, or the refusal it would get now. */
export function planRollout(items: readonly RolloutItem[]): Promise<RolloutPlan> {
  return request<RolloutPlan>('/api/rollouts/plan', { method: 'POST', body: { items } });
}

/** `POST /api/rollouts` — starts it: every app locked at once, shipped one at a time. */
export function startRollout(items: readonly RolloutItem[]): Promise<RolloutAccepted> {
  return request<RolloutAccepted>('/api/rollouts', { method: 'POST', body: { items } });
}

/** True once no member of the rollout can change any more. */
export function rolloutFinished(status: RolloutStatus): boolean {
  return status.members.every((m) => isTerminal(m.state));
}

/** How long one long poll waits for a member to move before the server answers anyway. */
export const ROLLOUT_WAIT_SECONDS = 25;

/** The least time between two polls, so a server that answers at once is never hammered. */
export const MIN_POLL_GAP_MS = 1000;

export interface RolloutProgress {
  status: RolloutStatus | null;
  error: RefusalError | null;
}

/**
 * Follows a rollout with `GET /api/rollouts/:id?wait=` long polls — each answers as soon as any
 * member moves — until every member is terminal, at most one a second. A dropped poll retries
 * after a pause.
 */
export function useRolloutProgress(id: string, retryMs = 3000): RolloutProgress {
  const [status, setStatus] = useState<RolloutStatus | null>(null);
  const [error, setError] = useState<RefusalError | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setStatus(null);
    setError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function loop(wait: number): Promise<void> {
      const startedAt = Date.now();
      try {
        const next = await request<RolloutStatus>(`/api/rollouts/${encodeURIComponent(id)}?wait=${String(wait)}`);
        if (!alive.current) return;
        setStatus(next);
        setError(null);
        if (rolloutFinished(next)) return;
        timer = setTimeout(
          () => {
            void loop(ROLLOUT_WAIT_SECONDS);
          },
          Math.max(0, MIN_POLL_GAP_MS - (Date.now() - startedAt)),
        );
      } catch (err) {
        if (!alive.current) return;
        const refusal = err instanceof RefusalError ? err : unreachableRefusal();
        // A rollout that does not exist, or that this caller may not read, will not start to.
        if (refusal.status === 404 || refusal.status === 403 || refusal.status === 400) {
          setError(refusal);
          return;
        }
        timer = setTimeout(() => {
          void loop(0);
        }, retryMs);
      }
    }

    void loop(0);
    return () => {
      alive.current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [id, retryMs]);

  return { status, error };
}
