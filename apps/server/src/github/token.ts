import { refusal, type D3AuthSource, type GitHubRateLimit } from '@shipyard/schema';
import { createGitHubAdapter, RefusalError, type GitHubPort } from '@shipyard/sequence/github';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { decryptSecret, deriveSettingsKey } from '../settings/crypto.js';

/**
 * The server's GitHub token, resolved live (SHP-T-3.13): GITHUB_TOKEN_SERVER in server.env when set
 * (env wins, and the console shows it read-only), otherwise the `github` setting an admin saved in
 * the console, sealed under the settings key. Every server-side GitHub caller goes through
 * {@link liveGitHub}, so a save takes effect on the next call — no restart.
 *
 * Nothing here throws for a bad configuration: an unreadable row or a token sealed under an old
 * SESSION_SECRET comes out as "no token" with the reason, and GitHub is then called anonymously.
 */

export const GITHUB_SETTING_KEY = 'github';

export interface StoredGitHub {
  /** Sealed, never plaintext. */
  token: string;
}

export function parseStoredGitHub(value: unknown): StoredGitHub | null {
  if (typeof value !== 'object' || value === null) return null;
  const token = (value as Record<string, unknown>)['token'];
  return typeof token === 'string' ? { token } : null;
}

export function envOwnsGitHub(config: Pick<Config, 'GITHUB_TOKEN_SERVER'>): boolean {
  return config.GITHUB_TOKEN_SERVER !== undefined;
}

export interface GitHubTokenState {
  source: D3AuthSource;
  tokenSet: boolean;
  /** What a GitHub call uses right now; null means anonymous. Plaintext. */
  token: string | null;
  problem: string | null;
  updatedAt: Date | null;
}

const NONE: GitHubTokenState = { source: 'none', tokenSet: false, token: null, problem: null, updatedAt: null };

export interface GitHubTokenDeps {
  db: Db;
  config: Config;
  logger?: Logger;
}

export async function resolveGitHubToken(deps: GitHubTokenDeps): Promise<GitHubTokenState> {
  const { db, config, logger } = deps;
  if (config.GITHUB_TOKEN_SERVER !== undefined) {
    return { ...NONE, source: 'env', tokenSet: true, token: config.GITHUB_TOKEN_SERVER };
  }
  let row: { value: unknown; updatedAt: Date } | null;
  try {
    row = await db.setting.findUnique({ where: { key: GITHUB_SETTING_KEY }, select: { value: true, updatedAt: true } });
  } catch (error) {
    logger?.warn({ err: error instanceof Error ? error.message : String(error) }, 'could not read the GitHub setting');
    return { ...NONE, problem: 'The stored GitHub setting could not be read.' };
  }
  const stored = row === null ? null : parseStoredGitHub(row.value);
  if (row === null || stored === null) return NONE;
  const base: GitHubTokenState = { ...NONE, source: 'settings', tokenSet: true, updatedAt: row.updatedAt };
  if (config.SESSION_SECRET === undefined) {
    return { ...base, problem: 'The stored GitHub token cannot be read: SESSION_SECRET is unset in server.env.' };
  }
  try {
    return { ...base, token: decryptSecret(stored.token, deriveSettingsKey(config.SESSION_SECRET)) };
  } catch (error) {
    logger?.warn('the stored GitHub token cannot be decrypted; calling GitHub anonymously');
    return { ...base, problem: error instanceof Error ? error.message : 'The stored GitHub token cannot be read.' };
  }
}

/** How long a resolved token is reused before the setting is read again. A save clears it at once. */
const TOKEN_TTL_MS = 5000;
const tokenCache = new WeakMap<Db, { at: number; token: string | null }>();

/** Forget the cached token, so the next call reads the setting a save just wrote. */
export function forgetGitHubToken(db: Db): void {
  tokenCache.delete(db);
}

async function currentToken(deps: GitHubTokenDeps): Promise<string | null> {
  if (deps.config.GITHUB_TOKEN_SERVER !== undefined) return deps.config.GITHUB_TOKEN_SERVER;
  const cached = tokenCache.get(deps.db);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < TOKEN_TTL_MS) return cached.token;
  const { token } = await resolveGitHubToken(deps);
  tokenCache.set(deps.db, { at: now, token });
  return token;
}

/**
 * A {@link GitHubPort} that uses whatever token is current on each call: env, then Settings, then
 * anonymous. The adapter is rebuilt only when the token changes.
 */
export function liveGitHub(deps: GitHubTokenDeps): GitHubPort {
  let current: { token: string | null; port: ReturnType<typeof createGitHubAdapter> } | null = null;
  const port = async () => {
    const token = await currentToken(deps);
    if (current?.token !== token) current = { token, port: createGitHubAdapter(token === null ? {} : { token }) };
    return current.port;
  };
  return {
    workflowRuns: async (repo, workflow, headSha) => (await port()).workflowRuns(repo, workflow, headSha),
    compare: async (repo, base, head) => (await port()).compare(repo, base, head),
    tarball: async (repo, sha) => {
      const p = await port();
      if (p.tarball === undefined) throw new RefusalError(refusal('github_unreachable', 'GitHub tarballs are unavailable.'));
      return p.tarball(repo, sha);
    },
  };
}

/** What GitHub answered to `GET /rate_limit`, which does not count against the limit. */
export type RateLimitAnswer =
  | { ok: true; status: number; rateLimit: GitHubRateLimit }
  | { ok: false; status?: number; detail: string };

export async function fetchRateLimit(
  token: string | null,
  options: { fetch?: typeof fetch; timeoutMs?: number; baseUrl?: string } = {},
): Promise<RateLimitAnswer> {
  const doFetch = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? 5000);
  try {
    const res = await doFetch(`${options.baseUrl ?? 'https://api.github.com'}/rate_limit`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'shipyard-server',
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      signal: controller.signal,
    });
    if (res.status === 401) {
      return { ok: false, status: 401, detail: 'GitHub rejected the token (401): it is mistyped, expired or revoked.' };
    }
    if (!res.ok) return { ok: false, status: res.status, detail: `GitHub answered ${String(res.status)}.` };
    const body = (await res.json()) as { resources?: { core?: { limit?: unknown; remaining?: unknown; reset?: unknown } } };
    const core = body.resources?.core;
    if (typeof core?.limit !== 'number' || typeof core.remaining !== 'number' || typeof core.reset !== 'number') {
      return { ok: false, status: res.status, detail: 'GitHub answered without a rate limit.' };
    }
    return {
      ok: true,
      status: res.status,
      rateLimit: {
        // An anonymous caller gets 60 an hour; any token gets far more.
        authenticated: token !== null && core.limit > 60,
        limit: core.limit,
        remaining: core.remaining,
        resetAt: new Date(core.reset * 1000).toISOString(),
      },
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return { ok: false, detail: aborted ? 'GitHub did not answer in time.' : 'GitHub could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}
