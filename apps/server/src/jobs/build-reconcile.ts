import { parseManifestYaml } from '@shipyard/schema';
import { createGitHubAdapter, type GitHubPort } from '@shipyard/sequence/github';
import { enqueueBuild, isRefusal } from '../builds/service.js';
import type { ServiceDeps } from '../deps.js';

/**
 * The build reconcile loop (SHP-T-7.5, SHP-REQ-114): on a schedule, the default-branch head of
 * every `build: shipyard` app is looked up on GitHub, and a head that has no build row at all — in
 * any state — is queued, so a dropped webhook delivery is still built. A head that was ever built
 * (or failed, or was cancelled) is left alone: reconcile fills a gap, it never retries.
 */

export const RECONCILE_REQUESTER = { label: 'shipyard: reconcile' } as const;

export interface ReconcileOptions {
  github: Pick<GitHubPort, 'compare'>;
}

export interface ReconcileAppResult {
  app: string;
  head: string | null;
  outcome: 'queued' | 'already_built' | 'no_head' | 'github_unreachable' | 'refused';
  buildId?: string;
  refusal?: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;

function builtByShipyard(manifestYaml: string): boolean {
  try {
    return parseManifestYaml(manifestYaml).build?.source === 'shipyard';
  } catch {
    return false;
  }
}

/** One pass over every `build: shipyard` app. One app's GitHub failure never stops the others. */
export async function reconcileBuilds(deps: ServiceDeps, options: ReconcileOptions): Promise<ReconcileAppResult[]> {
  const { db, logger } = deps;
  const apps = await db.app.findMany({
    where: { repo: { not: null }, defaultBranch: { not: null } },
    select: { id: true, name: true, repo: true, defaultBranch: true, manifestYaml: true },
    orderBy: { name: 'asc' },
  });
  const results: ReconcileAppResult[] = [];
  for (const app of apps) {
    if (app.repo === null || app.defaultBranch === null || !builtByShipyard(app.manifestYaml)) continue;

    let head: string | null;
    try {
      // The same self-compare the commits screen uses: base = head = the branch, so the last
      // commit listed is the branch tip.
      const cmp = await options.github.compare(app.repo, app.defaultBranch, app.defaultBranch);
      head = cmp?.commits[cmp.commits.length - 1]?.sha.toLowerCase() ?? null;
    } catch (err) {
      logger.warn({ err, app: app.name, repo: app.repo }, 'build reconcile: GitHub unreachable, skipping app');
      results.push({ app: app.name, head: null, outcome: 'github_unreachable' });
      continue;
    }
    if (head === null || !SHA_RE.test(head)) {
      results.push({ app: app.name, head: null, outcome: 'no_head' });
      continue;
    }

    const existing = await db.build.findFirst({ where: { appId: app.id, sha: head }, select: { id: true } });
    if (existing !== null) {
      results.push({ app: app.name, head, outcome: 'already_built', buildId: existing.id });
      continue;
    }

    const r = await enqueueBuild(deps, { app: app.name, sha: head, trigger: 'reconcile', requester: { ...RECONCILE_REQUESTER } });
    if (isRefusal(r)) {
      logger.warn({ app: app.name, head, refusal: r.code }, 'build reconcile: enqueue refused');
      results.push({ app: app.name, head, outcome: 'refused', refusal: r.code });
    } else {
      logger.info({ app: app.name, head, buildId: r.buildId }, 'build reconcile: queued a missed head');
      results.push({ app: app.name, head, outcome: 'queued', buildId: r.buildId });
    }
  }
  return results;
}

export interface StartBuildReconcileOptions {
  github?: Pick<GitHubPort, 'compare'>;
  intervalMs?: number;
}

/**
 * Starts the reconcile loop every `BUILD_RECONCILE_INTERVAL_SECONDS`. GitHub is read with
 * `GITHUB_TOKEN_SERVER` when set, anonymously otherwise (public repos). A pass never overlaps
 * the previous one; the stopper waits for a pass in flight.
 */
export function startBuildReconcile(deps: ServiceDeps, options: StartBuildReconcileOptions = {}): { stop: () => Promise<void> } {
  const github =
    options.github ??
    createGitHubAdapter(deps.config.GITHUB_TOKEN_SERVER === undefined ? {} : { token: deps.config.GITHUB_TOKEN_SERVER });
  const intervalMs = options.intervalMs ?? deps.config.BUILD_RECONCILE_INTERVAL_SECONDS * 1000;
  let stopped = false;
  let running = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  const tick = (): void => {
    if (running || stopped) return;
    running = true;
    inFlight = reconcileBuilds(deps, { github })
      .catch((err: unknown) => {
        deps.logger.error({ err }, 'build reconcile failed');
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, intervalMs);
  tick();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
