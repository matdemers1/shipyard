import {
  Alert,
  Badge,
  Button,
  Cluster,
  DataList,
  DataListRow,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  Link,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { AdoptLiveButton, DriftBanner } from '../components/DriftBanner';
import { DryRunSheet, type SheetAction } from '../components/DryRunSheet';
import { FreezeSheet, UnfreezeButton } from '../components/FreezeSheet';
import { RefusalError, request, unreachableRefusal } from '../lib/api';
import type { CommitsInfo, PendingApproval } from '../lib/home';
import { appStatus, ciTone, stateTone, summarizeCommits } from '../lib/appstatus';
import { StatusLine } from '../components/StatusLine';
import { useCan } from '../lib/auth';
import { ciWords, deployVerb, rollBackVerb, stateWords, VERBS } from '../lib/words';
import { builds as buildsApi, type BuildSummary } from '../lib/builds';
import { BuildRow } from './Builds';
import {
  age,
  appDetail,
  freeze,
  sha7,
  shortDigest,
  when,
  type AppDetail as Detail,
  type DriftState,
  type FreezeInfo,
} from '../lib/appdetail';
import { OpenInConstellation } from '../components/OpenInConstellation';

/**
 * App detail (S5), `/apps/:app`: what is live and how old it is, the running digests, drift and its
 * resolution (SHP-REQ-066), the last twenty targets, the rollback targets the server says the
 * agent's ledger will accept (SHP-REQ-063 — no others are offered), the releases only a restore can
 * reach, and the manifest. A viewer sees all of it and none of the actions (SHP-REQ-105).
 */

type Load =
  | { status: 'loading' }
  | { status: 'error'; error: RefusalError }
  | {
      status: 'ready';
      detail: Detail;
      drift: DriftState;
      freeze: FreezeInfo | null;
      approval: PendingApproval | undefined;
      /** The latest few builds; null when they could not be read. */
      builds: BuildSummary[] | null;
      /** Commits ahead of live with their CI state; null when they could not be read. */
      commits: CommitsInfo | null;
    };

/** Whether the manifest has Shipyard build this app's images (`build.source: shipyard`). */
function builtByShipyard(manifest: unknown): boolean {
  if (typeof manifest !== 'object' || manifest === null) return false;
  const build = (manifest as { build?: unknown }).build;
  return typeof build === 'object' && build !== null && (build as { source?: unknown }).source === 'shipyard';
}

const RECENT_BUILDS = 5;

function DetailSkeleton({ app }: { app: string }) {
  return (
    <Page aria-busy="true">
      <Stack gap="24">
        <PageHeader title={app} description="Reading what the agent last reported." />
        <span role="status" className="shp-visually-hidden">
          Loading {app}
        </span>
        <Skeleton variant="text" lines={4} />
        <Skeleton variant="block" height={96} />
        <Skeleton variant="text" lines={6} />
      </Stack>
    </Page>
  );
}

export function AppDetail() {
  const { app = '' } = useParams();
  const can = useCan();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [sheet, setSheet] = useState<SheetAction | null>(null);
  const [reloads, setReloads] = useState(0);

  const reload = useCallback(() => {
    setReloads((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      appDetail.get(app, controller.signal),
      appDetail.drift(app, controller.signal),
      freeze.get(app, controller.signal),
      // A deploy of this app waiting on a deployer (SHP-REQ-060). Reading it must not break the page.
      request<PendingApproval[]>('/api/approvals', { signal: controller.signal }).catch(() => [] as PendingApproval[]),
      // The app's latest builds (SHP-REQ-142). Reading them must not break the page either.
      buildsApi
        .list({ app, limit: RECENT_BUILDS, signal: controller.signal })
        .then((page) => page.items)
        .catch(() => null),
      // What is waiting to ship (SHP-T-3.10). Reading it must not break the page either.
      request<CommitsInfo>(`/api/apps/${encodeURIComponent(app)}/commits`, { signal: controller.signal }).catch(() => null),
    ])
      .then(([detail, drift, freezeStatus, approvals, recentBuilds, commits]) => {
        setLoad({
          status: 'ready',
          detail,
          drift,
          freeze: freezeStatus.freeze,
          approval: approvals.find((a) => a.app === app),
          builds: recentBuilds,
          commits,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ status: 'error', error: error instanceof RefusalError ? error : unreachableRefusal() });
      });
    return () => {
      controller.abort();
    };
  }, [app, reloads]);

  const back = (
    <Link asChild>
      <RouterLink to="/">Home</RouterLink>
    </Link>
  );

  if (load.status === 'loading') return <DetailSkeleton app={app} />;

  if (load.status === 'error') {
    const { error } = load;
    return (
      <Page>
        <Stack gap="24">
          <PageHeader title={app} back={back} />
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

  const { detail, drift, freeze: activeFreeze } = load;
  const neverDeployed = detail.liveSha === null;
  const running = Object.entries(detail.running ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const history = detail.targets;
  const recentBuilds = load.builds ?? [];
  const showBuilds = builtByShipyard(detail.manifest) || recentBuilds.length > 0;
  const status = appStatus({ ...detail, commits: load.commits, approval: load.approval, frozen: activeFreeze !== null });
  const summary = summarizeCommits(load.commits);
  // Newest first: the one at the top is the one you would deploy.
  const waiting = [...(load.commits?.commits ?? [])].reverse();
  const branch = detail.defaultBranch ?? 'the default branch';
  const deploy = (sha: string) => {
    setSheet({ kind: 'deploy', app: detail.name, sha });
  };

  return (
    <Page>
      <Stack gap="24">
        <PageHeader
          title={detail.name}
          back={back}
          description={
            neverDeployed
              ? 'Never deployed through Shipyard.'
              : `Live ${sha7(detail.liveSha)}, deployed ${age(detail.liveEndedAt)}${detail.repo !== null ? ` from ${detail.repo}` : ''}.`
          }
          actions={
            <>
              <OpenInConstellation path={`app/${detail.name}`} />
              {can ? (
                activeFreeze !== null ? (
                  <UnfreezeButton app={detail.name} onCleared={reload} />
                ) : (
                  <FreezeSheet app={detail.name} onFrozen={reload} />
                )
              ) : null}
            </>
          }
        />

        {activeFreeze !== null ? (
          <Alert tone="danger" title={`${detail.name} is frozen`}>
            {activeFreeze.reason} — since {when(activeFreeze.from)}, by {activeFreeze.by}
            {activeFreeze.until !== null ? `, until ${when(activeFreeze.until)}` : ''}. New deploys are refused; rollbacks and restores are
            still allowed.
          </Alert>
        ) : null}

        {drift.open !== null ? (
          <DriftBanner
            app={detail.name}
            eventId={drift.open.id}
            detectedAt={drift.open.detectedAt}
            services={drift.open.services}
            pending={drift.open.pending}
            canAct={can}
            onResolved={(deployId) => {
              if (deployId !== undefined) void navigate(`/deploys/${deployId}/live`);
              else reload();
            }}
          />
        ) : null}

        {load.approval !== undefined ? (
          <Alert tone="warning" title="A deploy is waiting on approval">
            {load.approval.requester.label} asked to deploy <code>{sha7(load.approval.sha)}</code>. It holds no lock and expires{' '}
            {when(load.approval.expiresAt)}.{' '}
            {can ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => {
                  if (load.approval === undefined) return;
                  setSheet({
                    kind: 'approve',
                    app: detail.name,
                    sha: load.approval.sha,
                    deployId: load.approval.deployId,
                    requester: load.approval.requester.label,
                  });
                }}
              >
                Review and approve
              </Button>
            ) : (
              'A deployer approves it.'
            )}
          </Alert>
        ) : null}

        {detail.active !== null ? (
          <Alert tone="info" title={`A ${detail.active.state.replace('_', ' ')} is in progress`}>
            {detail.active.holder} holds {detail.name}
            {detail.active.currentStep !== null ? ` at ${detail.active.currentStep}` : ''}.{' '}
            {/* Inside running text: underlined, not told apart by colour alone (WCAG 1.4.1). */}
            <Link asChild variant="inline">
              <RouterLink to={`/deploys/${detail.active.deployId}/live`}>Follow it</RouterLink>
            </Link>
          </Alert>
        ) : null}

        <Section title="Status" actions={<Badge tone={status.tone}>{status.label}</Badge>}>
          <Stack gap="16">
            <StatusLine status={status} />
            {can && status.shipSha !== null ? (
              <Cluster gap="8" align="center">
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => {
                    if (status.shipSha !== null) deploy(status.shipSha);
                  }}
                >
                  {deployVerb(status.shipSha)}
                </Button>
                <span className="shp-facts__sub">You review a dry run before anything changes.</span>
              </Cluster>
            ) : null}
            <dl className="shp-facts">
              <div>
                <dt>Live</dt>
                <dd>
                  {neverDeployed ? 'Nothing recorded' : <code>{sha7(detail.liveSha)}</code>}
                  {neverDeployed ? null : <span className="shp-facts__sub">{age(detail.liveEndedAt)}</span>}
                </dd>
              </div>
              <div>
                <dt>Since live</dt>
                <dd>
                  {load.commits === null || load.commits.source === 'unavailable'
                    ? 'Unknown'
                    : summary.ahead === 0
                      ? 'None'
                      : `${String(summary.ahead)} commit${summary.ahead === 1 ? '' : 's'}`}
                  <span className="shp-facts__sub">on {branch}</span>
                </dd>
              </div>
              <div>
                <dt>Agent checked</dt>
                <dd>{age(detail.reportedAt)}</dd>
              </div>
            </dl>
          </Stack>
        </Section>

        {load.commits !== null && load.commits.source === 'github' && summary.ahead > 0 ? (
          <Section
            title="Waiting on the default branch"
            description={`Commits on ${branch} since live, newest first. Only a commit with built images can be deployed, and deploying it brings everything below it along.${
              summary.ahead > summary.checked ? ` Showing the newest ${String(summary.checked)} of ${String(summary.ahead)}.` : ''
            }`}
          >
            <DataList aria-label="Commits waiting to deploy">
              {waiting.map((c) => {
                const firstLine = c.message.split('\n')[0] ?? c.message;
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
                        <code>{sha7(c.sha)}</code>
                        {c.taskIds.length > 0 ? ` · ${c.taskIds.join(', ')}` : ''}
                        {c.sha === status.shipSha ? ' · newest ready' : ''}
                      </>
                    }
                    meta={<Badge tone={ciTone(c.ci)}>{ciWords(c.ci, load.commits?.buildSource)}</Badge>}
                    {...(can && c.ci === 'success' && status.shipSha !== null
                      ? {
                          actions: (
                            <Button
                              type="button"
                              size="sm"
                              variant={c.sha === status.shipSha ? 'primary' : 'secondary'}
                              onClick={() => {
                                deploy(c.sha);
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
                {load.commits.buildSource === 'shipyard'
                  ? '“Not built” means Shipyard has no succeeded build of that commit. It deploys inside the next built commit above it, or you can build it from Builds.'
                  : '“No images” is normal: GitHub builds images once per push, for the newest commit in it. Those commits deploy inside the next built commit above them.'}
              </p>
            ) : null}
          </Section>
        ) : null}

        <Section title="How it deploys" description="The settings that shape a deploy of this app, from its manifest on the host.">
          <DescriptionList>
            <DescriptionItem term="Repository">
              {detail.repo ?? 'None'}
              {detail.defaultBranch !== null ? ` · ${detail.defaultBranch}` : ''}
            </DescriptionItem>
            <DescriptionItem term="Images built by">
              {builtByShipyard(detail.manifest) ? 'Shipyard — each push is built here' : 'GitHub CI — the image workflow on each push'}
            </DescriptionItem>
            <DescriptionItem term="Needs approval">
              {detail.approvalPolicy === 'required' ? 'Yes — a deployer approves every deploy' : 'No — a deployer can deploy directly'}
            </DescriptionItem>
            <DescriptionItem term="Soak time" numeric>
              {detail.soakSeconds !== null ? `${String(detail.soakSeconds)} s watched healthy before a deploy counts as done` : '—'}
            </DescriptionItem>
            <DescriptionItem term="Schema revision">
              {detail.schemaRevision !== null ? <code>{detail.schemaRevision}</code> : 'Not reported by /health'}
            </DescriptionItem>
            <DescriptionItem term="Group">
              {detail.group === null
                ? 'None — deploys on its own'
                : detail.canary
                  ? `${detail.group} (canary — deploys first)`
                  : detail.group}
            </DescriptionItem>
          </DescriptionList>
        </Section>

        {neverDeployed && drift.open === null ? (
          <EmptyState
            kind="empty"
            heading="Never deployed through Shipyard"
            headingLevel={2}
            {...(can
              ? {
                  action: (
                    <AdoptLiveButton
                      app={detail.name}
                      description={`Records what is running now as ${detail.name}'s release, so drift and rollbacks have something to compare against. Nothing on the host changes.`}
                      onAdopted={reload}
                    />
                  ),
                }
              : {})}
          >
            Shipyard has no recorded release for this app yet. Its first deploy records one; until then, a deployer can adopt what is
            running, with a reason, to make it the recorded release.
          </EmptyState>
        ) : null}

        <Section
          title="Running containers"
          description={`What the agent saw on the host, ${when(detail.reportedAt)}. A digest names the exact image, so a mismatch here is how drift is found.`}
        >
          {running.length === 0 ? (
            <EmptyState kind="empty" heading="No containers reported" size="inline">
              The agent has not seen a running container for this app.
            </EmptyState>
          ) : (
            <DescriptionList>
              {running.map(([service, digest]) => (
                <DescriptionItem key={service} term={service}>
                  <code>{shortDigest(digest)}</code>
                </DescriptionItem>
              ))}
            </DescriptionList>
          )}
        </Section>

        <Section
          title={VERBS.rollBack}
          description="Put an earlier release back. Only images change — data stays as it is. These are the last five successful releases in the agent's own ledger; it checks again before it acts."
        >
          <DataList
            aria-label="Rollback targets"
            empty={
              <EmptyState kind="empty" heading="No release to roll back to" size="inline">
                A rollback target appears once there is an earlier successful release in the ledger.
              </EmptyState>
            }
          >
            {detail.rollbackTargets.map((target) => (
              <DataListRow
                key={target.deployId}
                title={<code>{sha7(target.sha)}</code>}
                description={`${target.requester}, ${age(target.endedAt)}`}
                meta={target.images.map((i) => `${i.service} ${shortDigest(i.digest)}`).join(', ')}
                {...(can
                  ? {
                      actions: (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setSheet({ kind: 'rollback', app: detail.name, sha: target.sha, toDeployId: target.deployId });
                          }}
                        >
                          {rollBackVerb(target.sha)}
                        </Button>
                      ),
                    }
                  : {})}
              />
            ))}
          </DataList>
        </Section>

        {detail.needsRestore.length > 0 ? (
          <Section
            title="Needs a restore"
            description="A contract migration was deployed after these, so rolling back would break the schema."
          >
            <DataList aria-label="Releases that need a restore">
              {detail.needsRestore.map((target) => (
                <DataListRow
                  key={target.deployId}
                  truncate={false}
                  title={<code>{sha7(target.sha)}</code>}
                  description={target.reason}
                  meta={age(target.endedAt)}
                />
              ))}
            </DataList>
            <Link asChild>
              <RouterLink to={`/apps/${encodeURIComponent(detail.name)}/restore`}>Restore from a backup</RouterLink>
            </Link>
          </Section>
        ) : null}

        <Section title="More" headingLevel={2}>
          <DataList aria-label="More for this app">
            <DataListRow
              href={`/apps/${encodeURIComponent(detail.name)}/restore`}
              title="Backups and restore"
              description="Backups the agent took before each deploy. Restoring one discards every write made since."
            />
            <DataListRow
              href="/schedules"
              title="Scheduled deploys"
              description="Deploy a named commit at a set time; every check runs again when it fires."
            />
          </DataList>
        </Section>

        {showBuilds ? (
          <Section title="Builds" description="Images Shipyard built for this app, newest first.">
            <Stack gap="12">
              <DataList
                aria-label="Recent builds"
                empty={
                  <EmptyState kind="empty" size="inline" heading={load.builds === null ? 'Builds could not be read' : 'No builds yet'}>
                    {load.builds === null
                      ? 'Open the builds list to try again.'
                      : `${detail.name} is built here when it is pushed to ${detail.defaultBranch ?? 'its default branch'}.`}
                  </EmptyState>
                }
              >
                {recentBuilds.map((build) => (
                  <BuildRow key={build.buildId} build={build} />
                ))}
              </DataList>
              <Link asChild>
                <RouterLink to={`/builds?app=${encodeURIComponent(detail.name)}`}>All builds of {detail.name}</RouterLink>
              </Link>
            </Stack>
          </Section>
        ) : null}

        <Section title="History" description="The last twenty deploys, rollbacks and dry runs. Open one for its steps and output.">
          <DataList
            aria-label="History"
            empty={
              <EmptyState kind="empty" heading="Nothing deployed yet" size="inline">
                Deploys, rollbacks and dry runs of this app appear here.
              </EmptyState>
            }
          >
            {history.map((t) => (
              <DataListRow
                key={t.id}
                title={
                  <Link asChild>
                    <RouterLink to={`/deploys/${t.deployId}`}>
                      {`${t.dryRun ? 'Dry run' : t.kind === 'rollback' ? 'Rollback' : 'Deploy'} ${sha7(t.sha)}`}
                    </RouterLink>
                  </Link>
                }
                description={`${t.requester}, ${when(t.createdAt)}`}
                meta={<Badge tone={stateTone(t.state)}>{stateWords(t.state)}</Badge>}
              />
            ))}
          </DataList>
        </Section>

        {drift.resolved.length > 0 ? (
          <Section title="Past drift" headingLevel={2}>
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

        <details className="shp-disclosure">
          <summary>Show the manifest</summary>
          <Stack gap="8">
            <p className="shp-status__detail">As the agent reported it. Read-only: it changes on the host.</p>
            <Textarea
              mono
              readOnly
              aria-label="Manifest"
              rows={12}
              value={typeof detail.manifest === 'string' ? detail.manifest : JSON.stringify(detail.manifest, null, 2)}
            />
          </Stack>
        </details>
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
