import { refusal } from '@shipyard/schema';
import { RefusalError } from '../ports.js';
import type { Comparison, CompareStatus, GitHubPort, WorkflowRun } from '../ports.js';

/**
 * The `GitHubPort` adapter (SHP-T-1.2, SHP-REQ-008/009/010/029). Talks to `api.github.com` (or a
 * compatible base URL, for tests and GitHub Enterprise) over the global `fetch`. Every failure
 * mode — network error, timeout, 5xx, 429, a rate-limited 403, a malformed body — becomes a
 * `RefusalError(github_unreachable)` naming GitHub, so the forward gates fail closed (SHP-D-086)
 * with no override.
 */

export interface GitHubAdapterOptions {
  /** A fine-grained read-only PAT. Omit for public repos. */
  token?: string;
  /** Default `https://api.github.com`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Default 10000. */
  timeoutMs?: number;
  userAgent?: string;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'shipyard-agent';
const TOKEN_EXPIRY_HEADER = 'github-authentication-token-expiration';
/** Cap on `workflowRuns` pagination: never follow more than this many `Link: rel="next"` pages. */
const MAX_WORKFLOW_RUN_PAGES = 5;

/**
 * `repo`, `base`, `head` and `workflow` are each encoded per path segment (not as one joined
 * string) so a literal `/` inside a segment — e.g. a workflow path like
 * `.github/workflows/ci.yml` before it is normalized — is percent-encoded rather than treated as
 * a path separator GitHub's router then 404s on.
 */
function encodeRepoPath(repo: string): string {
  const slash = repo.indexOf('/');
  if (slash === -1) return encodeURIComponent(repo);
  return `${encodeURIComponent(repo.slice(0, slash))}/${encodeURIComponent(repo.slice(slash + 1))}`;
}

/**
 * GitHub's workflow-runs endpoint wants a bare filename (`ci.yml`), not the workflow's repo path
 * (`.github/workflows/ci.yml`) — the latter 404s unless every `/` is percent-encoded, which is
 * unnecessary once we just take the basename. Accepts either form from the manifest.
 */
function normalizeWorkflowFilename(workflow: string): string {
  const segments = workflow.split('/');
  return segments[segments.length - 1] || workflow;
}

/** Parses `rel="next"` out of a `Link` response header (RFC 8288), or null if there is none. */
function parseNextLink(linkHeader: string | null): string | null {
  if (linkHeader === null) return null;
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unreachable(detail: string, fix?: string): RefusalError {
  return new RefusalError(refusal('github_unreachable', `GitHub ${detail}`, fix));
}

/** Parses the `github-authentication-token-expiration` header GitHub sends on PAT requests. */
export function parseTokenExpiry(headers: Headers): Date | null {
  const value = headers.get(TOKEN_EXPIRY_HEADER);
  if (value === null || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRateLimitedForbidden(res: Response): boolean {
  return res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0';
}

export function createGitHubAdapter(options: GitHubAdapterOptions = {}): GitHubPort & { tokenExpiresAt(): Date | null } {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  let lastTokenExpiry: Date | null = null;

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent,
    };
    if (options.token !== undefined) {
      h.Authorization = `Bearer ${options.token}`;
    }
    return h;
  }

  /** One attempt: fetch with a timeout, throwing `unreachable` on a network error or a timeout. */
  async function attempt(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      return await doFetch(url, { headers: headers(), signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw unreachable(`timed out after ${String(timeoutMs)}ms`);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw unreachable(`is unreachable: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetches, retrying at most once on a network error or a timeout (never silently more). */
  async function request(url: string): Promise<Response> {
    let res: Response;
    try {
      res = await attempt(url);
    } catch {
      res = await attempt(url);
    }

    const expiry = parseTokenExpiry(res.headers);
    if (expiry !== null) lastTokenExpiry = expiry;

    if (res.status >= 500) {
      throw unreachable(`returned ${String(res.status)}`);
    }
    if (res.status === 429) {
      throw unreachable('rate-limited the request (429)', 'Wait for GitHub to lift the rate limit and retry.');
    }
    if (isRateLimitedForbidden(res)) {
      throw unreachable('rate limit is exhausted (403, x-ratelimit-remaining: 0)', 'Wait for the rate limit to reset and retry.');
    }
    if (res.status === 401) {
      throw unreachable('rejected the request as unauthorized (401)', 'Check the configured GitHub token; it may be missing or revoked.');
    }
    // Other 4xx besides 404 (handled by callers) is also a refusal, with the same token-focused fix.
    if (res.status >= 400 && res.status !== 404) {
      throw unreachable(`rejected the request (${String(res.status)})`, 'Check the configured GitHub token and repository name.');
    }

    return res;
  }

  async function parseJson(res: Response): Promise<unknown> {
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unreachable('returned an unexpected response: body was not valid JSON');
    }
  }

  function parseWorkflowRun(raw: unknown): WorkflowRun {
    if (!isRecord(raw)) throw unreachable('returned an unexpected response: a workflow run was not an object');
    const { id, head_sha, path, status, conclusion, event, head_branch } = raw;
    if (
      typeof id !== 'number' ||
      typeof head_sha !== 'string' ||
      typeof path !== 'string' ||
      typeof status !== 'string' ||
      (conclusion !== null && typeof conclusion !== 'string') ||
      typeof event !== 'string' ||
      (head_branch !== null && typeof head_branch !== 'string')
    ) {
      throw unreachable('returned an unexpected response: a workflow run was missing an expected field');
    }
    return {
      id,
      headSha: head_sha,
      path,
      status,
      conclusion,
      event,
      headBranch: head_branch,
    };
  }

  const COMPARE_STATUSES: readonly CompareStatus[] = ['ahead', 'behind', 'identical', 'diverged'];

  function parseComparison(raw: unknown): Comparison {
    if (!isRecord(raw)) throw unreachable('returned an unexpected response: the comparison was not an object');
    const { status, ahead_by, behind_by, commits } = raw;
    if (
      typeof status !== 'string' ||
      !COMPARE_STATUSES.includes(status as CompareStatus) ||
      typeof ahead_by !== 'number' ||
      typeof behind_by !== 'number' ||
      !Array.isArray(commits)
    ) {
      throw unreachable('returned an unexpected response: the comparison was missing an expected field');
    }
    const parsedCommits = commits.map((c) => {
      if (!isRecord(c) || typeof c.sha !== 'string' || !isRecord(c.commit) || typeof c.commit.message !== 'string') {
        throw unreachable('returned an unexpected response: a compared commit was missing an expected field');
      }
      return { sha: c.sha, message: c.commit.message.split('\n')[0] ?? '' };
    });
    return {
      status: status as CompareStatus,
      aheadBy: ahead_by,
      behindBy: behind_by,
      commits: parsedCommits,
    };
  }

  return {
    async workflowRuns(repo, workflow, headSha) {
      const filename = encodeURIComponent(normalizeWorkflowFilename(workflow));
      let url = `${baseUrl}/repos/${encodeRepoPath(repo)}/actions/workflows/${filename}/runs?head_sha=${encodeURIComponent(headSha)}&per_page=20`;

      const runs: WorkflowRun[] = [];
      for (let page = 0; page < MAX_WORKFLOW_RUN_PAGES; page++) {
        const res = await request(url);
        if (res.status === 404) return page === 0 ? [] : runs;

        const body = await parseJson(res);
        if (!isRecord(body) || !Array.isArray(body.workflow_runs)) {
          throw unreachable('returned an unexpected response: missing workflow_runs');
        }
        const pageRuns = body.workflow_runs.map(parseWorkflowRun);
        runs.push(...pageRuns);

        if (pageRuns.some((run) => run.conclusion === 'success')) break;

        const next = parseNextLink(res.headers.get('link'));
        if (next === null) break;
        url = next;
      }
      return runs;
    },

    async compare(repo, base, head) {
      const url = `${baseUrl}/repos/${encodeRepoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
      const res = await request(url);
      if (res.status === 404) return null;

      const body = await parseJson(res);
      return parseComparison(body);
    },

    tokenExpiresAt() {
      return lastTokenExpiry;
    },
  };
}
