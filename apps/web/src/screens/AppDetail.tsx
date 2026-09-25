import {
  Alert,
  Badge,
  Button,
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
import { RefusalError, unreachableRefusal } from '../lib/api';
import { useCan } from '../lib/auth';
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

/**
 * App detail (S5), `/apps/:app`: what is live and how old it is, the running digests, drift and its
 * resolution (SHP-REQ-066), the last twenty targets, the rollback targets the server says the
 * agent's ledger will accept (SHP-REQ-063 — no others are offered), the releases only a restore can
 * reach, and the manifest. A viewer sees all of it and none of the actions (SHP-REQ-105).
 */

type Load =
  | { status: 'loading' }
  | { status: 'error'; error: RefusalError }
  | { status: 'ready'; detail: Detail; drift: DriftState; freeze: FreezeInfo | null };

function stateTone(state: string): 'neutral' | 'attention' | 'danger' {
  if (state === 'failed' || state === 'rolled_back' || state === 'refused') return 'danger';
  if (state === 'awaiting_approval') return 'attention';
  return 'neutral';
}

function DetailSkeleton({ app }: { app: string }) {
  return (
    <Page aria-busy="true">
      <Stack gap="24">
        <PageHeader title={app} description="Reading what the agent last reported." />
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
    Promise.all([appDetail.get(app, controller.signal), appDetail.drift(app, controller.signal), freeze.get(app, controller.signal)])
      .then(([detail, drift, freezeStatus]) => {
        setLoad({ status: 'ready', detail, drift, freeze: freezeStatus.freeze });
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

  return (
    <Page>
      <Stack gap="24">
        <PageHeader
          title={detail.name}
          back={back}
          description={
            neverDeployed
              ? 'Never deployed through Shipyard.'
              : `Live ${sha7(detail.liveSha)}, deployed ${age(detail.liveEndedAt)}.`
          }
          {...(can
            ? {
                actions:
                  activeFreeze !== null ? (
                    <UnfreezeButton app={detail.name} onCleared={reload} />
                  ) : (
                    <FreezeSheet app={detail.name} onFrozen={reload} />
                  ),
              }
            : {})}
        />

        {activeFreeze !== null ? (
          <Alert tone="danger" title={`${detail.name} is frozen`}>
            {activeFreeze.reason} — since {when(activeFreeze.from)}, by {activeFreeze.by}
            {activeFreeze.until !== null ? `, until ${when(activeFreeze.until)}` : ''}. New deploys are refused;
            rollbacks and restores are still allowed.
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

        <Section title="Release">
          <DescriptionList>
            <DescriptionItem term="Repository">{detail.repo ?? '—'}</DescriptionItem>
            <DescriptionItem term="Live SHA">
              {neverDeployed ? 'None recorded' : <code>{sha7(detail.liveSha)}</code>}
            </DescriptionItem>
            <DescriptionItem term="Age" numeric>
              {neverDeployed ? '—' : age(detail.liveEndedAt)}
            </DescriptionItem>
            <DescriptionItem term="Schema revision">
              {detail.schemaRevision !== null ? <code>{detail.schemaRevision}</code> : 'Not known'}
            </DescriptionItem>
            <DescriptionItem term="Soak" numeric>
              {detail.soakSeconds !== null ? `${String(detail.soakSeconds)} s` : '—'}
            </DescriptionItem>
            <DescriptionItem term="Approval">{detail.approvalPolicy ?? '—'}</DescriptionItem>
            <DescriptionItem term="Group">
              {detail.group ?? 'None'}
              {detail.canary ? ' (canary)' : ''}
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
            Shipyard has no recorded release for this app yet. Its first deploy records one; until then, a deployer
            can adopt what is running, with a reason, to make it the recorded release.
          </EmptyState>
        ) : null}

        <Section title="Running digests" description={`As the agent last reported, ${when(detail.reportedAt)}.`}>
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
          title="Roll back"
          description="Only releases in the agent's ledger: the last five, not the live one. The agent checks again before it acts."
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
                          Roll back to {sha7(target.sha)}
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

        <Section
          title="Backups"
          description="Backups the agent took before a deploy. Restoring one discards every write made since it was taken."
        >
          <Link asChild>
            <RouterLink to={`/apps/${encodeURIComponent(detail.name)}/restore`}>See backups and restore</RouterLink>
          </Link>
        </Section>

        <Section title="Schedules" description="Deploy a named SHA at a set time; every gate re-runs when it fires.">
          <Link asChild>
            <RouterLink to="/schedules">See and schedule deploys</RouterLink>
          </Link>
        </Section>

        <Section title="History" description="The last twenty deploys, rollbacks and dry runs.">
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
                meta={<Badge tone={stateTone(t.state)}>{t.state.replace('_', ' ')}</Badge>}
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

        <Section title="Manifest" description="As the agent reported it. Read-only: it changes on the host.">
          <Textarea
            mono
            readOnly
            aria-label="Manifest"
            rows={12}
            value={typeof detail.manifest === 'string' ? detail.manifest : JSON.stringify(detail.manifest, null, 2)}
          />
        </Section>
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
