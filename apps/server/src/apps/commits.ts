import { Router, type Request, type Response } from 'express';
import { refusal } from '@shipyard/schema';
import { createGitHubAdapter, RefusalError as SequenceRefusalError, type GitHubPort } from '@shipyard/sequence/github';
import { taskIdsIn } from '../changelog.js';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { recordedRelease } from './drift.js';

/**
 * GET /api/apps/:app/commits — commits waiting on the default branch ahead of the recorded
 * release, with each one's CI state and any Foreman task IDs parsed out of its message
 * (SHP-REQ-056, SHP-REQ-059, SHP-REQ-087). Read-only, same actor rules as the rest of `/api/apps`.
 */

const SHA_RE = /^[0-9a-f]{40}$/i;

const MAX_COMMITS_FOR_CI = 10;
const CACHE_TTL_MS = 60_000;

export type CiState = 'success' | 'failure' | 'pending' | 'none';

export interface CommitEntry {
  sha: string;
  message: string;
  ci: CiState;
  taskIds: string[];
}

export interface CommitsResponse {
  live: string | null;
  head: string | null;
  commits: CommitEntry[];
  newestGreen: string | null;
  source: 'github' | 'unavailable';
}

export interface CommitsRouterOptions {
  github?: GitHubPort;
}

function parseWorkflow(manifestYaml: string): string | null {
  try {
    const manifest = JSON.parse(manifestYaml) as { workflow?: unknown };
    return typeof manifest.workflow === 'string' ? manifest.workflow : null;
  } catch {
    return null;
  }
}

function conclusionToCi(conclusion: string | null, status: string): CiState {
  if (conclusion === 'success') return 'success';
  if (conclusion !== null) return 'failure';
  // Still running (queued, in_progress, …) — not yet resolved.
  return status === 'completed' ? 'failure' : 'pending';
}

interface ResponseCacheEntry {
  expiresAt: number;
  value: CommitsResponse;
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

function setBounded<V>(cache: Map<string, V>, key: string, value: V): void {
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
function scopeOf(req: Request): ReadonlySet<string> | undefined {
  return req.actor?.type === 'token' ? (req.tokenApps ?? new Set<string>()) : undefined;
}

function readerOrRefuse(req: Request, res: Response): boolean {
  const type = req.actor?.type;
  if (type !== 'user' && type !== 'token') {
    sendRefusal(res, refusal('unauthenticated', 'You are not signed in.'));
    return false;
  }
  return true;
}

export function commitsRouter(deps: ServiceDeps, options: CommitsRouterOptions = {}): Router {
  const { db, config } = deps;
  const github = options.github ?? createGitHubAdapter(config.GITHUB_TOKEN_SERVER === undefined ? {} : { token: config.GITHUB_TOKEN_SERVER });
  const router = Router();
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
    if (row.repo === null || row.defaultBranch === null) {
      res.json({ live: null, head: null, commits: [], newestGreen: null, source: 'unavailable' } satisfies CommitsResponse);
      return;
    }

    const toParam = req.query['to'];
    if (toParam !== undefined && (typeof toParam !== 'string' || !SHA_RE.test(toParam))) {
      sendRefusal(res, refusal('invalid_request', 'to must be a 40-hex commit SHA.'));
      return;
    }
    const to = typeof toParam === 'string' ? toParam.toLowerCase() : null;

    const workflow = parseWorkflow(row.manifestYaml);

    const release = await recordedRelease(db, row.id);
    const live = release?.sha ?? null;

    try {
      const value = await computeCommits(github, compareCache, responseCache, row.repo, row.defaultBranch, workflow, live, to);
      res.json(value);
    } catch (error) {
      if (error instanceof SequenceRefusalError) {
        res.json({ live, head: null, commits: [], newestGreen: null, source: 'unavailable' } satisfies CommitsResponse);
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
): Promise<CommitsResponse> {
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

  if (live !== null && comparison !== null) {
    commits = comparison.commits;
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
      const ci = workflow === null ? 'none' : await ciStateFor(github, repo, workflow, c.sha, defaultBranch);
      return { sha: c.sha, message: c.message, ci, taskIds: taskIdsIn(c.message) };
    }),
  );

  // `entries` is oldest-first (the port's contract for `compare`); the newest green commit is
  // the last one in that order with a successful run.
  let newestGreen: string | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry !== undefined && entry.ci === 'success') {
      newestGreen = entry.sha;
      break;
    }
  }

  const value: CommitsResponse = { live, head, commits: entries, newestGreen, source: 'github' };
  setBounded(responseCache, responseKey, { expiresAt: now + CACHE_TTL_MS, value });
  return value;
}

async function ciStateFor(github: GitHubPort, repo: string, workflow: string, sha: string, branch: string): Promise<CiState> {
  // Only a push to the default branch publishes images, so only such a run makes a commit
  // deployable — the same rule as the agent's G5. A pull-request-only commit shows as 'none'.
  const runs = (await github.workflowRuns(repo, workflow, sha)).filter((run) => run.event === 'push' && run.headBranch === branch);
  if (runs.length === 0) return 'none';
  // Newest first per the port's contract; the first run for this SHA is the one that matters.
  const run = runs[0];
  if (run === undefined) return 'none';
  return conclusionToCi(run.conclusion, run.status);
}
