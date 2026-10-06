import { Router } from 'express';
import { refusal } from '@shipyard/schema';
import {
  RefusalError as SequenceRefusalError,
  createGitHubAdapter,
  type GitHubPort,
  type WorkflowJob,
  type WorkflowRun,
} from '@shipyard/sequence/github';
import type { ServiceDeps } from '../deps.js';
import { sendRefusal } from '../errors.js';
import { liveGitHub, resolveGitHubToken } from '../github/token.js';
import { buildSourceOf, parseWorkflow, pushRunFor, readerOrRefuse, scopeOf, setBounded, type CommitsRouterOptions } from './commits.js';

/**
 * GET /api/apps/:app/commits/:sha/run — the jobs of the workflow run behind one commit, for the
 * commit page's CI stage (SHP-T-13.4, SHP-REQ-157, SHP-ADR-007). Read-only, same actor rules as
 * `/commits`.
 *
 * This is the only place Shipyard asks GitHub for a run's jobs, and only when a person opens the
 * page. The commits poll never does (it would put Home's 30 s refresh at ~4,600 of GitHub's 5,000
 * calls an hour), and nothing here runs from a timer, a queue or any background loop (SHP-REQ-168).
 */

const SHA_LOWER_RE = /^[0-9a-f]{40}$/;

/**
 * How long an unfinished run's lookup and jobs are reused: long enough that a person refreshing
 * the page does not spend a GitHub call each time, short enough that they see progress.
 */
const IN_PROGRESS_TTL_MS = 15_000;

export type JobState = 'success' | 'failure' | 'running' | 'queued' | 'skipped' | 'cancelled';

export interface RunJob {
  id: number;
  name: string;
  state: JobState;
  startedAt: string | null;
  completedAt: string | null;
  /** completedAt − startedAt; null until the job has both. */
  durationMs: number | null;
  url: string | null;
}

export interface RunSummary {
  id: number;
  url: string | null;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunResponse {
  /** Null when no push-to-default-branch run exists for the SHA (a pull-request-only or unbuilt commit). */
  run: RunSummary | null;
  jobs: RunJob[];
}

/** GitHub's job status and conclusion as one of the six states the lane draws. */
export function jobStateOf(status: string, conclusion: string | null): JobState {
  if (status === 'in_progress') return 'running';
  if (status !== 'completed') return 'queued';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
    case 'neutral':
      return 'skipped';
    default:
      // failure, timed_out, startup_failure, action_required, or a completed job with no conclusion.
      return 'failure';
  }
}

function durationOf(startedAt: string | null, completedAt: string | null): number | null {
  if (startedAt === null || completedAt === null) return null;
  const ms = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function toRunJob(job: WorkflowJob): RunJob {
  return {
    id: job.id,
    name: job.name,
    state: jobStateOf(job.status, job.conclusion),
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    durationMs: durationOf(job.startedAt, job.completedAt),
    url: job.url,
  };
}

/** `expiresAt: null` is a completed run's jobs, which never change. */
interface Cached<V> {
  expiresAt: number | null;
  value: V;
}

function fresh<V>(entry: Cached<V> | undefined, now: number): V | undefined {
  if (entry === undefined) return undefined;
  return entry.expiresAt === null || entry.expiresAt > now ? entry.value : undefined;
}

/**
 * The production port: the commits route's, plus `runJobs`, which `liveGitHub` does not forward.
 * The token is read per call (env, then Settings), as `liveGitHub` does; a call here is a person
 * opening a page, so one extra settings read is affordable.
 */
function liveRunGitHub(deps: ServiceDeps): GitHubPort {
  return {
    ...liveGitHub(deps),
    runJobs: async (repo, runId) => {
      const { token } = await resolveGitHubToken(deps);
      return createGitHubAdapter(token === null ? {} : { token }).runJobs(repo, runId);
    },
  };
}

export function runRouter(deps: ServiceDeps, options: CommitsRouterOptions = {}): Router {
  const { db } = deps;
  const github = options.github ?? liveRunGitHub(deps);
  const router = Router();
  // Which run a commit means: a run list per workflow+SHA, kept briefly so a refresh is free.
  const lookups = new Map<string, Cached<WorkflowRun | null>>();
  // A run's jobs. Keyed on the run id plus its completion time: a re-run of a finished workflow
  // keeps the run id but gets a new `updated_at`, so it must not be served the first attempt's jobs.
  const jobsCache = new Map<string, Cached<RunJob[]>>();

  router.get('/:app/commits/:sha/run', async (req, res) => {
    if (!readerOrRefuse(req, res)) return;
    const name = req.params['app'];
    const sha = req.params['sha'];
    const scope = scopeOf(req);
    if (typeof sha !== 'string' || !SHA_LOWER_RE.test(sha)) {
      sendRefusal(res, refusal('invalid_request', 'sha must be a 40-character lowercase hex commit SHA.'));
      return;
    }
    const notFound = refusal('not_found', `No app named ${name}.`, 'List the apps and use one of their names.');
    if (typeof name !== 'string' || (scope !== undefined && !scope.has(name))) {
      sendRefusal(res, notFound);
      return;
    }
    const row = await db.app.findUnique({ where: { name }, select: { repo: true, defaultBranch: true, manifestYaml: true } });
    if (row === null) {
      sendRefusal(res, notFound);
      return;
    }
    // A Shipyard-built app has no workflow run to show: its progress is its builds (SHP-REQ-134).
    const workflow = buildSourceOf(row.manifestYaml) === 'shipyard' ? null : parseWorkflow(row.manifestYaml);
    if (row.repo === null || row.defaultBranch === null || workflow === null) {
      sendRefusal(
        res,
        refusal(
          'invalid_request',
          `${name} has no GitHub workflow run to show.`,
          'Only an app with a repo, a default branch and a workflow in its manifest, built by GitHub, has one.',
        ),
      );
      return;
    }
    const { repo, defaultBranch } = row;

    try {
      const now = Date.now();
      const lookupKey = `${repo}/${workflow}@${sha}`;
      let run = fresh(lookups.get(lookupKey), now);
      if (run === undefined) {
        run = await pushRunFor(github, repo, workflow, sha, defaultBranch);
        setBounded(lookups, lookupKey, { expiresAt: now + IN_PROGRESS_TTL_MS, value: run });
      }
      if (run === null) {
        res.json({ run: null, jobs: [] } satisfies RunResponse);
        return;
      }

      const completed = run.status === 'completed';
      const jobsKey = `${String(run.id)}@${completed ? (run.completedAt ?? 'completed') : 'running'}`;
      let jobs = fresh(jobsCache.get(jobsKey), now);
      if (jobs === undefined) {
        if (github.runJobs === undefined) {
          throw new SequenceRefusalError(refusal('github_unreachable', 'GitHub workflow jobs are unavailable.'));
        }
        jobs = (await github.runJobs(repo, run.id)).map(toRunJob);
        setBounded(jobsCache, jobsKey, { expiresAt: completed ? null : now + IN_PROGRESS_TTL_MS, value: jobs });
      }

      res.json({
        run: {
          id: run.id,
          url: run.url ?? null,
          status: run.status,
          conclusion: run.conclusion,
          startedAt: run.startedAt ?? null,
          completedAt: run.completedAt ?? null,
        },
        jobs,
      } satisfies RunResponse);
    } catch (error) {
      // Fail closed: a page that cannot see GitHub says so, rather than showing a guess.
      if (error instanceof SequenceRefusalError) {
        sendRefusal(res, error.refusal);
        return;
      }
      throw error;
    }
  });

  return router;
}
