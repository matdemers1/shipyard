import type { RequestHandler, Response, Router } from 'express';
import type { z } from 'zod';
import { GitHubSettingsUpdate, GitHubTestRequest, refusal, type GitHubSettings, type GitHubTestResult } from '@shipyard/schema';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { sendRefusal } from '../errors.js';
import {
  envOwnsGitHub,
  fetchRateLimit,
  forgetGitHubToken,
  GITHUB_SETTING_KEY,
  parseStoredGitHub,
  resolveGitHubToken,
} from '../github/token.js';
import { deriveSettingsKey, encryptSecret } from './crypto.js';

/**
 * Settings → GitHub (SHP-T-3.13): the server's read-only GitHub token, stored in the `setting`
 * table under `github`, sealed like the alert-email token. Write-only; env wins (409 on every
 * write); every change audited without the token. Every server GitHub caller reads it live
 * (github/token.ts), so a save needs no restart. The screen shows GitHub's own rate limit, which
 * is the number that decides whether Shipyard can see new commits at all.
 */

export interface GitHubRouteDeps {
  db: Db;
  config: Config;
  logger: Logger;
  /** Test-only: GitHub's `/rate_limit`, faked. */
  githubFetch?: typeof fetch;
}

const ENV_OWNED = refusal(
  'conflict',
  'The GitHub token is set in server.env, which wins over Settings.',
  'Change GITHUB_TOKEN_SERVER in server.env and restart — or remove it there to manage the token here.',
);
const NO_SESSION_SECRET = refusal(
  'conflict',
  'Shipyard cannot store a GitHub token while SESSION_SECRET is unset: it would be unreadable after a restart.',
  'Set SESSION_SECRET in server.env (32 random bytes), restart, then save the token again.',
);

export function addGitHubRoutes(
  router: Router,
  deps: GitHubRouteDeps,
  admin: RequestHandler[],
  bad: (res: Response, issues: z.core.$ZodIssue[]) => void,
): void {
  const { db, config } = deps;
  const rateLimitOptions = deps.githubFetch !== undefined ? { fetch: deps.githubFetch } : {};

  async function current(): Promise<GitHubSettings> {
    const state = await resolveGitHubToken(deps);
    const answer = await fetchRateLimit(state.token, rateLimitOptions);
    return {
      source: state.source,
      tokenSet: state.tokenSet,
      canStoreSecret: config.SESSION_SECRET !== undefined,
      problem: state.problem,
      updatedAt: state.updatedAt?.toISOString() ?? null,
      rateLimit: answer.ok ? answer.rateLimit : null,
      rateLimitProblem: answer.ok ? null : answer.detail,
    };
  }

  async function storedTokenSet(): Promise<boolean> {
    const row = await db.setting.findUnique({ where: { key: GITHUB_SETTING_KEY } });
    return row !== null && parseStoredGitHub(row.value) !== null;
  }

  router.get('/github', ...admin, async (_req, res) => {
    res.json(await current());
  });

  router.put('/github', ...admin, async (req, res) => {
    if (envOwnsGitHub(config)) {
      sendRefusal(res, ENV_OWNED);
      return;
    }
    const parsed = GitHubSettingsUpdate.safeParse(req.body);
    if (!parsed.success) {
      bad(res, parsed.error.issues);
      return;
    }
    if (config.SESSION_SECRET === undefined) {
      sendRefusal(res, NO_SESSION_SECRET);
      return;
    }
    const hadToken = await storedTokenSet();
    const value = { token: encryptSecret(parsed.data.token, deriveSettingsKey(config.SESSION_SECRET)) };
    const updatedById = req.actor?.id ?? null;
    await db.setting.upsert({
      where: { key: GITHUB_SETTING_KEY },
      create: { key: GITHUB_SETTING_KEY, value, updatedById },
      update: { value, updatedById },
    });
    forgetGitHubToken(db);
    // Never the token, sealed or not.
    await req.audit({
      action: 'settings.github.updated',
      entityType: 'setting',
      entityId: GITHUB_SETTING_KEY,
      before: { tokenSet: hadToken },
      after: { tokenSet: true },
    });
    res.json(await current());
  });

  router.delete('/github', ...admin, async (req, res) => {
    if (envOwnsGitHub(config)) {
      sendRefusal(res, ENV_OWNED);
      return;
    }
    if (!(await storedTokenSet())) {
      req.noAuditNeeded('no GitHub token was stored in Settings; nothing to clear');
    } else {
      await db.setting.deleteMany({ where: { key: GITHUB_SETTING_KEY } });
      forgetGitHubToken(db);
      await req.audit({
        action: 'settings.github.cleared',
        entityType: 'setting',
        entityId: GITHUB_SETTING_KEY,
        before: { tokenSet: true },
      });
    }
    res.json(await current());
  });

  router.post('/github/test', ...admin, async (req, res) => {
    const parsed = GitHubTestRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      bad(res, parsed.error.issues);
      return;
    }
    const token = parsed.data.token ?? (await resolveGitHubToken(deps)).token;
    const answer = await fetchRateLimit(token, rateLimitOptions);
    req.noAuditNeeded('a rate-limit request to GitHub changes nothing');
    const result: GitHubTestResult = answer.ok
      ? {
          ok: token === null || answer.rateLimit.authenticated,
          status: answer.status,
          rateLimit: answer.rateLimit,
          ...(token !== null && !answer.rateLimit.authenticated
            ? { detail: 'GitHub answered, but counted the request as anonymous: this is not a working token.' }
            : {}),
        }
      : { ok: false, ...(answer.status !== undefined ? { status: answer.status } : {}), detail: answer.detail };
    res.json(result);
  });
}
