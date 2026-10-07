import { Alert, Button, Card, EmptyState, Link, Page, PageHeader, Section, Skeleton, Stack } from '@d3cloud/ui';
import type { GroupSummary } from '@shipyard/schema';
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { AppRow } from '../components/AppRow';
import { DryRunSheet, type SheetAction } from '../components/DryRunSheet';
import { GroupDeploySheet } from '../components/GroupDeploySheet';
import { NeedsYou } from '../components/NeedsYou';
import { STAGE_ORDER } from '../components/pipeline';
import { RollAllSheet } from '../components/RollAllSheet';
import { appStatus, type AppStatus } from '../lib/appstatus';
import { useCan, useIsAdmin } from '../lib/auth';
import { fetchGroups } from '../lib/groups';
import { useHomeData, type HomeApp, type PendingApproval } from '../lib/home';
import { needsYouFrom } from '../lib/needsyou';
import { MIN_ROLL_ALL, rolloutCandidates } from '../lib/rollouts';
import { deployAllReadyVerb } from '../lib/words';

/** How to add an app: a manifest on the agent's host (docs/runbooks/onboard-app.md). */
const ONBOARD_RUNBOOK_URL = 'https://github.com/matdemers1/shipyard/blob/main/docs/runbooks/onboard-app.md';

interface Row {
  app: HomeApp;
  status: AppStatus;
  approval: PendingApproval | undefined;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * Apps (SHP-T-13.8, SHP-REQ-155, SHP-D-089): what needs a person first — approvals, drift, CI
 * failed on the newest push, host warnings — each with its action inline, then every app as one
 * row in alphabetical order. The order never depends on state, so a refresh never moves a row out
 * from under a thumb. The data is the shell's shared snapshot: the Needs you rows here and the
 * nav's Apps badge are `needsYouItems` over the same answer.
 */
export function Home() {
  const canDeploy = useCan();
  const { status, apps, approvals, system, noAgent, noApps, error, refresh } = useHomeData(canDeploy);
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const [action, setAction] = useState<SheetAction | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<GroupSummary | null>(null);
  const [groupSheetOpen, setGroupSheetOpen] = useState(false);
  const [rollAllOpen, setRollAllOpen] = useState(false);

  const rows = useMemo<Row[]>(
    () =>
      apps
        .map((app) => {
          const approval = approvals.find((a) => a.app === app.name);
          return { app, approval, status: appStatus({ ...app, approval }) };
        })
        .sort((a, b) => a.app.name.localeCompare(b.app.name)),
    [apps, approvals],
  );
  const needsYou = useMemo(() => needsYouFrom({ apps, approvals, system }), [apps, approvals, system]);
  const rollAll = useMemo(() => rolloutCandidates(rows), [rows]);
  const count = (...kinds: AppStatus['kind'][]) => rows.filter((r) => kinds.includes(r.status.kind)).length;
  const readyCount = count('ready');
  const upToDateCount = count('up-to-date');

  const openSheet = (next: SheetAction) => {
    setAction(next);
    setSheetOpen(true);
  };

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void fetchGroups()
      .then((rows) => {
        if (!cancelled) setGroups(rows);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  const summary =
    status === 'ready' && rows.length > 0
      ? [
          plural(rows.length, 'app'),
          `${String(readyCount)} ready`,
          `${String(count('deploying', 'ci-running'))} in flight`,
          `${String(needsYou.count)} need you`,
        ].join(' · ')
      : undefined;

  return (
    <Page>
      <Stack gap="16">
        <PageHeader
          title="Apps"
          {...(summary === undefined ? {} : { description: summary })}
          {...(canDeploy && rollAll.length >= MIN_ROLL_ALL
            ? {
                actions: (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setRollAllOpen(true);
                    }}
                  >
                    {deployAllReadyVerb(rollAll.length)}
                  </Button>
                ),
              }
            : {})}
        />

        {status === 'error' ? (
          <Alert tone="danger" title={error?.message ?? 'Shipyard is not answering.'}>
            {error !== null && error.status >= 500
              ? `The server answered but could not read its own records — most often it has lost its database. Check that PostgreSQL is up and the server's logs. ${error.fix}`
              : (error?.fix ?? 'Check that the server is running and reachable, then try again.')}
          </Alert>
        ) : null}

        {status === 'loading' ? (
          <>
            <span role="status" className="shp-visually-hidden">
              Loading apps
            </span>
            <Stack gap="8" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} variant="block" height={56} />
              ))}
            </Stack>
          </>
        ) : null}

        {status === 'ready' && noAgent ? (
          <EmptyState
            kind="empty"
            heading="No agent enrolled yet"
            headingLevel={2}
            action={
              <Link asChild>
                <RouterLink to="/agent">Enrol an agent</RouterLink>
              </Link>
            }
          >
            Shipyard has no agent to deploy through. Enrol one from a Docker host to get started.
          </EmptyState>
        ) : null}

        {status === 'ready' && !noAgent && noApps ? (
          <EmptyState
            kind="empty"
            heading="Agent reported no apps"
            headingLevel={2}
            action={
              <Link href={ONBOARD_RUNBOOK_URL} target="_blank" rel="noreferrer">
                Onboarding runbook
              </Link>
            }
          >
            The agent is enrolled but has not reported any manifests yet. Add a manifest to the agent's host and wait for its next report,
            or see the onboarding runbook.
          </EmptyState>
        ) : null}

        {status === 'ready' && rows.some((r) => r.status.kind === 'github-unavailable') ? (
          <Alert
            tone="warning"
            title="Shipyard can't see new commits on GitHub"
            {...(isAdmin
              ? {
                  actions: (
                    <Link asChild>
                      <RouterLink to="/settings#github">Check GitHub access</RouterLink>
                    </Link>
                  ),
                }
              : {})}
          >
            GitHub isn't answering the server, so nothing new is offered to deploy. Most often the server is calling GitHub without a token
            and has used its 60 requests for the hour.{' '}
            {isAdmin ? 'Settings → GitHub shows how many are left and takes a token.' : 'An admin can add a GitHub token in Settings.'}
          </Alert>
        ) : null}

        {status === 'ready' && (rows.length > 0 || needsYou.count > 0) ? (
          <NeedsYou
            items={needsYou.items}
            apps={apps}
            approvals={approvals}
            system={system}
            canAct={canDeploy}
            onReview={openSheet}
            onChanged={refresh}
            onDeployStarted={(deployId) => {
              void navigate(`/deploys/${deployId}`);
            }}
            upToDate={upToDateCount}
            ready={readyCount}
          />
        ) : null}

        {status === 'ready' && rows.length > 0 ? (
          <Section title="All apps" surface="plain">
            <Card padding="sm">
              <ul className="shp-app-rows" aria-label="All apps">
                {rows.map((row) => (
                  <AppRow
                    key={row.app.name}
                    app={row.app}
                    status={row.status}
                    approval={row.approval}
                    groups={groups}
                    canDeploy={canDeploy}
                    onAction={openSheet}
                  />
                ))}
              </ul>
            </Card>
            <p className="shp-lane-legend">Lane: {STAGE_ORDER.map((s) => s.label).join(' · ')}</p>
          </Section>
        ) : null}

        {status === 'ready' && groups.length > 0 ? (
          // Groups show on their members' rows; this line keeps the group deploy one tap away.
          <ul className="shp-groups-line" aria-label="Groups">
            {groups.map((group) => (
              <li key={group.name}>
                <span>
                  <strong>{group.name}</strong> group ·{' '}
                  {group.members.map((m) => (m === group.canary ? `${m} (canary)` : m)).join(', ')}
                </span>
                {canDeploy ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label={`Deploy group ${group.name}`}
                    onClick={() => {
                      setSelectedGroup(group);
                      setGroupSheetOpen(true);
                    }}
                  >
                    Deploy group
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <GroupDeploySheet
          open={groupSheetOpen}
          onOpenChange={setGroupSheetOpen}
          group={selectedGroup}
          onStarted={(deployId) => {
            setGroupSheetOpen(false);
            void navigate(`/deploys/${deployId}/live`);
          }}
        />

        <RollAllSheet
          open={rollAllOpen}
          onOpenChange={setRollAllOpen}
          items={rollAll}
          onStarted={(rolloutId) => {
            setRollAllOpen(false);
            void navigate(`/rollouts/${rolloutId}`);
          }}
        />

        <DryRunSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          action={action}
          onStarted={(deployId) => {
            setSheetOpen(false);
            void navigate(`/deploys/${deployId}/live`);
          }}
        />
      </Stack>
    </Page>
  );
}
