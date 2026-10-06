import { refusal } from '@shipyard/schema';
import { RefusalError } from '../ports.js';
import type { Comparison, CompareStatus, GitHubPort, WorkflowJob, WorkflowRun } from '../ports.js';

// The server's entry point (`@shipyard/sequence/github`): it reads GitHub through this adapter and
// must not load the Docker adapter along with the barrel — the server never touches Docker.
export { RefusalError } from '../ports.js';
export type { GitHubPort, WorkflowJob, WorkflowRun } from '../ports.js';

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
  /** Byte cap on a fetched tarball, enforced while streaming. Default 500 MiB. */
  maxTarballBytes?: number;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'shipyard-agent';
const TOKEN_EXPIRY_HEADER = 'github-authentication-token-expiration';
/** Cap on `workflowRuns` pagination: never follow more than this many `Link: rel="next"` pages. */
const MAX_WORKFLOW_RUN_PAGES = 5;
const DEFAULT_MAX_TARBALL_BYTES = 500 * 1024 * 1024;
/** GitHub's tarball endpoint 302s to codeload; the redirect is followed only to this host, or the
 * API's own origin (tests, GitHub Enterprise) — never anywhere else, and never with the token. */
const CODELOAD_HOST = 'codeload.github.com';
const SHA_RE = /^[0-9a-f]{40}$/;

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

export function createGitHubAdapter(options: GitHubAdapterOptions = {}): GitHubPort & { tokenExpiresAt(): Date | null; runJobs(repo: string, runId: number): Promise<WorkflowJob[]> } {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const maxTarballBytes = options.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES;
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

  /**
   * One attempt with an arbitrary header set and redirect mode, for the tarball flow, which
   * cannot reuse `attempt`'s always-authorized, always-auto-redirect request.
   */
  async function attemptWith(url: string, init: { headers: Record<string, string>; redirect: 'error' | 'follow' | 'manual' }): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      return await doFetch(url, { headers: init.headers, redirect: init.redirect, signal: controller.signal });
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

  /** Retries at most once on a network error or a timeout (never silently more). */
  async function requestWith(url: string, init: { headers: Record<string, string>; redirect: 'error' | 'follow' | 'manual' }): Promise<Response> {
    try {
      return await attemptWith(url, init);
    } catch {
      return await attemptWith(url, init);
    }
  }

  /** Maps the common non-2xx statuses to `github_unreachable`, leaving 404 and redirects to the caller. */
  function checkCommonStatus(res: Response): void {
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
    if (res.status >= 400 && res.status !== 404) {
      throw unreachable(`rejected the request (${String(res.status)})`, 'Check the configured GitHub token and repository name.');
    }
  }

  /** Byte-caps a stream while it is read, erroring it (and so the extraction pipeline) once exceeded. */
  function capStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    let total = 0;
    return body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > maxTarballBytes) {
            controller.error(unreachable(`archive exceeds the ${String(maxTarballBytes)}-byte cap`));
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
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
    const { id, head_sha, path, status, conclusion, event, head_branch, html_url, run_started_at, updated_at } = raw;
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
      url: typeof html_url === 'string' ? html_url : null,
      startedAt: typeof run_started_at === 'string' ? run_started_at : null,
      // A run's `updated_at` moves while it runs; it is the end time only once it has completed.
      completedAt: status === 'completed' && typeof updated_at === 'string' ? updated_at : null,
    };
  }

  function parseWorkflowJob(raw: unknown): WorkflowJob {
    if (!isRecord(raw)) throw unreachable('returned an unexpected response: a workflow job was not an object');
    const { id, name, status, conclusion, started_at, completed_at, html_url } = raw;
    if (
      typeof id !== 'number' ||
      typeof name !== 'string' ||
      typeof status !== 'string' ||
      (conclusion !== null && conclusion !== undefined && typeof conclusion !== 'string') ||
      (started_at !== null && started_at !== undefined && typeof started_at !== 'string') ||
      (completed_at !== null && completed_at !== undefined && typeof completed_at !== 'string') ||
      (html_url !== null && html_url !== undefined && typeof html_url !== 'string')
    ) {
      throw unreachable('returned an unexpected response: a workflow job was missing an expected field');
    }
    return {
      id,
      name,
      status,
      conclusion: conclusion ?? null,
      startedAt: started_at ?? null,
      completedAt: completed_at ?? null,
      url: html_url ?? null,
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
        // Follow pagination only on the API's own origin: the request carries the PAT.
        if (new URL(next).origin !== new URL(baseUrl).origin) {
          throw unreachable(`returned a pagination link to another origin (${new URL(next).origin})`);
        }
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

    async runJobs(repo, runId) {
      if (!Number.isSafeInteger(runId) || runId <= 0) {
        throw new RefusalError(refusal('invalid_request', `'${String(runId)}' is not a workflow run id`));
      }
      // One page of 100 is every job a Shipyard repo's workflow has; the console shows lanes, not an audit log.
      const url = `${baseUrl}/repos/${encodeRepoPath(repo)}/actions/runs/${String(runId)}/jobs?per_page=100`;
      const res = await request(url);
      // The run was found a moment ago, so a 404 here is a token without Actions read on this repo
      // (or a run deleted since). Saying "no jobs" would be cached as the run's final answer; refuse
      // instead, so nothing is cached and the console says what to fix (SHP-ADR-007).
      if (res.status === 404) {
        throw new RefusalError(
          refusal(
            'github_unreachable',
            `GitHub would not list the jobs of run ${String(runId)} in ${repo}.`,
            "Give the server's GitHub token Actions: read on this repository, then reload.",
          ),
        );
      }

      const body = await parseJson(res);
      if (!isRecord(body) || !Array.isArray(body.jobs)) {
        throw unreachable('returned an unexpected response: missing jobs');
      }
      return body.jobs.map(parseWorkflowJob);
    },

    async tarball(repo, sha) {
      if (!SHA_RE.test(sha)) {
        throw new RefusalError(refusal('invalid_request', `'${sha}' is not a 40-hex commit SHA`));
      }

      const apiUrl = `${baseUrl}/repos/${encodeRepoPath(repo)}/tarball/${encodeURIComponent(sha)}`;
      let res = await requestWith(apiUrl, { headers: headers(), redirect: 'manual' });

      // GitHub answers the tarball endpoint with a redirect to codeload (or, in test fixtures and
      // GitHub Enterprise, the API's own origin). Follow it exactly once, unauthenticated — the
      // token is for api.github.com only and must never reach another origin (SHP-REQ-116).
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (location === null) throw unreachable('redirected to the tarball with no Location header');
        let target: URL;
        try {
          target = new URL(location, apiUrl);
        } catch {
          throw unreachable('redirected to an unparseable Location URL');
        }
        if (target.protocol !== 'https:') {
          throw unreachable(`redirected to a non-https URL (${target.protocol})`);
        }
        const allowed = target.hostname === CODELOAD_HOST || target.origin === new URL(baseUrl).origin;
        if (!allowed) {
          throw unreachable(`redirected to a disallowed host (${target.hostname})`);
        }
        res = await requestWith(target.toString(), { headers: { 'User-Agent': userAgent }, redirect: 'manual' });
        if (res.status >= 300 && res.status < 400) {
          throw unreachable('redirected more than once fetching the tarball');
        }
      }

      if (res.status === 404) {
        throw unreachable(`has no tarball for ${sha.slice(0, 7)} (unknown SHA or repository)`);
      }
      checkCommonStatus(res);

      if (res.body === null) {
        throw unreachable('returned an empty body for the tarball');
      }
      return capStream(res.body);
    },

    tokenExpiresAt() {
      return lastTokenExpiry;
    },
  };
}
