import { ACTIVE_STATES, type BuildState } from '@shipyard/schema';
import { createGitHubAdapter, type GitHubPort } from '@shipyard/sequence/github';
import { buildSourceOf, cachedCompare, makeCompareCache } from '../apps/commits.js';
import { recordedRelease } from '../apps/index.js';
import type { ServiceDeps } from '../deps.js';
import { TERMINAL_STATES } from '../deploys/service.js';

/**
 * Module-scoped so it lives for the process, across every `shipyard_status` call — a fresh
 * `McpServer` (and `GitHubPort`, when none is injected) is built per HTTP request, but the cache
 * must not be (SHP-T-7.20, SHP-REQ-145): two calls within 60 s make one `compare` per app.
 */
const compareCache = makeCompareCache();

/**
 * The read-only view behind `shipyard_status` (SHP-T-2.8, SHP-REQ-145). Built from the same rows
 * the console's app mirror reads; nothing here writes.
 */

export interface AppStatusOptions {
  /** Injected for tests; defaults to the real GitHub API (SHP-REQ-145). */
  github?: Pick<GitHubPort, 'compare'>;
}

export interface McpWaitingCommit {
  sha: string;
  message: string;
  /** Null when this app is not `build: shipyard`, or no build of this SHA has ever been queued. */
  build: { state: BuildState; buildId: string } | null;
}

export interface McpAppStatus {
  name: string;
  repo: string | null;
  defaultBranch: string | null;
  reportedAt: string | null;
  /** Where this app's images come from: its own manifest's `build.source` (SHP-REQ-145). */
  buildSource: 'github' | 'shipyard';
  /** Commits ahead of the recorded release on the default branch, oldest first. */
  commits: McpWaitingCommit[];
  /** The recorded release: the last succeeded target. Null when Shipyard has never deployed it. */
  live: {
    sha: string | null;
    digests: Record<string, string>;
    schemaRevision: string | null;
    deployId: string;
    endedAt: string | null;
  } | null;
  /** Open drift: running digests differ from the recorded release. Blocks forward deploys. */
  drift: { detectedAt: string; observed: unknown; recorded: unknown } | null;
  /** Who holds the app's deploy lock, and at which step; null when nobody does. */
  lock: { deployId: string; holder: string; state: string; step: string | null } | null;
  /** The newest finished target (deploy, rollback or dry run). */
  lastResult: {
    deployId: string;
    kind: string;
    sha: string;
    dryRun: boolean;
    state: string;
    requester: string;
    endedAt: string | null;
    refusal: unknown;
  } | null;
}

/** Commits ahead of `live` on `defaultBranch`, oldest first; `[]` when GitHub cannot answer. */
async function waitingCommits(
  github: Pick<GitHubPort, 'compare'>,
  repo: string,
  defaultBranch: string,
  live: string,
): Promise<{ sha: string; message: string }[]> {
  try {
    const comparison = await cachedCompare(compareCache, github, repo, live, defaultBranch);
    return comparison?.commits ?? [];
  } catch {
    return [];
  }
}

export async function appStatuses(
  deps: Pick<ServiceDeps, 'db' | 'config'>,
  names: readonly string[],
  options: AppStatusOptions = {},
): Promise<McpAppStatus[]> {
  const { db } = deps;
  const github =
    options.github ??
    createGitHubAdapter(deps.config.GITHUB_TOKEN_SERVER === undefined ? {} : { token: deps.config.GITHUB_TOKEN_SERVER });
  const apps = await db.app.findMany({
    where: { name: { in: [...names] } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, repo: true, defaultBranch: true, reportedAt: true, manifestYaml: true },
  });
  return Promise.all(
    apps.map(async (app): Promise<McpAppStatus> => {
      const buildSource = buildSourceOf(app.manifestYaml);
      const [release, drift, active, last] = await Promise.all([
        recordedRelease(db, app.id),
        db.driftEvent.findFirst({
          where: { appId: app.id, resolvedAt: null },
          orderBy: { detectedAt: 'desc' },
          select: { detectedAt: true, observed: true, recorded: true },
        }),
        db.deployTarget.findFirst({
          where: { appId: app.id, state: { in: [...ACTIVE_STATES] } },
          select: { deployId: true, state: true, currentStep: true, deploy: { select: { requesterLabel: true } } },
        }),
        db.deployTarget.findFirst({
          where: { appId: app.id, state: { in: [...TERMINAL_STATES] } },
          orderBy: [{ endedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
          select: {
            deployId: true,
            state: true,
            endedAt: true,
            refusal: true,
            deploy: { select: { kind: true, requestedSha: true, dryRun: true, requesterLabel: true } },
          },
        }),
      ]);
      const releaseTarget =
        release === null
          ? null
          : await db.deployTarget.findUnique({ where: { id: release.targetId }, select: { schemaRevision: true } });

      const rawCommits =
        release?.sha !== null && release?.sha !== undefined && app.repo !== null && app.defaultBranch !== null
          ? await waitingCommits(github, app.repo, app.defaultBranch, release.sha)
          : [];
      const builds =
        rawCommits.length === 0
          ? []
          : await db.build.findMany({
              where: { appId: app.id, sha: { in: rawCommits.map((c) => c.sha) } },
              orderBy: { createdAt: 'desc' },
              select: { id: true, sha: true, state: true },
            });
      const latestBuildBySha = new Map<string, { id: string; state: BuildState }>();
      for (const b of builds) {
        if (!latestBuildBySha.has(b.sha)) latestBuildBySha.set(b.sha, { id: b.id, state: b.state });
      }
      const commits: McpWaitingCommit[] = rawCommits.map((c) => {
        const build = latestBuildBySha.get(c.sha);
        return { sha: c.sha, message: c.message, build: build === undefined ? null : { state: build.state, buildId: build.id } };
      });

      return {
        name: app.name,
        repo: app.repo,
        defaultBranch: app.defaultBranch,
        reportedAt: app.reportedAt?.toISOString() ?? null,
        buildSource,
        commits,
        live:
          release === null
            ? null
            : {
                sha: release.sha,
                digests: release.digests,
                schemaRevision: releaseTarget?.schemaRevision ?? null,
                deployId: release.deployId,
                endedAt: release.endedAt?.toISOString() ?? null,
              },
        drift:
          drift === null
            ? null
            : { detectedAt: drift.detectedAt.toISOString(), observed: drift.observed, recorded: drift.recorded },
        lock:
          active === null
            ? null
            : {
                deployId: active.deployId,
                holder: active.deploy.requesterLabel,
                state: active.state,
                step: active.currentStep,
              },
        lastResult:
          last === null
            ? null
            : {
                deployId: last.deployId,
                kind: last.deploy.kind,
                sha: last.deploy.requestedSha,
                dryRun: last.deploy.dryRun,
                state: last.state,
                requester: last.deploy.requesterLabel,
                endedAt: last.endedAt?.toISOString() ?? null,
                refusal: last.refusal,
              },
      };
    }),
  );
}
