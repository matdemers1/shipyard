import { Badge, Button, IconButton, Link, Menu, MenuContent, MenuItem, MenuTrigger } from '@d3cloud/ui';
import type { GroupSummary } from '@shipyard/schema';
import { Ellipsis } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { newestWithRun, sha7, type AppStatus } from '../lib/appstatus';
import type { CommitEntry, HomeApp, PendingApproval } from '../lib/home';
import { ciWords, deployVerb, stateWords } from '../lib/words';
import type { SheetAction } from './DryRunSheet';
import { PipeMini, commitStages, type CommitDeploy } from './pipeline';
import { agoShort } from './pipeline/stages';

/**
 * One app, one row (SHP-T-13.8, SHP-REQ-155): name and repository, live → the commit that would
 * deploy, the pipeline lane for that commit, one state with a one-line why, and at most one primary
 * action. On a desktop the parts sit in fixed columns so they line up down the list; on a phone
 * they stack — name and badge, SHAs and lane, why, then a full-width action — and nothing scrolls
 * sideways at 390 px. Every row has the same shape whatever its state, so a refresh never moves one.
 */

export interface AppRowProps {
  app: HomeApp;
  status: AppStatus;
  /** This app's deploy waiting on approval, if any. */
  approval: PendingApproval | undefined;
  /** Every group the agent reported; the row names the ones this app belongs to. */
  groups: readonly GroupSummary[];
  /** False for a viewer: no deploy or review (SHP-REQ-105). */
  canDeploy: boolean;
  onAction: (action: SheetAction) => void;
  now?: number;
}

/** The commits Shipyard read from GitHub, oldest first; none when GitHub was unreachable. */
function entriesOf(app: HomeApp): CommitEntry[] {
  return app.commits?.source === 'github' ? app.commits.commits : [];
}

/**
 * The commit the row is about: the one an approval names, else the one Deploy would deploy, else
 * the newest waiting, else what is live. Null for an app with nothing recorded at all.
 */
export function rowCommit(app: HomeApp, status: AppStatus, approval: PendingApproval | undefined): CommitEntry | null {
  const entries = entriesOf(app);
  const sha = approval?.sha ?? status.shipSha ?? entries[entries.length - 1]?.sha ?? app.liveSha;
  if (sha === null) return null;
  const found = entries.find((c) => c.sha === sha);
  if (found !== undefined) return found;
  // Live went through the whole lane, and an approval is only requested for a green commit; the
  // commits list does not carry either once it is behind live.
  return { sha, message: '', ci: 'success', taskIds: [] };
}

/** How many commits ahead of live come after the row's commit: they wait for a later one. */
function waitingAfter(app: HomeApp, sha: string): number {
  const entries = entriesOf(app);
  const index = entries.findIndex((c) => c.sha === sha);
  return index === -1 ? 0 : entries.length - index - 1;
}

/** The deploy of the row's commit the lane draws, when one is waiting or under way. */
function laneDeploy(app: HomeApp, status: AppStatus, approval: PendingApproval | undefined): CommitDeploy | null {
  if (approval !== undefined) return { state: 'awaiting_approval' };
  if (status.kind === 'deploying' && app.active !== null) return { state: app.active.state as CommitDeploy['state'] };
  return null;
}

function join(parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');
}

/** The run behind a commit's CI, in a few words: "CI passed 1h ago · run #412". */
function runWords(commit: CommitEntry | undefined, source: 'github' | 'shipyard' | undefined, now: number): string {
  if (commit === undefined) return '';
  const run = commit.run ?? null;
  const at = run?.completedAt ?? run?.startedAt ?? null;
  return join([ciWords(commit.ci, source), at === null ? null : agoShort(at, now), run === null ? null : `run #${String(run.id)}`]);
}

/** One line under the badge saying why, in the facts a person checks first. */
export function rowWhy(app: HomeApp, status: AppStatus, approval: PendingApproval | undefined, now: number = Date.now()): string {
  const entries = entriesOf(app);
  const source = app.commits?.buildSource;
  switch (status.kind) {
    case 'ready':
      return runWords(
        entries.find((c) => c.sha === status.shipSha),
        source,
        now,
      );
    case 'deploying':
      return app.active === null ? status.headline : join([app.active.currentStep ?? stateWords(app.active.state), app.active.holder]);
    case 'approval':
      return approval === undefined ? status.headline : `${approval.requester.label} asked ${agoShort(approval.requestedAt, now)}`;
    case 'drift':
      return app.drift === null ? status.headline : `Found ${agoShort(app.drift.detectedAt, now)} · deploys refused`;
    case 'ci-failed':
    case 'ci-running':
      return runWords(newestWithRun(entries), source, now) || status.headline;
    case 'frozen':
      return 'New deploys are refused';
    case 'up-to-date':
      return 'Live is the newest commit';
    default:
      return status.headline;
  }
}

/** "canary · sites group", "sites group": where the row's app deploys with others. */
export function groupWords(app: string, groups: readonly GroupSummary[]): string {
  return join(groups.filter((g) => g.members.includes(app)).map((g) => (g.canary === app ? `canary · ${g.name} group` : `${g.name} group`)));
}

export function AppRow({ app, status, approval, groups, canDeploy, onAction, now = Date.now() }: AppRowProps) {
  const detailHref = `/apps/${encodeURIComponent(app.name)}`;
  const commit = rowCommit(app, status, approval);
  const commitHref = commit === null ? null : `${detailHref}/commits/${commit.sha}`;
  const after = commit === null ? 0 : waitingAfter(app, commit.sha);
  const stages =
    commit === null
      ? null
      : commitStages({
          commit,
          liveSha: app.liveSha,
          ...(app.commits?.buildSource === undefined ? {} : { buildSource: app.commits.buildSource }),
          deploy: laneDeploy(app, status, approval),
          now,
        });
  const why = rowWhy(app, status, approval, now);
  const inGroups = groupWords(app.name, groups);

  let action: ReactNode = null;
  if (status.kind === 'ready' && status.shipSha !== null && canDeploy) {
    const sha = status.shipSha;
    action = (
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={() => {
          onAction({ kind: 'deploy', app: app.name, sha });
        }}
      >
        {deployVerb(sha)}
      </Button>
    );
  } else if (status.kind === 'approval' && approval !== undefined && canDeploy) {
    action = (
      <Button
        type="button"
        variant="primary"
        size="sm"
        aria-label={`Review ${app.name}`}
        onClick={() => {
          onAction({ kind: 'approve', app: app.name, sha: approval.sha, deployId: approval.deployId, requester: approval.requester.label });
        }}
      >
        Review
      </Button>
    );
  } else if (status.kind === 'drift' && canDeploy) {
    action = (
      <Link asChild className="shp-row-link">
        <RouterLink to={detailHref} aria-label={`Resolve ${app.name}`}>
          Resolve
        </RouterLink>
      </Link>
    );
  } else if (status.kind === 'deploying' && app.active !== null) {
    action = (
      <Link asChild className="shp-row-link">
        <RouterLink to={`/deploys/${app.active.deployId}`} aria-label={`Watch ${app.name}`}>
          Watch
        </RouterLink>
      </Link>
    );
  } else if (status.kind === 'ci-failed') {
    const failed = newestWithRun(entriesOf(app));
    const runUrl = failed?.run?.url ?? null;
    action =
      runUrl !== null ? (
        <Link href={runUrl} target="_blank" rel="noreferrer" className="shp-row-link" aria-label={`View run for ${app.name}`}>
          View run ↗
        </Link>
      ) : failed !== undefined ? (
        <Link asChild className="shp-row-link">
          <RouterLink to={`${detailHref}/commits/${failed.sha}`} aria-label={`View run for ${app.name}`}>
            View run
          </RouterLink>
        </Link>
      ) : null;
  }

  return (
    <li className="shp-app-row" data-kind={status.kind}>
      <div className="shp-app-row__name">
        <Link asChild variant="inline">
          <RouterLink to={detailHref}>{app.name}</RouterLink>
        </Link>
        {app.repo === null ? null : <span className="shp-app-row__repo">{app.repo}</span>}
      </div>

      <div className="shp-app-row__sha">
        {commit === null ? (
          <span className="shp-app-row__quiet">Nothing recorded</span>
        ) : (
          <code>
            {app.liveSha !== null && app.liveSha !== commit.sha ? <>{sha7(app.liveSha)} → </> : null}
            {commitHref === null ? (
              sha7(commit.sha)
            ) : (
              <Link asChild variant="inline">
                <RouterLink to={commitHref}>
                  <span className="shp-visually-hidden">Commit</span> {sha7(commit.sha)}
                </RouterLink>
              </Link>
            )}
          </code>
        )}
        {after > 0 ? <span className="shp-app-row__quiet">+{after} waiting</span> : null}
      </div>

      <div className="shp-app-row__lane">{stages === null ? null : <PipeMini stages={stages} />}</div>

      <div className="shp-app-row__badge">
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <p className="shp-app-row__why">
        {why}
        {inGroups === '' ? null : <span className="shp-app-row__group">{inGroups}</span>}
      </p>

      <div className="shp-app-row__action">{action}</div>

      <div className="shp-app-row__more">
        <Menu>
          <MenuTrigger>
            <IconButton icon={<Ellipsis />} label={`More for ${app.name}`} size="sm" variant="ghost" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem asChild>
              <RouterLink to={detailHref}>Open {app.name}</RouterLink>
            </MenuItem>
            {commitHref === null || commit === null ? null : (
              <MenuItem asChild>
                <RouterLink to={commitHref}>Open commit {sha7(commit.sha)}</RouterLink>
              </MenuItem>
            )}
            {canDeploy ? (
              <MenuItem asChild>
                <RouterLink to={`${detailHref}/restore`}>Restore a backup</RouterLink>
              </MenuItem>
            ) : null}
          </MenuContent>
        </Menu>
      </div>
    </li>
  );
}
