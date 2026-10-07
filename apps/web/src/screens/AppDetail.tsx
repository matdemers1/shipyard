import { Alert, Button, EmptyState, Link, Page, PageHeader, Skeleton, Stack, TabPanel, Tabs, type TabItem } from '@d3cloud/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { AdoptLiveButton, DriftBanner } from '../components/DriftBanner';
import { DryRunSheet, type SheetAction } from '../components/DryRunSheet';
import { RefusalError, request, unreachableRefusal } from '../lib/api';
import type { CommitsInfo, PendingApproval } from '../lib/home';
import { appStatus, summarizeCommits } from '../lib/appstatus';
import { useCan } from '../lib/auth';
import { builds as buildsApi, type BuildSummary } from '../lib/builds';
import { restore, type RestoreCandidates } from '../lib/restore';
import { schedules as schedulesApi, type ScheduleList } from '../lib/schedules';
import {
  appDetail,
  builtByShipyard,
  freeze,
  nextUpCommit,
  sha7,
  when,
  type AppDetail as Detail,
  type DriftState,
  type FreezeInfo,
} from '../lib/appdetail';
import { BackupsTab } from './app/BackupsTab';
import { ConfigTab } from './app/ConfigTab';
import { DeploysTab } from './app/DeploysTab';
import { FactsRail } from './app/FactsRail';
import { Breadcrumb, Header } from './app/Header';
import { NextUp } from './app/NextUp';
import { Waiting } from './app/Waiting';

/**
 * The app page (S5), `/apps/:app`, organised by job (SHP-T-13.12, SHP-REQ-163): a header with one
 * primary action and Freeze one tap beside it; what deploys next and the lane it is in; the commits
 * waiting, each linked to its CI run and its commit page; then the app's records in three tabs —
 * Deploys (with roll back inline, only to the targets the server's ledger mirror offers,
 * SHP-REQ-063), Backups (the way into restore) and Config (the manifest's facts and the running
 * digests). Drift and its resolution (SHP-REQ-066) stay above it all, because drift blocks every
 * deploy. A viewer sees all of it and none of the actions (SHP-REQ-105).
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
      /** The backups a restore could use; null when they could not be read. */
      backups: RestoreCandidates | null;
      /** Every schedule, for this app's upcoming ones; null when they could not be read. */
      schedules: ScheduleList | null;
    };

const TABS: TabItem[] = [
  { value: 'deploys', label: 'Deploys' },
  { value: 'backups', label: 'Backups' },
  { value: 'config', label: 'Config' },
];

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
      // What is waiting to deploy (SHP-T-3.10). Reading it must not break the page either.
      request<CommitsInfo>(`/api/apps/${encodeURIComponent(app)}/commits`, { signal: controller.signal }).catch(() => null),
      // The Backups tab and the rail's last backup (SHP-T-13.12); a page without them still works.
      restore.candidates(app, controller.signal).catch(() => null),
      // The rail's "Scheduled" card; a viewer or an older server without them still gets the page.
      schedulesApi.list(controller.signal).catch(() => null),
    ])
      .then(([detail, drift, freezeStatus, approvals, recentBuilds, commits, backups, scheduleList]) => {
        setLoad({
          status: 'ready',
          detail,
          drift,
          freeze: freezeStatus.freeze,
          approval: approvals.find((a) => a.app === app),
          builds: recentBuilds,
          commits,
          backups,
          schedules: scheduleList,
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
  // A retired app (SHP-REQ-174) is history only: nothing on it can be acted on.
  const canAct = can && detail.retiredAt === null;
  const neverDeployed = detail.liveSha === null;
  const showBuilds = builtByShipyard(detail.manifest) || (load.builds ?? []).length > 0;
  const status = appStatus({ ...detail, commits: load.commits, approval: load.approval, frozen: activeFreeze !== null });
  const summary = summarizeCommits(load.commits);
  const branch = detail.defaultBranch ?? 'the default branch';
  // While frozen the status offers nothing to deploy; the header still names what would go once unfrozen.
  const held = activeFreeze !== null ? nextUpCommit(load.commits, detail.liveSha) : null;
  const heldSha = held !== null && held.sha === load.commits?.newestGreen ? held.sha : null;
  const deploy = (sha: string) => {
    setSheet({ kind: 'deploy', app: detail.name, sha });
  };
  const scheduled = (load.schedules?.upcoming ?? []).filter((s) => s.app === detail.name);

  return (
    <Page>
      <Stack gap="24">
        <Stack gap="8">
          <Breadcrumb app={detail.name} />
          <Header
            detail={detail}
            status={status}
            freeze={activeFreeze}
            approval={load.approval}
            can={canAct}
            heldSha={heldSha}
            onSheet={setSheet}
            onChanged={reload}
          />
        </Stack>

        {detail.retiredAt !== null ? (
          // The agent no longer reports a manifest for it (SHP-REQ-174): history only, nothing to act on.
          <Alert tone="info" title={`Retired ${when(detail.retiredAt)}`}>
            The agent no longer reports a manifest for {detail.name}, so it is out of its group, the app list and Needs you, and
            new deploys are refused. Its history stays here. Put the manifest back on the host and it returns on the next report.
          </Alert>
        ) : null}

        {activeFreeze !== null ? (
          // A freeze is a deliberate hold, not a fault: information, with who and why (SHP-D-094).
          <Alert
            tone="info"
            title={`Frozen ${activeFreeze.until !== null ? `until ${when(activeFreeze.until)}` : 'until someone unfreezes it'} — ${activeFreeze.reason} · by ${activeFreeze.by}`}
          >
            Since {when(activeFreeze.from)}. New deploys are refused; rollbacks and restores are still allowed.
          </Alert>
        ) : null}

        {drift.open !== null ? (
          <DriftBanner
            app={detail.name}
            eventId={drift.open.id}
            detectedAt={drift.open.detectedAt}
            services={drift.open.services}
            pending={drift.open.pending}
            canAct={canAct}
            onResolved={(deployId) => {
              if (deployId !== undefined) void navigate(`/deploys/${deployId}/live`);
              else reload();
            }}
          />
        ) : null}

        {load.approval !== undefined ? (
          <Alert tone="warning" title="A deploy is waiting on approval">
            {load.approval.requester.label} asked to deploy <code>{sha7(load.approval.sha)}</code>. It holds no lock and expires{' '}
            {when(load.approval.expiresAt)}. {canAct ? 'Review it from the header.' : 'A deployer approves it.'}
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

        <div className="shp-app-layout">
          <Stack gap="24">
            {neverDeployed && drift.open === null ? (
              <EmptyState
                kind="empty"
                heading="Never deployed through Shipyard"
                headingLevel={2}
                {...(canAct
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
                Shipyard has no recorded release for this app yet. Its first deploy records one; until then, a deployer can adopt what
                is running, with a reason, to make it the recorded release.
              </EmptyState>
            ) : null}

            <NextUp detail={detail} status={status} commits={load.commits} approval={load.approval} />

            {load.commits !== null && load.commits.source === 'github' && summary.ahead > 0 ? (
              <Waiting app={detail.name} branch={branch} commits={load.commits} status={status} can={canAct} onDeploy={deploy} />
            ) : null}

            <Tabs aria-label={`${detail.name} records`} defaultValue="deploys" items={TABS}>
              <TabPanel value="deploys">
                <DeploysTab
                  detail={detail}
                  drift={drift}
                  builds={load.builds}
                  showBuilds={showBuilds}
                  can={canAct}
                  onRollBack={(target) => {
                    setSheet({ kind: 'rollback', app: detail.name, sha: target.sha, toDeployId: target.deployId });
                  }}
                />
              </TabPanel>
              <TabPanel value="backups">
                <BackupsTab detail={detail} backups={load.backups} />
              </TabPanel>
              <TabPanel value="config">
                <ConfigTab detail={detail} />
              </TabPanel>
            </Tabs>
          </Stack>

          <FactsRail detail={detail} backups={load.backups} scheduled={scheduled} />
        </div>
        {/* On a phone the actions are pinned above the tab bar; this keeps the page's end clear of them. */}
        <div className="shp-app-actions-clear" aria-hidden="true" />
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
