import { Router, type Request, type Response } from 'express';
import { parseManifestYaml, refusal, type BuildState } from '@shipyard/schema';
import { RefusalError as SequenceRefusalError, type GitHubPort, type WorkflowRun } from '@shipyard/sequence/github';
import { taskIdsIn } from '../changelog.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { recordedRelease } from './drift.js';
import { liveGitHub } from '../github/token.js';
import { runRouter } from './run.js';

/**
 * GET /api/apps/:app/commits — commits waiting on the default branch ahead of the recorded
 * release, with each one's CI state and any Foreman task IDs parsed out of its message
 * (SHP-REQ-056, SHP-REQ-059, SHP-REQ-087). Read-only, same actor rules as the rest of `/api/apps`.
 */

const SHA_RE = /^[0-9a-f]{40}$/i;

const MAX_COMMITS_FOR_CI = 10;
const CACHE_TTL_MS = 60_000;

export type CiState = 'success' | 'failure' | 'pending' | 'none';

/**
 * The workflow run behind a commit's `ci` (SHP-T-13.4, SHP-ADR-007): what the Home lane and the
 * commit page need for the CI stage. It rides the run list the poll already fetches, so it adds no
 * GitHub call; the run's jobs are a separate, on-demand route (`run.ts`, SHP-REQ-168).
 */
export interface CommitRun {
  id: number;
  url: string | null;
  startedAt: string | null;
  /** Set only once the run has completed. */
  completedAt: string | null;
  /** `success`, `failure`, `cancelled`, … or null while the run is going. */
  conclusion: string | null;
}

export interface CommitEntry {
  sha: string;
  message: string;
  ci: CiState;
  /** The run `ci` came from; null when there is none, and always null for a `build: shipyard` app. */
  run: CommitRun | null;
  taskIds: string[];
  /** For a `build: shipyard` app, the latest Shipyard build of this SHA, if any (SHP-T-3.11). */
  buildId?: string;
}

export type BuildSource = 'github' | 'shipyard';

export interface CommitsResponse {
  live: string | null;
  head: string | null;
  /** The newest ten commits ahead of live, oldest first, each with its CI state. */
  commits: CommitEntry[];
  /** Every commit ahead of live, not just the ten listed — the count a person reads. */
  ahead: number;
  newestGreen: string | null;
  source: 'github' | 'unavailable';
  /**
   * Where this app's images come from: GitHub's image workflow, or Shipyard's own builds
   * (`build.source: shipyard`, SHP-REQ-134). It decides what each commit's `ci` means.
   */
  buildSource: BuildSource;
}

export interface CommitsRouterOptions {
  github?: GitHubPort;
}

export function parseWorkflow(manifestYaml: string): string | null {
  try {
    const manifest = JSON.parse(manifestYaml) as { workflow?: unknown };
    return typeof manifest.workflow === 'string' ? manifest.workflow : null;
  } catch {
    return null;
  }
}

/** The manifest's image source; anything unreadable is GitHub, the default. */
export function buildSourceOf(manifestYaml: string): BuildSource {
  try {
    return parseManifestYaml(manifestYaml).build?.source === 'shipyard' ? 'shipyard' : 'github';
  } catch {
    return 'github';
  }
}

/**
 * A Shipyard build's state as the commit's `ci` (SHP-T-3.11): only a succeeded build makes a SHA
 * deployable (G5, SHP-REQ-134); a cancelled one left nothing behind, the same as no build.
 */
export function buildStateToCi(state: BuildState): CiState {
  switch (state) {
    case 'succeeded':
      return 'success';
    case 'queued':
    case 'running':
      return 'pending';
    case 'failed':
    case 'refused':
      return 'failure';
    case 'cancelled':
      return 'none';
  }
}

/** Newest-green over an oldest-first list: the last entry whose state is `success`. */
function newestGreenOf(entries: CommitEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && entry.ci === 'success') return entry.sha;
  }
  return null;
}

function conclusionToCi(conclusion: string | null, status: string): CiState {
  if (conclusion === 'success') return 'success';
  if (conclusion !== null) return 'failure';
  // Still running (queued, in_progress, …) — not yet resolved.
  return status === 'completed' ? 'failure' : 'pending';
}

interface ResponseCacheEntry {
  expiresAt: number;
  value: Omit<CommitsResponse, 'buildSource'>;
}

interface CompareCacheEntry {
  expiresAt: number;
  value: Awaited<ReturnType<GitHubPort['compare']>>;
}

/**
 * A shared 60 s TTL cache in front of `GitHubPort#compare`, keyed on `repo`/`base`/`head`
 * (SHP-T-7.20, SHP-REQ-145). One `Map` per caller — the console's `/commits` route and
 * `shipyard_status` each hold their own, so a failure in one never poisons the other, but two
 * calls through the same map within the TTL make one `compare` call. A rejected `compare` is
 * never cached, so the next call retries it.
 */
export function makeCompareCache(): Map<string, CompareCacheEntry> {
  return new Map();
}

/** Entries kept per cache; the oldest goes first. A long-lived process never grows without bound. */
const CACHE_MAX_ENTRIES = 500;

export function setBounded<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function cachedCompare(
  cache: Map<string, CompareCacheEntry>,
  github: Pick<GitHubPort, 'compare'>,
  repo: string,
  base: string,
  head: string,
  now: number = Date.now(),
): Promise<Awaited<ReturnType<GitHubPort['compare']>>> {
  const key = `${repo}@${head}:${base}`;
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.value;
  }
  const value = await github.compare(repo, base, head);
  setBounded(cache, key, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
}

/** For a token, the apps it is scoped to; for a user, undefined (every app). */
export function scopeOf(req: Request): ReadonlySet<string> | undefined {
  return req.actor?.type === 'token' ? (req.tokenApps ?? new Set<string>()) : undefined;
}

export function readerOrRefuse(req: Request, res: Response): boolean {
  const type = req.actor?.type;
  if (type !== 'user' && type !== 'token') {
    sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
    return false;
  }
  return true;
}

export function commitsRouter(deps: ServiceDeps, options: CommitsRouterOptions = {}): Router {
  const { db } = deps;
  const github = options.github ?? liveGitHub(deps);
  const router = Router();
  // The on-demand run-jobs route sits beside the commits route it belongs to (SHP-T-13.4).
  router.use(runRouter(deps, options));
  const compareCache = makeCompareCache();
  // The whole response, per-commit CI state included: a hit makes no GitHub call at all.
  const responseCache = new Map<string, ResponseCacheEntry>();

  router.get('/:app/commits', async (req, res) => {
    if (!readerOrRefuse(req, res)) return;
    const name = req.params['app'];
    const scope = scopeOf(req);
    const notFound = refusal('not_found', `No app named ${name}.`, 'List the apps and use one of their names.');
    if (typeof name !== 'string' || (scope !== undefined && !scope.has(name))) {
      sendRefusal(res, notFound);
      return;
    }
    const row = await db.app.findUnique({ where: { name }, select: { id: true, repo: true, defaultBranch: true, manifestYaml: true } });
    if (row === null) {
      sendRefusal(res, notFound);
      return;
    }
    const buildSource = buildSourceOf(row.manifestYaml);
    if (row.repo === null || row.defaultBranch === null) {
      res.json({ live: null, head: null, commits: [], ahead: 0, newestGreen: null, source: 'unavailable', buildSource } satisfies CommitsResponse);
      return;
    }

    const toParam = req.query['to'];
    if (toParam !== undefined && (typeof toParam !== 'string' || !SHA_RE.test(toParam))) {
      sendRefusal(res, refusal('invalid_request', 'to must be a 40-hex commit SHA.'));
      return;
    }
    const to = typeof toParam === 'string' ? toParam.toLowerCase() : null;

    // A Shipyard-built app's GitHub workflow runs prove nothing about its images: skip asking.
    const workflow = buildSource === 'shipyard' ? null : parseWorkflow(row.manifestYaml);

    const release = await recordedRelease(db, row.id);
    const live = release?.sha ?? null;

    try {
      const value = await computeCommits(github, compareCache, responseCache, row.repo, row.defaultBranch, workflow, live, to);
      if (buildSource === 'github') {
        res.json({ ...value, buildSource } satisfies CommitsResponse);
        return;
      }
      // Builds change by the second and cost one query, so they are read fresh, never cached.
      const builds =
        value.commits.length === 0
          ? []
          : await db.build.findMany({
              where: { appId: row.id, sha: { in: value.commits.map((c) => c.sha) } },
              orderBy: { createdAt: 'desc' },
              select: { id: true, sha: true, state: true },
            });
      const latest = new Map<string, { id: string; state: BuildState }>();
      for (const b of builds) if (!latest.has(b.sha)) latest.set(b.sha, { id: b.id, state: b.state });
      const commits = value.commits.map((c): CommitEntry => {
        const build = latest.get(c.sha);
        return build === undefined ? { ...c, ci: 'none' } : { ...c, ci: buildStateToCi(build.state), buildId: build.id };
      });
      res.json({ ...value, commits, newestGreen: newestGreenOf(commits), buildSource } satisfies CommitsResponse);
    } catch (error) {
      if (error instanceof SequenceRefusalError) {
        res.json({ live, head: null, commits: [], ahead: 0, newestGreen: null, source: 'unavailable', buildSource } satisfies CommitsResponse);
        return;
      }
      throw error;
    }
  });

  return router;
}

async function computeCommits(
  github: GitHubPort,
  compareCache: Map<string, CompareCacheEntry>,
  responseCache: Map<string, ResponseCacheEntry>,
  repo: string,
  defaultBranch: string,
  workflow: string | null,
  live: string | null,
  to: string | null,
): Promise<Omit<CommitsResponse, 'buildSource'>> {
  // `to` (SHP-REQ-087) is the candidate SHA the console already knows; the range narrows from the
  // default branch's HEAD to exactly that commit rather than the always-moving branch tip. The
  // comparison itself names the head, so `cachedCompare`'s key is repo/base/head — a changed head
  // naturally falls out of a fresh `compare` call each time the cache expires.
  const target = to ?? defaultBranch;
  const now = Date.now();
  const responseKey = `${repo}@${target}:${live ?? 'none'}`;
  const cachedResponse = responseCache.get(responseKey);
  if (cachedResponse !== undefined && cachedResponse.expiresAt > now) {
    return cachedResponse.value;
  }

  const comparison = live === null ? null : await cachedCompare(compareCache, github, repo, live, target);
  let commits: { sha: string; message: string }[];
  let head: string | null;
  let ahead = 0;

  if (live !== null && comparison !== null) {
    commits = comparison.commits;
    // GitHub lists at most 250 commits in a comparison; `aheadBy` is the exact count.
    ahead = Math.max(comparison.aheadBy, commits.length);
    head = commits.length > 0 ? (commits[commits.length - 1]?.sha ?? live) : live;
  } else if (to !== null) {
    // No recorded release, or GitHub does not know the recorded SHA any more, but the caller
    // named an exact candidate: that candidate is the head with no commit list to show.
    head = to;
    commits = [];
  } else {
    // No recorded release, or GitHub does not know the recorded SHA any more: fall back to the
    // last 10 commits on the default branch against itself (self-compare), i.e. just the head.
    const selfCompare = await cachedCompare(compareCache, github, repo, defaultBranch, defaultBranch);
    head = selfCompare?.commits[selfCompare.commits.length - 1]?.sha ?? null;
    commits = [];
  }

  const toCheck = commits.slice(-MAX_COMMITS_FOR_CI);
  const entries: CommitEntry[] = await Promise.all(
    toCheck.map(async (c) => {
      const { ci, run } = workflow === null ? { ci: 'none' as const, run: null } : await ciStateFor(github, repo, workflow, c.sha, defaultBranch);
      return { sha: c.sha, message: c.message, ci, run, taskIds: taskIdsIn(c.message) };
    }),
  );

  // `entries` is oldest-first (the port's contract for `compare`); the newest green commit is
  // the last one in that order with a successful run.
  const newestGreen = newestGreenOf(entries);

  const value: Omit<CommitsResponse, 'buildSource'> = { live, head, commits: entries, ahead, newestGreen, source: 'github' };
  setBounded(responseCache, responseKey, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
}

/**
 * The run that decides a commit's CI: the newest push to the default branch for this SHA. Only
 * such a run publishes images, so only it makes a commit deployable — the same rule as the agent's
 * G5; a pull-request-only commit has none. Shared with the run route so both agree on which run a
 * commit means.
 */
export async function pushRunFor(github: Pick<GitHubPort, 'workflowRuns'>, repo: string, workflow: string, sha: string, branch: string): Promise<WorkflowRun | null> {
  const runs = (await github.workflowRuns(repo, workflow, sha)).filter((run) => run.event === 'push' && run.headBranch === branch);
  // Newest first per the port's contract; the first run for this SHA is the one that matters.
  return runs[0] ?? null;
}

async function ciStateFor(github: GitHubPort, repo: string, workflow: string, sha: string, branch: string): Promise<{ ci: CiState; run: CommitRun | null }> {
  const run = await pushRunFor(github, repo, workflow, sha, branch);
  if (run === null) return { ci: 'none', run: null };
  return {
    ci: conclusionToCi(run.conclusion, run.status),
    run: { id: run.id, url: run.url ?? null, startedAt: run.startedAt ?? null, completedAt: run.completedAt ?? null, conclusion: run.conclusion },
  };
}
