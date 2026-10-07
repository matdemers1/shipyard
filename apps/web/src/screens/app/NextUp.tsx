import { Link, Section, Stack } from '@d3cloud/ui';
import { Link as RouterLink } from 'react-router-dom';
import { PipeLane, commitStages } from '../../components/pipeline';
import { StatusLine } from '../../components/StatusLine';
import { nextUpCommit, sha7, type AppDetail } from '../../lib/appdetail';
import type { AppStatus } from '../../lib/appstatus';
import type { CommitsInfo, PendingApproval } from '../../lib/home';

/**
 * "Next up" (SHP-T-13.12, SHP-REQ-163): the app's state in a sentence, then the lane of the commit
 * that would deploy next — Push, CI, Images, Checks, Deploy, Live — and a way to its commit page.
 * With nothing ready it follows the newest commit waiting, so a running CI is visible here too;
 * with nothing waiting it is the sentence alone ("Up to date").
 */
export function NextUp({
  detail,
  status,
  commits,
  approval,
}: {
  detail: AppDetail;
  status: AppStatus;
  commits: CommitsInfo | null;
  approval: PendingApproval | undefined;
}) {
  const commit = commits?.source === 'github' ? nextUpCommit(commits, detail.liveSha) : null;
  if (commit === null) {
    return (
      <Section title="Next up">
        <StatusLine status={status} />
      </Section>
    );
  }
  const firstLine = commit.message.split('\n')[0] ?? commit.message;
  const stages = commitStages({
    commit,
    liveSha: detail.liveSha,
    branch: detail.defaultBranch,
    ...(commits?.buildSource !== undefined ? { buildSource: commits.buildSource } : {}),
    // A deploy of this commit waiting on a deployer is the one thing in flight the page knows the SHA of.
    deploy:
      approval !== undefined && approval.sha === commit.sha
        ? { state: 'awaiting_approval', ...(detail.soakSeconds !== null ? { soakSeconds: detail.soakSeconds } : {}) }
        : null,
  });
  return (
    <Section
      title={
        <>
          Next up · <code>{sha7(commit.sha)}</code> <span className="shp-commit-msg">{firstLine}</span>
        </>
      }
    >
      <Stack gap="16">
        <StatusLine status={status} />
        <PipeLane stages={stages} label={`Pipeline for ${sha7(commit.sha)}`} />
        <Link asChild>
          <RouterLink to={`/apps/${encodeURIComponent(detail.name)}/commits/${commit.sha}`}>Open commit page →</RouterLink>
        </Link>
      </Stack>
    </Section>
  );
}
