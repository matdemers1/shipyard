import type { DeployStatus } from '@shipyard/schema';
import { useEffect, useState } from 'react';
import { request } from './api';
import { appDetail, type HistoryTarget } from './appdetail';
import type { DeployStep } from './progress';
import { fetchForemanStatus, type ForemanStatus } from './timeline';

/**
 * The deploy page's reads beyond the stream (SHP-T-13.11, SHP-REQ-162): the app's manifest soak,
 * default branch and recent history, the deploy's Foreman posts, and the CI run behind its SHA —
 * plus the approver's two acts. The stream itself is `useDeployProgress` (progress.ts); everything
 * here is read once, or once more when the deploy ends, never on a timer.
 */

/** What the page needs from `GET /api/apps/:app`; a deploy status does not carry the soak. */
export interface DeployAppContext {
  soakSeconds: number | null;
  defaultBranch: string | null;
  liveSha: string | null;
  /** The app's last twenty targets, newest first: where "what was live before" comes from. */
  targets: HistoryTarget[];
  /** The Foreman project the manifest records releases against, e.g. `FRM`; null with no mapping. */
  foremanProject: string | null;
}

/** The manifest's `foreman.project`, read defensively: the server sends the parsed manifest, or its text. */
export function foremanProjectOf(manifest: unknown): string | null {
  let value: unknown = manifest;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const foreman = (value as { foreman?: unknown }).foreman;
  if (typeof foreman !== 'object' || foreman === null) return null;
  const project = (foreman as { project?: unknown }).project;
  return typeof project === 'string' && project !== '' ? project : null;
}

/**
 * The app's context, read once per app. A failure is not the page's failure: the page still shows
 * the deploy, only without the soak length, the branch name or what was live before.
 */
export function useDeployAppContext(app: string | null): DeployAppContext | null {
  const [context, setContext] = useState<DeployAppContext | null>(null);
  useEffect(() => {
    setContext(null);
    if (app === null) return undefined;
    const abort = new AbortController();
    appDetail
      .get(app, abort.signal)
      .then((detail) => {
        setContext({
          soakSeconds: detail.soakSeconds,
          defaultBranch: detail.defaultBranch,
          liveSha: detail.liveSha,
          targets: detail.targets,
          foremanProject: foremanProjectOf(detail.manifest),
        });
      })
      .catch(() => undefined);
    return () => {
      abort.abort();
    };
  }, [app]);
  return context;
}

/**
 * The deploy's Foreman posts: read once the deploy is known, and once more when it ends, which is
 * when a release posts. A deploy opened after it finished is read once.
 */
export function useForemanPosts(id: string, ready: boolean, done: boolean): ForemanStatus | null {
  const [posts, setPosts] = useState<ForemanStatus | null>(null);
  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    fetchForemanStatus(id)
      .then((f) => {
        if (!cancelled) setPosts(f);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, ready, done]);
  return posts;
}

interface RunReply {
  run: { url: string | null } | null;
}

/**
 * The GitHub Actions run behind the deployed SHA, for "Open CI run". One read when the page opens
 * (SHP-REQ-168: nothing on a timer asks GitHub); no run, or no answer, simply leaves the link out.
 */
export function useCiRunUrl(app: string | null, sha: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (app === null || sha === null) return undefined;
    const abort = new AbortController();
    request<RunReply>(`/api/apps/${encodeURIComponent(app)}/commits/${encodeURIComponent(sha)}/run`, { signal: abort.signal })
      .then((reply) => {
        setUrl(reply.run?.url ?? null);
      })
      .catch(() => undefined);
    return () => {
      abort.abort();
    };
  }, [app, sha]);
  return url;
}

/** Approve or deny a held deploy: console users with a state-changing role only (SHP-D-072). */
export function decideApproval(deployId: string, action: 'approve' | 'deny'): Promise<unknown> {
  return request(`/api/deploys/${encodeURIComponent(deployId)}/${action}`, { method: 'POST' });
}

// ── Pure helpers ─────────────────────────────────────────────────────────

export interface SoakClock {
  /** Whole seconds soaked so far, never more than the soak. */
  elapsed: number;
  total: number;
  left: number;
}

/**
 * How far into its soak a deploy is, from the recorded soak step's start and the manifest's soak —
 * so a reload reads the same numbers, not a client timer that starts again at zero. Null before the
 * soak step is recorded or when the soak length is unknown.
 */
export function soakClock(steps: readonly DeployStep[], soakSeconds: number | null, now: number): SoakClock | null {
  if (soakSeconds === null) return null;
  const soak = steps.find((s) => s.name.toLowerCase() === 'soak');
  if (soak === undefined) return null;
  const start = Date.parse(soak.startedAt);
  const end = soak.endedAt === null ? now : Date.parse(soak.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const elapsed = Math.min(soakSeconds, Math.max(0, Math.floor((end - start) / 1000)));
  return { elapsed, total: soakSeconds, left: soakSeconds - elapsed };
}

/**
 * The SHA that was live when this deploy began: the newest real release of the app before it. With
 * no such release in the recent history, the app's live SHA stands in while the deploy is still
 * running (it has not replaced it yet); otherwise it is unknown.
 */
export function liveBefore(status: DeployStatus, targets: readonly HistoryTarget[], liveSha: string | null, running: boolean): string | null {
  const created = Date.parse(status.createdAt);
  const prior = targets.find(
    (t) => t.deployId !== status.deployId && t.state === 'succeeded' && !t.dryRun && Date.parse(t.createdAt) < created,
  );
  if (prior !== undefined) return prior.sha;
  return running && liveSha !== status.sha ? liveSha : null;
}

/** A migrate step ran and finished, so the database is not what it was before this deploy. */
export function migrated(steps: readonly DeployStep[]): boolean {
  return steps.some((s) => s.name.toLowerCase() === 'migrate' && s.endedAt !== null && s.exitCode === 0);
}

/** A finished step's one-line result: the last non-empty line of its output. */
export function lastLine(output: string | null): string | null {
  if (output === null) return null;
  const lines = output.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.at(-1) ?? null;
}

const CLOCK = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DATE_CLOCK = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "12:14 PM". */
export function clockTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : CLOCK.format(at);
}

/** "Oct 3, 2:38 PM". */
export function dateTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : DATE_CLOCK.format(at);
}
