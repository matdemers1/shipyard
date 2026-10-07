import { Badge, Button, DataList, DataListRow, Link, Section } from '@d3cloud/ui';
import { Link as RouterLink } from 'react-router-dom';
import { agoShort, formatSpan } from '../../components/pipeline/stages';
import { failedRidingAlong, newestFirst, ridingAlongWarning, sha7 } from '../../lib/appdetail';
import { ciTone, summarizeCommits, type AppStatus } from '../../lib/appstatus';
import type { CommitEntry, CommitsInfo } from '../../lib/home';
import { ciWords, deployVerb } from '../../lib/words';

/**
 * "Waiting on main (N)" (SHP-T-13.12, SHP-REQ-163): the commits since live, newest first. Each
 * names its CI state as a link to the GitHub Actions run behind it ("CI passed · #412 ↗",
 * SHP-REQ-167) and its SHA as a link to its own commit page; a ready one gets a quiet Deploy, the
 * header holding the one primary. The newest ready row warns when deploying it also deploys
 * commits whose own CI failed — they ride along whether anyone meant them to or not.
 */

/** "CI running · 2m 05s · #415", "CI passed · #412": the state, how long it has run, and which run. */
export function ciRunText(commit: CommitEntry, source: CommitsInfo['buildSource'], now: number = Date.now()): string {
  const run = source === 'shipyard' ? null : (commit.run ?? null);
  const parts = [ciWords(commit.ci, source)];
  if (run !== null && commit.ci === 'pending' && run.startedAt !== null) {
    const ran = now - Date.parse(run.startedAt);
    if (!Number.isNaN(ran)) parts.push(formatSpan(ran));
  }
  if (run !== null) parts.push(`#${String(run.id)}`);
  return parts.join(' · ');
}

function CiState({ commit, source }: { commit: CommitEntry; source: CommitsInfo['buildSource'] }) {
  const url = source === 'shipyard' ? null : (commit.run?.url ?? null);
  const text = ciRunText(commit, source);
  if (url === null) return <Badge tone={ciTone(commit.ci)}>{text}</Badge>;
  return (
    <Link href={url} target="_blank" rel="noreferrer" className="shp-commit-ci" data-ci={commit.ci}>
      {text} ↗
    </Link>
  );
}

export function Waiting({
  app,
  branch,
  commits,
  status,
  can,
  onDeploy,
}: {
  app: string;
  branch: string;
  commits: CommitsInfo;
  status: AppStatus;
  can: boolean;
  onDeploy: (sha: string) => void;
}) {
  const summary = summarizeCommits(commits);
  const waiting = newestFirst(commits);
  const ready = status.shipSha;
  const riders = ready === null ? null : ridingAlongWarning(ready, failedRidingAlong(commits, ready));
  return (
    <Section
      title={`Waiting on ${branch} (${String(summary.ahead)})`}
      description={`Commits since live, newest first. Only a commit with built images can be deployed, and deploying it brings everything below it along.${
        summary.ahead > summary.checked ? ` Showing the newest ${String(summary.checked)} of ${String(summary.ahead)}.` : ''
      }`}
    >
      <DataList aria-label="Commits waiting to deploy">
        {waiting.map((c) => {
          const firstLine = c.message.split('\n')[0] ?? c.message;
          const pushed = c.run?.startedAt ?? null;
          return (
            <DataListRow
              key={c.sha}
              truncate={false}
              title={
                c.buildId === undefined ? (
                  <span className="shp-commit-msg">{firstLine}</span>
                ) : (
                  <Link asChild>
                    <RouterLink to={`/builds/${c.buildId}`} className="shp-commit-msg">
                      {firstLine}
                    </RouterLink>
                  </Link>
                )
              }
              description={
                <>
                  {/* The commit's own page: its journey, jobs and images (SHP-T-13.9). */}
                  <Link asChild>
                    <RouterLink to={`/apps/${encodeURIComponent(app)}/commits/${c.sha}`}>
                      <code>{sha7(c.sha)}</code>
                    </RouterLink>
                  </Link>
                  {pushed !== null ? ` · ${agoShort(pushed, Date.now())}` : ''}
                  {c.taskIds.length > 0 ? ` · ${c.taskIds.join(', ')}` : ''}
                  {c.sha === ready ? ' · newest ready' : ''}
                  {c.sha === ready && riders !== null ? (
                    <span className="shp-commit-note" role="note">
                      {riders}
                    </span>
                  ) : null}
                </>
              }
              meta={<CiState commit={c} source={commits.buildSource} />}
              {...(can && c.ci === 'success' && ready !== null
                ? {
                    actions: (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          onDeploy(c.sha);
                        }}
                      >
                        {deployVerb(c.sha)}
                      </Button>
                    ),
                  }
                : {})}
            />
          );
        })}
      </DataList>
      {summary.noRun > 0 ? (
        <p className="shp-status__detail">
          {commits.buildSource === 'shipyard'
            ? '“Not built” means Shipyard has no succeeded build of that commit. It deploys inside the next built commit above it, or you can build it from Builds.'
            : '“No images” is normal: GitHub builds images once per push, for the newest commit in it. Those commits deploy inside the next built commit above them.'}
        </p>
      ) : null}
    </Section>
  );
}
