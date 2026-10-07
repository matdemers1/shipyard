import type { DeployTargetState, RolloutAccepted, RolloutItem, RolloutPlan, RolloutStatus } from '@shipyard/schema';
import { useEffect, useRef, useState } from 'react';
import { RefusalError, request, unreachableRefusal } from './api';
import { type AppStatus, type StatusTone, stateTone } from './appstatus';
import type { HomeApp } from './home';
import { isTerminal } from './progress';

/**
 * "Deploy all ready" (SHP-T-12.2, SHP-REQ-154; the console's word since SHP-T-13.3, while the rollout
 * routes and types keep their names): every app Home calls ready, deployed one at a time — each at
 * the SHA its card would deploy, the next only once the one before has soaked. The server
 * decides the order (Shipyard's own app always last, SHP-REQ-152), so the sheet shows the order the
 * plan endpoint answers, never one worked out here.
 */

/** The fewest ready apps for which Home offers Deploy all ready; one app is just its own Deploy button. */
export const MIN_ROLL_ALL = 2;

/**
 * The apps Deploy all ready would deploy: those whose status is "ready" with a SHA to deploy, and not
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

/**
 * A rollout member's badge tone, one of the library's four (SHP-T-13.2): a member that has not
 * finished — running, or queued behind the app before it — is `attention`, so "Running" and
 * "Waiting its turn" carry a fill in light mode; a finished one is neutral, a cancelled one
 * `warning`, a failed one `danger`, as `stateTone` says for every terminal state.
 */
export function memberTone(member: { state: DeployTargetState }): StatusTone {
  if (!isTerminal(member.state)) return 'attention';
  return stateTone(member.state);
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
