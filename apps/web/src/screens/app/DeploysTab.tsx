import { Badge, Button, DataList, DataListRow, EmptyState, Link, Section, Stack } from '@d3cloud/ui';
import { Link as RouterLink } from 'react-router-dom';
import { PipeNode, type StageState } from '../../components/pipeline';
import {
  age,
  historyTitle,
  rollbackFor,
  rollbacksOutsideHistory,
  sha7,
  shortDigest,
  took,
  when,
  type AppDetail,
  type DriftState,
  type HistoryTarget,
  type Release,
} from '../../lib/appdetail';
import { stateTone } from '../../lib/appstatus';
import type { BuildSummary } from '../../lib/builds';
import { rollBackVerb, stateWords } from '../../lib/words';
import { BuildRow } from '../Builds';

/**
 * The Deploys tab (SHP-T-13.12, SHP-REQ-163): the last twenty deploys, rollbacks and dry runs as
 * rows, each with its outcome, and "Roll back to <sha>" inline on the earlier releases the agent's
 * ledger would accept — only the targets the server offers, never one the console works out for
 * itself (SHP-D-080, SHP-REQ-063). An offered target older than the twenty rows is listed beneath,
 * so none is lost. Then the app's recent builds, for a `build: shipyard` app, and past drift.
 */

/** A deploy state as the pipeline's node, so a row's mark reads like every other lane. */
function nodeState(state: string): StageState {
  switch (state) {
    case 'succeeded':
      return 'done';
    case 'failed':
    case 'rolled_back':
    case 'refused':
      return 'failed';
    case 'cancelled':
      return 'skipped';
    case 'queued':
    case 'awaiting_approval':
      return 'waiting';
    default:
      return 'running';
  }
}

function RollBackButton({ release, onRollBack }: { release: Release; onRollBack: (r: Release) => void }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={() => {
        onRollBack(release);
      }}
    >
      {rollBackVerb(release.sha)}
    </Button>
  );
}

function HistoryRow({
  t,
  release,
  can,
  onRollBack,
}: {
  t: HistoryTarget;
  release: Release | undefined;
  can: boolean;
  onRollBack: (r: Release) => void;
}) {
  const duration = took(t.startedAt, t.endedAt);
  const reason = t.state === 'refused' ? (t.refusal?.message ?? null) : null;
  return (
    <DataListRow
      truncate={false}
      leading={<PipeNode state={nodeState(t.state)} size="sm" />}
      title={
        <Link asChild>
          <RouterLink to={`/deploys/${t.deployId}`}>{historyTitle(t)}</RouterLink>
        </Link>
      }
      description={
        <>
          {[t.requester, when(t.createdAt), duration].filter((p): p is string => p !== null).join(' · ')}
          {reason !== null ? <span className="shp-app-reason">{reason}</span> : null}
        </>
      }
      meta={<Badge tone={stateTone(t.state)}>{stateWords(t.state)}</Badge>}
      {...(can && release !== undefined ? { actions: <RollBackButton release={release} onRollBack={onRollBack} /> } : {})}
    />
  );
}

export function DeploysTab({
  detail,
  drift,
  builds,
  showBuilds,
  can,
  onRollBack,
}: {
  detail: AppDetail;
  drift: DriftState;
  /** The latest few builds; null when they could not be read. */
  builds: BuildSummary[] | null;
  showBuilds: boolean;
  can: boolean;
  onRollBack: (release: Release) => void;
}) {
  const history = detail.targets;
  const older = rollbacksOutsideHistory(history, detail.rollbackTargets);
  return (
    <Stack gap="24">
      <Section
        title="Deploys"
        description="The last twenty deploys, rollbacks and dry runs. Open one for its steps and output. Roll back puts an earlier release back: only images change, data stays as it is, and the agent checks its own ledger again before it acts."
      >
        <Stack gap="12">
          <DataList
            aria-label="Deploys"
            empty={
              <EmptyState kind="empty" heading="Nothing deployed yet" size="inline">
                Deploys, rollbacks and dry runs of this app appear here.
              </EmptyState>
            }
          >
            {history.map((t) => (
              <HistoryRow
                key={t.id}
                t={t}
                release={t.dryRun ? undefined : rollbackFor(t, detail.rollbackTargets)}
                can={can}
                onRollBack={onRollBack}
              />
            ))}
          </DataList>
          <Link asChild>
            <RouterLink to={`/activity?app=${encodeURIComponent(detail.name)}`}>All deploys, rollbacks and refusals in Activity →</RouterLink>
          </Link>
        </Stack>
      </Section>

      {detail.rollbackTargets.length === 0 ? (
        <EmptyState kind="empty" heading="No release to roll back to" size="inline">
          A rollback target appears once there is an earlier successful release in the ledger.
        </EmptyState>
      ) : older.length > 0 ? (
        <Section
          title="Earlier releases to roll back to"
          headingLevel={3}
          description="Successful releases in the agent's ledger older than the rows above."
        >
          <DataList aria-label="Earlier releases to roll back to">
            {older.map((target) => (
              <DataListRow
                key={target.deployId}
                truncate={false}
                title={<code>{sha7(target.sha)}</code>}
                description={`${target.requester}, ${age(target.endedAt)}`}
                meta={target.images.map((i) => `${i.service} ${shortDigest(i.digest)}`).join(', ')}
                {...(can ? { actions: <RollBackButton release={target} onRollBack={onRollBack} /> } : {})}
              />
            ))}
          </DataList>
        </Section>
      ) : null}

      {showBuilds ? (
        <Section title="Builds" headingLevel={3} description="Images Shipyard built for this app, newest first.">
          <Stack gap="12">
            <DataList
              aria-label="Recent builds"
              empty={
                <EmptyState kind="empty" size="inline" heading={builds === null ? 'Builds could not be read' : 'No builds yet'}>
                  {builds === null
                    ? 'Open the builds list to try again.'
                    : `${detail.name} is built here when it is pushed to ${detail.defaultBranch ?? 'its default branch'}.`}
                </EmptyState>
              }
            >
              {(builds ?? []).map((build) => (
                <BuildRow key={build.buildId} build={build} />
              ))}
            </DataList>
            <Link asChild>
              <RouterLink to={`/builds?app=${encodeURIComponent(detail.name)}`}>All builds of {detail.name}</RouterLink>
            </Link>
          </Stack>
        </Section>
      ) : null}

      {drift.resolved.length > 0 ? (
        <Section title="Past drift" headingLevel={3}>
          <DataList aria-label="Past drift">
            {drift.resolved.map((r) => (
              <DataListRow
                key={r.id}
                truncate={false}
                title={
                  r.resolution === 'adopt_live'
                    ? 'Adopted what was running'
                    : r.resolution === 'redeploy_recorded'
                      ? 'Redeployed the recorded release'
                      : 'Superseded by a newer observation'
                }
                description={`${r.resolvedBy ?? 'unknown'}, ${when(r.resolvedAt)}${r.reason !== null ? `: ${r.reason}` : ''}`}
              />
            ))}
          </DataList>
        </Section>
      ) : null}
    </Stack>
  );
}
