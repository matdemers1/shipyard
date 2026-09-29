import { z } from 'zod';
import type { Db } from '../db.js';
import type { ServiceDeps } from '../deps.js';
import { addBuildHooks, type BuildResultEvent, type BuildStageEndEvent } from '../builds/service.js';
import { encodeRepoPath, githubStatusForResult, githubStatusForStageEnd } from '../builds/status.js';
import { applyRowOutcome } from './index.js';

/**
 * GitHub commit statuses and a Foreman build record, through the outbox (SHP-T-7.15,
 * SHP-REQ-146/147). Registers on `builds/service.ts`'s hook points; `registerBuildNotifications`
 * is wired up from `src/index.ts` (owned by the lead) once, per server process.
 *
 * Both row kinds below reuse the existing `outbox` table (SHP-T-2.9) rather than a new one, with
 * the row's true shape carried entirely in the JSON `payload` column and a `kind` discriminator —
 * `outbox/index.ts` dispatches on it. A build has no deploy target of its own (most builds are
 * never deployed), so these rows leave `target_id` null.
 */

const GitHubStatusPayload = z.object({
  kind: z.literal('github_status'),
  buildId: z.string(),
  sha: z.string(),
  repo: z.string(),
  context: z.enum(['shipyard/test', 'shipyard/build']),
  state: z.enum(['success', 'failure', 'error']),
  description: z.string(),
  targetUrl: z.string().optional(),
});
type GitHubStatusPayload = z.infer<typeof GitHubStatusPayload>;

const ForemanBuildPayload = z.object({
  kind: z.literal('foreman_build'),
  buildId: z.string(),
  app: z.string(),
  sha: z.string(),
  project: z.string(),
  environment: z.string(),
  state: z.enum(['succeeded', 'failed', 'cancelled', 'refused']),
  failedStage: z.string().optional(),
});
type ForemanBuildPayload = z.infer<typeof ForemanBuildPayload>;

/** Inserts one outbox row, idempotent by `idempotencyKey`. */
async function insertOutboxRow(db: Db, idempotencyKey: string, payload: GitHubStatusPayload | ForemanBuildPayload): Promise<void> {
  await db.outbox.createMany({ data: [{ idempotencyKey, payload, targetId: null }], skipDuplicates: true });
}

export async function enqueueGithubStatus(
  db: Db,
  params: {
    idempotencyKey: string;
    buildId: string;
    sha: string;
    repo: string;
    context: 'shipyard/test' | 'shipyard/build';
    state: 'success' | 'failure' | 'error';
    description: string;
    targetUrl?: string;
  },
): Promise<void> {
  const payload: GitHubStatusPayload = {
    kind: 'github_status',
    buildId: params.buildId,
    sha: params.sha,
    repo: params.repo,
    context: params.context,
    state: params.state,
    description: params.description,
    ...(params.targetUrl === undefined ? {} : { targetUrl: params.targetUrl }),
  };
  await insertOutboxRow(db, params.idempotencyKey, payload);
}

/**
 * SHP-REQ-147: recorded through the outbox. No Foreman endpoint for a build/CI result exists yet
 * in this codebase (only `/api/projects/:project/deployments`, which is the wrong shape for a
 * build that may never deploy) — reported under `needsOutside`. The row is written so it is
 * *recorded* now and can drain once that endpoint exists; `outbox/index.ts`'s claim query
 * deliberately never selects a `foreman_build` row today, so it queues rather than erroring.
 */
export async function enqueueForemanBuild(
  db: Db,
  params: {
    idempotencyKey: string;
    buildId: string;
    app: string;
    sha: string;
    project: string;
    environment: string;
    state: 'succeeded' | 'failed' | 'cancelled' | 'refused';
    failedStage?: string;
  },
): Promise<void> {
  const payload: ForemanBuildPayload = {
    kind: 'foreman_build',
    buildId: params.buildId,
    app: params.app,
    sha: params.sha,
    project: params.project,
    environment: params.environment,
    state: params.state,
    ...(params.failedStage === undefined ? {} : { failedStage: params.failedStage }),
  };
  await insertOutboxRow(db, params.idempotencyKey, payload);
}

function buildTargetUrl(config: ServiceDeps['config'], buildId: string): string | undefined {
  return config.PUBLIC_URL === undefined ? undefined : `${config.PUBLIC_URL}/builds/${buildId}`;
}

/**
 * Registers the hooks that turn a build stage ending or a build's terminal result into outbox
 * rows (SHP-REQ-146/147). Returns an unregister, same shape as `addBuildHooks`. The lead wires
 * this into `src/index.ts` once per server process.
 */
export function registerBuildNotifications(deps: ServiceDeps): () => void {
  return addBuildHooks(deps.bus, {
    onStageEnd: async (hookDeps, event: BuildStageEndEvent) => {
      const status = githubStatusForStageEnd(event);
      if (status === null) return;
      const app = await hookDeps.db.app.findUnique({ where: { name: event.app }, select: { repo: true } });
      if (app === null || app.repo === null) return;
      const targetUrl = buildTargetUrl(hookDeps.config, event.buildId);
      await enqueueGithubStatus(hookDeps.db, {
        idempotencyKey: `${event.buildId}:status:${event.stage}`,
        buildId: event.buildId,
        sha: event.sha,
        repo: app.repo,
        context: status.context,
        state: status.state,
        description: status.description,
        ...(targetUrl === undefined ? {} : { targetUrl }),
      });
    },
    onResult: async (hookDeps, event: BuildResultEvent) => {
      const status = githubStatusForResult(event);
      const app = await hookDeps.db.app.findUnique({
        where: { name: event.app },
        select: { repo: true, foremanProject: true, foremanEnvironment: true },
      });
      if (app !== null && app.repo !== null) {
        const targetUrl = buildTargetUrl(hookDeps.config, event.buildId);
        await enqueueGithubStatus(hookDeps.db, {
          idempotencyKey: `${event.buildId}:status:result`,
          buildId: event.buildId,
          sha: event.sha,
          repo: app.repo,
          context: status.context,
          state: status.state,
          description: status.description,
          ...(targetUrl === undefined ? {} : { targetUrl }),
        });
      }
      if (app !== null && app.foremanProject !== null) {
        await enqueueForemanBuild(hookDeps.db, {
          idempotencyKey: `${event.buildId}:foreman-build`,
          buildId: event.buildId,
          app: event.app,
          sha: event.sha,
          project: app.foremanProject,
          environment: app.foremanEnvironment ?? 'production',
          state: event.state,
          ...(event.failedStage === undefined ? {} : { failedStage: event.failedStage }),
        });
      }
    },
  });
}

type FetchFn = typeof fetch;

interface ClaimedRow {
  id: string;
  idempotencyKey: string;
  payload: unknown;
  attempts: number;
}

const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';

/**
 * Posts one `github_status` row's commit status (SHP-REQ-146). The status token
 * (`GITHUB_TOKEN_STATUS`) is used here and nowhere else — the read-only `GITHUB_TOKEN_SERVER`
 * never writes. A 5xx or a 429 retries with backoff (SHP-REQ-049's same schedule); any other 4xx
 * is logged and parked rather than retried, since GitHub will never accept the same request twice.
 */
export async function processGithubStatusRow(
  deps: ServiceDeps,
  row: ClaimedRow,
  fetchImpl: FetchFn,
  now: Date,
  baseUrl = DEFAULT_GITHUB_API_BASE_URL,
): Promise<void> {
  const token = deps.config.GITHUB_TOKEN_STATUS;
  // The claim query in outbox/index.ts only selects this kind when the token is set; this is a
  // defensive no-op, not load-bearing.
  if (token === undefined) return;

  const parsed = GitHubStatusPayload.safeParse(row.payload);
  if (!parsed.success) {
    await applyRowOutcome(deps, row, now, { kind: 'parked', message: `invalid github_status payload: ${parsed.error.message}` });
    return;
  }
  const payload = parsed.data;

  try {
    const res = await fetchImpl(`${baseUrl}/repos/${encodeRepoPath(payload.repo)}/statuses/${payload.sha}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        state: payload.state,
        context: payload.context,
        description: payload.description,
        ...(payload.targetUrl === undefined ? {} : { target_url: payload.targetUrl }),
      }),
    });

    if (res.ok) {
      await applyRowOutcome(deps, row, now, { kind: 'delivered' });
      return;
    }

    const bodyText = await res.text().catch(() => '');
    if (res.status >= 500 || res.status === 429) {
      await applyRowOutcome(deps, row, now, { kind: 'retry', message: `HTTP ${String(res.status)}: ${bodyText}` }, token);
      return;
    }

    deps.logger.error({ idempotencyKey: row.idempotencyKey, status: res.status }, 'github rejected commit status; not retrying');
    await applyRowOutcome(deps, row, now, { kind: 'parked', message: `HTTP ${String(res.status)}: ${bodyText}` }, token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await applyRowOutcome(deps, row, now, { kind: 'retry', message }, token);
  }
}
