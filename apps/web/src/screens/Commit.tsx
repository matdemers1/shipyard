import {
  Alert,
  Badge,
  Button,
  DataList,
  DataListRow,
  EmptyState,
  Link,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { DryRunSheet, type SheetAction } from '../components/DryRunSheet';
import { PipeLane, commitStages } from '../components/pipeline';
import { agoShort, formatSpan } from '../components/pipeline/stages';
import { RefusalError, request, unreachableRefusal } from '../lib/api';
import { appDetail, freeze as freezeApi, when, type AppDetail } from '../lib/appdetail';
import { appStatus, ciTone, sha7, type StatusTone } from '../lib/appstatus';
import { useCan } from '../lib/auth';
import {
  FULL_SHA,
  JOB_STATE_WORDS,
  commitDeploy,
  failedJob,
  fetchRunJobs,
  imageRefs,
  imageVerification,
  jobSpan,
  timeline,
  workflowName,
  type RunJob,
  type RunJobs,
} from '../lib/commit';
import { STATUS_WORDS, ciWords, deployVerb } from '../lib/words';
import type { CommitEntry, CommitsInfo, PendingApproval } from '../lib/home';

/**
 * One commit's journey, `/apps/:app/commits/:sha` (SHP-T-13.9, SHP-REQ-156, SHP-REQ-157,
 * SHP-REQ-158): the six-stage lane, the GitHub Actions jobs with a timeline bar linked to the run,
 * the commits that deploy with it and its images — Expected until a dry run or deploy has verified
 * their digests. A red commit leads with the verdict and offers no Deploy; job logs are not
 * available from the API, so the page links out to GitHub for them.
 */

type Load =
  | { status: 'loading' }
  | { status: 'error'; error: RefusalError }
  | {
      status: 'ready';
      detail: AppDetail;
      /** Null when the commits could not be read at all. */
      commits: CommitsInfo | null;
      frozen: boolean;
      approval: PendingApproval | undefined;
    };

type Jobs =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: RunJobs }
  | { status: 'error'; error: RefusalError };

const firstLine = (message: string): string => message.split('\n')[0] ?? message;

/** The commit's own page, which a row anywhere in the console links to. */
export const commitPath = (app: string, sha: string): string => `/apps/${encodeURIComponent(app)}/commits/${sha}`;

/**
 * A link to GitHub, in a new tab. `inline` underlines it, for one that sits inside running text: a
 * link told apart from the words around it by colour alone fails WCAG 1.4.1 (axe, SHP-T-13.14).
 */
function External({ href, inline = false, children }: { href: string; inline?: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} target="_blank" rel="noreferrer" {...(inline ? { variant: 'inline' as const } : {})}>
      {children} ↗
    </Link>
  );
}

function CommitSkeleton({ app, sha }: { app: string; sha: string }) {
  return (
    <Page aria-busy="true">
      <Stack gap="24">
        <PageHeader title={`Commit ${sha7(sha)}`} description={`Reading ${app}.`} />
        <span role="status" className="shp-visually-hidden">
          Loading commit {sha7(sha)}
        </span>
        <Skeleton variant="block" height={96} />
        <Skeleton variant="text" lines={5} />
      </Stack>
    </Page>
  );
}

function Crumbs({ app, sha }: { app: string; sha: string }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="shp-crumbs">
        <li>
          <Link asChild>
            <RouterLink to="/">Apps</RouterLink>
          </Link>
        </li>
        <li>
          <Link asChild>
            <RouterLink to={`/apps/${encodeURIComponent(app)}`}>{app}</RouterLink>
          </Link>
        </li>
        <li aria-current="page">{sha7(sha)}</li>
      </ol>
    </nav>
  );
}

/** Where a commit stands, as the badge beside its title. */
function badgeFor(entry: CommitEntry, live: boolean, ready: boolean, source: 'github' | 'shipyard'): { tone: StatusTone; label: string } {
  if (live) return { tone: 'neutral', label: 'Live' };
  if (ready) return { tone: 'attention', label: STATUS_WORDS.ready };
  return { tone: ciTone(entry.ci), label: ciWords(entry.ci, source) };
}

export function Commit() {
  const { app = '', sha = '' } = useParams();
  const can = useCan();
  const navigate = useNavigate();
  const valid = FULL_SHA.test(sha);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [jobs, setJobs] = useState<Jobs>({ status: 'idle' });
  const [sheet, setSheet] = useState<SheetAction | null>(null);
  const [reloads, setReloads] = useState(0);
  const [jobReloads, setJobReloads] = useState(0);

  const reload = useCallback(() => {
    setReloads((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!valid) return;
    setLoad({ status: 'loading' });
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all([
      appDetail.get(app, signal),
      request<CommitsInfo>(`/api/apps/${encodeURIComponent(app)}/commits`, { signal }).catch(() => null),
      // A freeze refuses new deploys, so the page does not offer one; reading it must not break the page.
      // Both reads fail open (no freeze, no approval): the server refuses a deploy it should not run anyway.
      freezeApi
        .get(app, signal)
        .then((r) => r.freeze !== null)
        .catch(() => false),
      request<PendingApproval[]>('/api/approvals', { signal }).catch(() => [] as PendingApproval[]),
    ])
      .then(([detail, commits, frozen, approvals]) => {
        setLoad({ status: 'ready', detail, commits, frozen, approval: approvals.find((a) => a.app === app) });
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        setLoad({ status: 'error', error: error instanceof RefusalError ? error : unreachableRefusal() });
      });
    return () => {
      controller.abort();
    };
  }, [app, sha, valid, reloads]);

  // Which commit this is, once the app and its commits are known.
  const found = useMemo(() => {
    if (load.status !== 'ready') return null;
    const { detail, commits } = load;
    const entries = commits?.commits ?? [];
    const index = entries.findIndex((c) => c.sha === sha);
    const live = detail.liveSha === sha;
    if (index === -1 && !live) return null;
    const entry: CommitEntry = index >= 0 ? (entries[index] as CommitEntry) : { sha, message: '', ci: 'success', taskIds: [] };
    return { entry, index, live, entries };
  }, [load, sha]);

  const source = load.status === 'ready' ? (load.commits?.buildSource ?? 'github') : 'github';

  // The run's jobs, once, when the page opens (SHP-REQ-157): one call for this commit and nothing else
  // (SHP-ADR-007). Not for a `build: shipyard` app, which has no run; not for the live commit, which is
  // no longer waiting; not when the commits could not be read, so there is no commit to ask about.
  const wantJobs =
    load.status === 'ready' && load.commits?.source === 'github' && found !== null && !found.live && source === 'github';
  useEffect(() => {
    if (!wantJobs) {
      setJobs({ status: 'idle' });
      return;
    }
    setJobs({ status: 'loading' });
    const controller = new AbortController();
    fetchRunJobs(app, sha, controller.signal)
      .then((data) => {
        setJobs({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setJobs({ status: 'error', error: error instanceof RefusalError ? error : unreachableRefusal() });
      });
    return () => {
      controller.abort();
    };
  }, [app, sha, wantJobs, jobReloads]);

  const riders = useMemo(() => (found === null ? [] : found.entries.slice(0, Math.max(found.index, 0))), [found]);

  if (!valid) {
    return <NotWaiting app={app} sha={sha} reason="That is not a full commit SHA: forty lower-case hex characters." />;
  }
  if (load.status === 'loading') return <CommitSkeleton app={app} sha={sha} />;

  if (load.status === 'error') {
    const { error } = load;
    return (
      <Page>
        <Stack gap="24">
          <Crumbs app={app} sha={sha} />
          <PageHeader title={`Commit ${sha7(sha)}`} />
          <EmptyState
            kind={error.status === 404 ? 'no-results' : 'error'}
            heading={error.message}
            headingLevel={2}
            action={
              <Button type="button" onClick={reload}>
                Try again
              </Button>
            }
          >
            {error.fix}
          </EmptyState>
        </Stack>
      </Page>
    );
  }

  const { detail, commits } = load;
  if (commits === null || commits.source === 'unavailable') {
    return (
      <Page>
        <Stack gap="24">
          <Crumbs app={app} sha={sha} />
          <PageHeader title={`Commit ${sha7(sha)}`} />
          <EmptyState
            kind="error"
            heading="Shipyard could not read this app's commits"
            headingLevel={2}
            action={
              <Button type="button" onClick={reload}>
                Try again
              </Button>
            }
          >
            {commits === null
              ? 'The commit list did not load. Try again in a moment.'
              : 'Shipyard could not reach GitHub, so it cannot say where this commit stands. Its checks fail closed; it tries again shortly.'}
          </EmptyState>
        </Stack>
      </Page>
    );
  }

  if (found === null) {
    return <NotWaiting app={app} sha={sha} reason={`${sha7(sha)} is not live and is not waiting on ${detail.defaultBranch ?? 'the default branch'}.`} />;
  }

  const { entry, index, live } = found;
  const shipyard = source === 'shipyard';
  const runJobs = jobs.status === 'ready' ? jobs.data : null;
  const failing = runJobs === null ? null : failedJob(runJobs.jobs);
  const verification = imageVerification(detail, sha);
  const status = appStatus({ ...detail, commits, approval: load.approval, frozen: load.frozen });
  const ready = status.shipSha === sha;
  const deploy = commitDeploy(detail, sha);
  const now = Date.now();

  const stages = commitStages({
    commit: entry,
    branch: detail.defaultBranch,
    liveSha: detail.liveSha,
    buildSource: source,
    verifiedDigests: verification.verified,
    failedJob: failing?.name ?? null,
    deploy,
    now,
  });

  const badge = badgeFor(entry, live, ready, source);
  const title = firstLine(entry.message) || `Commit ${sha7(sha)}`;
  const pushedAt = entry.run?.startedAt ?? null;
  const red = entry.ci === 'failure' && !live;
  const includes = Math.max(1, Math.max(commits.ahead ?? 0, found.entries.length) - (found.entries.length - index - 1));
  const olderHidden = Math.max(0, includes - 1 - Math.max(index, 0));
  const newer = index >= 0 ? found.entries.slice(index + 1) : [];
  const liveWords = detail.liveSha === null ? 'Nothing is live yet.' : `Live ${sha7(detail.liveSha)} is unaffected.`;

  return (
    <Page>
      <Stack gap="24">
        <Crumbs app={app} sha={sha} />
        <PageHeader
          title={title}
          description={
            <>
              <code>{sha7(sha)}</code>
              {pushedAt === null ? '' : ` · pushed ${agoShort(pushedAt, now)}`}
              {detail.defaultBranch === null ? '' : ` · ${detail.defaultBranch}`}
              {detail.repo === null ? null : (
                <>
                  {' · '}
                  <External inline href={`https://github.com/${detail.repo}/commit/${sha}`}>View on GitHub</External>
                </>
              )}
            </>
          }
          actions={
            <>
              <Badge tone={badge.tone}>{badge.label}</Badge>
              {can && ready ? (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => {
                    setSheet({ kind: 'deploy', app: detail.name, sha });
                  }}
                >
                  {deployVerb(sha)}
                </Button>
              ) : null}
            </>
          }
        />

        {red ? (
          <Alert
            tone="danger"
            title={`${shipyard ? 'The Shipyard build failed' : failing === null ? 'CI failed' : `CI failed at ${failing.name}`} — there is nothing to deploy from this commit`}
          >
            {liveWords} Push a fix to {detail.defaultBranch ?? 'the default branch'} and Shipyard will pick it up.
          </Alert>
        ) : null}

        <Section
          title="Journey"
          description={live ? 'Push to live — this commit is live.' : `Push to live — ${plural(includes, 'commit')} ahead of live`}
        >
          <PipeLane stages={stages} label={`Journey of ${sha7(sha)}`} />
        </Section>

        {shipyard ? (
          <ShipyardBuild entry={entry} />
        ) : live ? (
          <Section title="CI" description="The jobs of a commit's run are fetched for commits waiting to deploy.">
            <p className="shp-status__detail">
              This commit is live, so Shipyard does not ask GitHub for its run.
              {detail.repo === null ? null : (
                <>
                  {' '}
                  <External inline href={`https://github.com/${detail.repo}/commit/${sha}`}>View on GitHub</External>
                </>
              )}
            </p>
          </Section>
        ) : (
          <CiSection
            jobs={jobs}
            detail={detail}
            ci={entry.ci}
            entryRun={entry.run ?? null}
            onRetry={() => {
              setJobReloads((n) => n + 1);
            }}
            now={now}
          />
        )}

        <ImagesSection detail={detail} sha={sha} ci={entry.ci} live={live} verification={verification} shipyard={shipyard} />

        {live || red ? null : (
          <Section
            title="Deploys with it"
            description={
              detail.liveSha === null
                ? 'Nothing is live yet.'
                : `${plural(Math.max(index, 0) + olderHidden, 'commit')} — everything between live ${sha7(detail.liveSha)} and this commit deploys together.`
            }
          >
            <Stack gap="12">
              <DataList aria-label="Commits that deploy with this one" empty={<span className="shp-status__detail">Nothing else: this is the only commit between live and itself.</span>}>
                {[...riders].reverse().map((r) => (
                  <RiderRow key={r.sha} app={app} entry={r} rideWith={sha} source={source} />
                ))}
              </DataList>
              {olderHidden > 0 ? (
                <p className="shp-status__detail">{`${String(olderHidden)} older commit${olderHidden === 1 ? '' : 's'} not shown; they deploy too.`}</p>
              ) : null}
              {newer.length > 0 ? (
                <ul className="shp-commit-newer" aria-label="Not included">
                  {newer.map((n) => (
                    <li key={n.sha}>
                      Not included:{' '}
                      <Link asChild>
                        <RouterLink to={commitPath(app, n.sha)}>
                          <code>{sha7(n.sha)}</code>
                        </RouterLink>
                      </Link>{' '}
                      “{firstLine(n.message)}” — newer, {newerWords(n, source)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Stack>
          </Section>
        )}
      </Stack>

      <DryRunSheet
        open={sheet !== null}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
        action={sheet}
        onStarted={(deployId) => {
          setSheet(null);
          void navigate(`/deploys/${deployId}/live`);
        }}
      />
    </Page>
  );
}

function plural(n: number, one: string): string {
  return `${String(n)} ${one}${n === 1 ? '' : 's'}`;
}

/** "CI running", "CI passed", "no images yet": why a newer commit is not in this deploy. */
function newerWords(c: CommitEntry, source: 'github' | 'shipyard'): string {
  if (c.ci === 'none') return source === 'shipyard' ? 'not built yet' : 'no images yet';
  const words = ciWords(c.ci, source);
  return words.startsWith('CI') ? words : words.toLowerCase();
}

function NotWaiting({ app, sha, reason }: { app: string; sha: string; reason: string }) {
  return (
    <Page width="narrow">
      <Stack gap="24">
        <Crumbs app={app} sha={sha} />
        <PageHeader title={`Commit ${sha7(sha)}`} />
        <EmptyState
          kind="no-results"
          heading="This commit is not waiting"
          headingLevel={2}
          action={
            <Link asChild>
              <RouterLink to={`/apps/${encodeURIComponent(app)}`}>Back to {app}</RouterLink>
            </Link>
          }
        >
          {reason} Commits that are live, or ahead of live on the default branch, have a page.
        </EmptyState>
      </Stack>
    </Page>
  );
}

function RiderRow({
  app,
  entry,
  rideWith,
  source,
}: {
  app: string;
  entry: CommitEntry;
  rideWith: string;
  source: 'github' | 'shipyard';
}) {
  const failed = entry.ci === 'failure';
  const run = source === 'github' ? (entry.run ?? null) : null;
  const marker =
    ciWords(entry.ci, source);
  return (
    <DataListRow
      truncate={false}
      title={
        <Link asChild>
          <RouterLink to={commitPath(app, entry.sha)} className="shp-commit-msg">
            {firstLine(entry.message)}
          </RouterLink>
        </Link>
      }
      description={
        <>
          <code>{sha7(entry.sha)}</code>
          {entry.taskIds.length > 0 ? ` · ${entry.taskIds.join(', ')}` : ''}
          {failed ? (
            <span className="shp-commit-note" data-tone="warning">
              Rides along with {sha7(rideWith)}. Its own {source === 'shipyard' ? 'build' : 'run'} failed, so read why before you deploy.
            </span>
          ) : null}
        </>
      }
      meta={
        <span className="shp-commit-ci" data-ci={entry.ci}>
          {marker}
          {run?.url ? (
            <>
              {' · '}
              <External inline href={run.url}>run #{String(run.id)}</External>
            </>
          ) : null}
          {source === 'shipyard' && entry.buildId !== undefined ? (
            <>
              {' · '}
              <Link asChild>
                <RouterLink to={`/builds/${entry.buildId}`}>build</RouterLink>
              </Link>
            </>
          ) : null}
        </span>
      }
    />
  );
}

/** The CI section of a `build: shipyard` app: there are no GitHub Actions jobs, only the Shipyard build. */
function ShipyardBuild({ entry }: { entry: CommitEntry }) {
  return (
    <Section title="Build" description="Shipyard builds this app itself, so there are no GitHub Actions jobs to list.">
      <p className="shp-status__detail">
        {entry.buildId === undefined ? (
          'Shipyard has not built this commit yet.'
        ) : (
          <>
            {ciWords(entry.ci, 'shipyard')}.{' '}
            <Link asChild>
              <RouterLink to={`/builds/${entry.buildId}`}>Open the build</RouterLink>
            </Link>{' '}
            for its stages.
          </>
        )}
      </p>
    </Section>
  );
}

function CiSection({
  jobs,
  detail,
  ci,
  entryRun,
  onRetry,
  now,
}: {
  jobs: Jobs;
  detail: AppDetail;
  ci: CommitEntry['ci'];
  entryRun: CommitEntry['run'];
  onRetry: () => void;
  now: number;
}) {
  if (jobs.status === 'idle' || jobs.status === 'loading') {
    return (
      <Section title="CI" description="Fetching this commit's jobs from GitHub.">
        <div aria-busy="true">
          <span role="status" className="shp-visually-hidden">
            Loading jobs
          </span>
          <Skeleton variant="text" lines={4} />
        </div>
      </Section>
    );
  }

  if (jobs.status === 'error') {
    return (
      <Section title="CI" description="The jobs of this commit's run, from GitHub.">
        <Alert
          tone="warning"
          title={jobs.error.message}
          actions={
            <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          }
        >
          {jobs.error.fix}
          {entryRun?.url ? (
            <>
              {' '}
              <External inline href={entryRun.url}>Open run #{String(entryRun.id)}</External>
            </>
          ) : null}
        </Alert>
      </Section>
    );
  }

  const { run, jobs: list } = jobs.data;
  if (run === null) {
    return (
      <Section title="CI" description="The jobs of this commit's run, from GitHub.">
        <EmptyState kind="empty" heading="No GitHub Actions run for this commit" size="inline">
          GitHub runs the image workflow once per push, for the newest commit in it. This one has no run of its own.
        </EmptyState>
      </Section>
    );
  }

  const failing = failedJob(list);
  const took = run.startedAt !== null && run.completedAt !== null ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : null;
  const elapsed = run.startedAt !== null ? now - Date.parse(run.startedAt) : null;
  const verdict =
    ci === 'success'
      ? `Passed${took === null ? '' : ` in ${formatSpan(took)}`}`
      : ci === 'failure'
        ? `Failed${took === null ? '' : ` after ${formatSpan(took)}`}`
        : `Running${elapsed === null ? '' : ` for ${formatSpan(elapsed)}`}`;
  const workflow = workflowName(detail);
  const facts = [
    verdict,
    [workflow, `push to ${detail.defaultBranch ?? 'the default branch'}`].filter((p) => p !== null).join(' · '),
    run.startedAt === null ? null : `started ${agoShort(run.startedAt, now)}`,
    plural(list.length, 'job'),
  ].filter((p): p is string => p !== null && p !== '');
  const track = timeline(run, list, now);

  return (
    <Section
      title={`CI · run #${String(run.id)}`}
      description={facts.join(' · ')}
      actions={run.url ? <External href={run.url}>Open run on GitHub</External> : undefined}
    >
      <Stack gap="12">
        {failing !== null ? (
          <Alert tone="danger" title={`Failed at ${failing.name} · ${jobSpan(failing)}`}>
            <span className="shp-action-row">
              {run.url ? <External href={run.url}>Open run #{String(run.id)}</External> : null}
              {failing.url ? <External href={failing.url}>Full log on GitHub</External> : null}
            </span>
          </Alert>
        ) : null}
        {track !== null ? (
          <div className="shp-job-axis" aria-hidden="true">
            {track.ticks.map((t) => (
              <span key={t.label} style={{ left: `${String(t.at)}%` }} data-edge={t.at === 0 ? 'start' : undefined}>
                {t.label}
              </span>
            ))}
          </div>
        ) : null}
        <ul className="shp-jobs" aria-label="Jobs">
          {list.map((job) => (
            <JobRow key={job.id} job={job} failing={failing} track={track} />
          ))}
        </ul>
        <p className="shp-status__detail">Job detail is fetched when you open this page and cached by run — Shipyard never polls jobs.</p>
      </Stack>
    </Section>
  );
}

function JobRow({ job, failing, track }: { job: RunJob; failing: RunJob | null; track: ReturnType<typeof timeline> }) {
  const bar = track?.bars.get(job.id);
  const span = jobSpan(job);
  const skippedWhy = job.state === 'skipped' && failing !== null ? ` — ${failing.name} failed` : '';
  const label =
    bar === undefined || track === null
      ? `${job.name}: ${JOB_STATE_WORDS[job.state].toLowerCase()}`
      : `${job.name}: ${span}, ${JOB_STATE_WORDS[job.state].toLowerCase()}, from ${formatSpan((bar.left / 100) * track.totalMs)} into the run`;
  const body = (
    <>
      <div className="shp-job__head">
        <span className="shp-job__name">
          {job.name}
          {job.url ? <span aria-hidden="true"> ↗</span> : null}
        </span>
        <span className="shp-job__time">{span}</span>
        <span className="shp-job__state">
          {JOB_STATE_WORDS[job.state]}
          {skippedWhy}
        </span>
      </div>
      <div className="shp-job__track">
        {bar === undefined ? null : (
          <span
            className="shp-job__bar"
            role="img"
            aria-label={label}
            title={label}
            style={{ left: `${String(bar.left)}%`, width: `${String(bar.width)}%` }}
          />
        )}
      </div>
    </>
  );
  return (
    <li className="shp-job" data-state={job.state}>
      {job.url ? (
        // The name and its bar are one link to the job on GitHub, so the bar is linked to the run too.
        <a
          className="shp-job__link"
          href={job.url}
          target="_blank"
          rel="noreferrer"
          aria-label={job.durationMs === null ? job.name : `${job.name} ${span}`}
        >
          {body}
        </a>
      ) : (
        body
      )}
    </li>
  );
}

function ImagesSection({
  detail,
  sha,
  ci,
  live,
  verification,
  shipyard,
}: {
  detail: AppDetail;
  sha: string;
  ci: CommitEntry['ci'];
  live: boolean;
  verification: ReturnType<typeof imageVerification>;
  shipyard: boolean;
}) {
  const refs = imageRefs(detail, sha);
  const names = refs.map((r) => r.service).join(' · ');
  const builder = shipyard ? 'the Shipyard build' : 'green CI';

  let lead: string;
  let sub: string;
  if (verification.verified) {
    lead = 'Verified';
    sub = `${verification.by ?? 'Digests verified'}. The agent saw these digests in GHCR.`;
  } else if (ci === 'failure' && !live) {
    lead = 'Not built';
    sub = shipyard ? 'Nothing was built.' : 'Nothing was pushed to GHCR.';
  } else if (ci === 'success') {
    lead = 'Expected';
    sub = `Expected from ${builder}; verified on deploy.`;
  } else if (ci === 'pending') {
    lead = 'After CI';
    sub = `Expected once ${shipyard ? 'the build passes' : 'CI is green'}.`;
  } else {
    lead = 'No images';
    sub = shipyard
      ? 'Shipyard has not built this commit; it deploys inside the next built commit above it.'
      : 'GitHub builds images once per push, for the newest commit in it; this one deploys inside the next green commit above it.';
  }
  const showRefs = ci !== 'failure' || live;

  return (
    <Section title="Images" description={`${lead}${names === '' || !showRefs ? '' : ` — ${names}`} — ${sub}`}>
      <Stack gap="12">
        {showRefs && refs.length > 0 ? (
          <DataList aria-label="Images">
            {refs.map((r) => (
              <DataListRow
                key={r.service}
                truncate={false}
                title={
                  <code className="shp-image-ref" title={r.fullRef}>
                    {r.ref}
                  </code>
                }
                description={
                  verification.verified
                    ? verifiedWords(verification, r.service)
                    : ci === 'success'
                      ? 'Expected · digest not yet verified'
                      : 'Not yet built'
                }
              />
            ))}
          </DataList>
        ) : null}
        {verification.verified || ci === 'failure' ? null : (
          <p className="shp-status__detail">
            Expected means GitHub reported a green run for this commit, so its images should be in GHCR. Only the agent checks GHCR, on the host,
            when you dry-run or deploy; until then Shipyard has not seen the digests.
          </p>
        )}
      </Stack>
    </Section>
  );
}

/** "Verified · sha256:abc…", or, when the target kept no digest (a dry run's are not stored), when it was verified. */
function verifiedWords(v: ReturnType<typeof imageVerification>, service: string): string {
  const digest = v.digests[service];
  if (digest !== undefined) return `Verified · ${digest.slice(0, 19)}`;
  // Say what verified it — a deploy, the live release or a dry run — never assume it was a dry run.
  const by = v.by ?? 'Verified';
  return v.at === null ? by : `${by} · ${when(v.at)}`;
}
