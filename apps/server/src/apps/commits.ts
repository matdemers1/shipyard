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

interface CacheEntry {
  key: string;
  expiresAt: number;
  value: CommitsResponse;
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
  const cache = new Map<string, CacheEntry>();

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
      const value = await computeCommits(github, cache, row.repo, row.defaultBranch, workflow, live, to);
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
  cache: Map<string, CacheEntry>,
  repo: string,
  defaultBranch: string,
  workflow: string | null,
  live: string | null,
  to: string | null,
): Promise<CommitsResponse> {
  // `to` (SHP-REQ-087) is the candidate SHA the console already knows; the range narrows from the
  // default branch's HEAD to exactly that commit rather than the always-moving branch tip. The
  // comparison itself names the head, so the cache key is keyed on live + repo/branch/to; a
  // changed head naturally falls out of a fresh `compare` call each time the cache expires.
  const target = to ?? defaultBranch;
  const now = Date.now();
  const cacheKey = `${repo}@${target}:${live ?? 'none'}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > now && cached.value.source === 'github') {
    return cached.value;
  }

  const comparison = live === null ? null : await github.compare(repo, live, target);
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
    const selfCompare = await github.compare(repo, defaultBranch, defaultBranch);
    head = selfCompare?.commits[selfCompare.commits.length - 1]?.sha ?? null;
    commits = [];
  }

  const toCheck = commits.slice(-MAX_COMMITS_FOR_CI);
  const entries: CommitEntry[] = await Promise.all(
    toCheck.map(async (c) => {
      const ci = workflow === null ? 'none' : await ciStateFor(github, repo, workflow, c.sha);
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
  cache.set(cacheKey, { key: cacheKey, expiresAt: now + CACHE_TTL_MS, value });
  return value;
}

async function ciStateFor(github: GitHubPort, repo: string, workflow: string, sha: string): Promise<CiState> {
  const runs = await github.workflowRuns(repo, workflow, sha);
  if (runs.length === 0) return 'none';
  // Newest first per the port's contract; the first run for this SHA is the one that matters.
  const run = runs[0];
  if (run === undefined) return 'none';
  return conclusionToCi(run.conclusion, run.status);
}
