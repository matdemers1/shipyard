import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardTitle,
  Cluster,
  EmptyState,
  Grid,
  Link,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import type { GroupSummary } from '@shipyard/schema';
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { AppCard } from '../components/AppCard';
import { ApprovalsBanner } from '../components/ApprovalsBanner';
import { DryRunSheet, type SheetAction } from '../components/DryRunSheet';
import { GroupDeploySheet } from '../components/GroupDeploySheet';
import { appStatus, statusRank, type AppStatus, type StatusKind } from '../lib/appstatus';
import { useCan, useIsAdmin } from '../lib/auth';
import { fetchGroups } from '../lib/groups';
import { useHomeData, type HomeApp, type PendingApproval } from '../lib/home';

/** How to add an app: a manifest on the agent's host (docs/runbooks/onboard-app.md). */
const ONBOARD_RUNBOOK_URL = 'https://github.com/matdemers1/shipyard/blob/main/docs/runbooks/onboard-app.md';

/** The overview line's buckets: what needs you, what is moving, what is fine. */
const SUMMARY: { label: string; kinds: StatusKind[] }[] = [
  { label: 'ready to ship', kinds: ['ready'] },
  { label: 'need attention', kinds: ['approval', 'drift', 'ci-failed'] },
  { label: 'in progress', kinds: ['deploying', 'ci-running'] },
  { label: 'nothing to ship', kinds: ['up-to-date', 'no-images'] },
];

/** What each status means, for the "What do these mean?" disclosure. */
const GLOSSARY: { term: string; meaning: string }[] = [
  {
    term: 'Ready to ship',
    meaning: 'A commit ahead of live has passed CI and its images are built. Ship deploys it and everything before it.',
  },
  {
    term: 'Nothing to ship',
    meaning:
      'There are commits since live, but none has images. GitHub builds images once per push, for the newest commit in it; the others ride along when that one ships.',
  },
  { term: 'Building', meaning: 'CI is running on the newest push. When it passes, that commit becomes shippable.' },
  { term: 'CI failed', meaning: 'The newest push failed CI, so no images were published. Fix it and push again.' },
  {
    term: 'Built by Shipyard',
    meaning:
      'An app whose manifest says build: shipyard gets its images from Shipyard’s own builds instead of GitHub CI, so its statuses read “Shipyard is building” or “Build failed”, and each commit links to its build.',
  },
  { term: 'Needs approval', meaning: 'Someone asked to deploy an app that requires a deployer to approve first.' },
  {
    term: 'Drift',
    meaning: 'What is running on the host is not what Shipyard deployed. Resolve it on the app page before the next deploy.',
  },
  { term: 'Deploying', meaning: 'A deploy is running: backup, pull, swap, health check, then a soak before it counts as done.' },
  { term: 'Up to date', meaning: 'Live is the newest commit on the default branch.' },
];

interface Row {
  app: HomeApp;
  status: AppStatus;
  approval: PendingApproval | undefined;
}

/**
 * S2 Home (SHP-D-023, SHP-T-3.10): an overview line, the approvals and stale-agent banners, then
 * one card per app — what needs you first — and the groups.
 */
export function Home() {
  const { status, apps, approvals, noAgent, noApps, agentStale, error, refresh } = useHomeData();
  const canDeploy = useCan();
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const [action, setAction] = useState<SheetAction | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<GroupSummary | null>(null);
  const [groupSheetOpen, setGroupSheetOpen] = useState(false);

  const rows = useMemo<Row[]>(
    () =>
      apps
        .map((app) => {
          const approval = approvals.find((a) => a.app === app.name);
          return { app, approval, status: appStatus({ ...app, approval }) };
        })
        .sort((a, b) => statusRank(a.status.kind) - statusRank(b.status.kind) || a.app.name.localeCompare(b.app.name)),
    [apps, approvals],
  );

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

  const openGroupSheet = (group: GroupSummary) => {
    setSelectedGroup(group);
    setGroupSheetOpen(true);
  };

  return (
    <Page>
      <Stack gap="16">
        <PageHeader title="Home" description="Every app on the host: what is live, what is waiting, and what you can ship." />

        {status === 'ready' && rows.length > 0 ? (
          <ul className="shp-summary" aria-label="Overview">
            {SUMMARY.map((bucket) => {
              const n = rows.filter((r) => bucket.kinds.includes(r.status.kind)).length;
              return n === 0 ? null : (
                <li key={bucket.label}>
                  <strong>{n}</strong> {bucket.label}
                </li>
              );
            })}
          </ul>
        ) : null}

        {status === 'error' ? (
          <Alert tone="danger" title={error?.message ?? 'Shipyard is not answering.'}>
            {error !== null && error.status >= 500
              ? `The server answered but could not read its own records — most often it has lost its database. Check that PostgreSQL is up and the server's logs. ${error.fix}`
              : (error?.fix ?? 'Check that the server is running and reachable, then try again.')}
          </Alert>
        ) : null}

        {status === 'loading' ? (
          <span role="status" className="shp-visually-hidden">
            Loading apps
          </span>
        ) : null}

        {status === 'loading' ? (
          <Grid as="ul" minItemWidth="sm" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <Skeleton variant="block" height={140} />
              </li>
            ))}
          </Grid>
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

        {status === 'ready' && agentStale ? (
          <Alert tone="warning" title="No agent has reported recently">
            The agent has not heartbeated in over 5 minutes. Live SHAs and drift here may be out of date.
          </Alert>
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

        {status === 'ready' ? <ApprovalsBanner approvals={approvals} canDeny={canDeploy} onReview={openSheet} onDenied={refresh} /> : null}

        {status === 'ready' && rows.length > 0 ? (
          <Section title="Apps" surface="plain">
            <Grid as="ul" minItemWidth="sm">
              {rows.map((row) => (
                <AppCard
                  key={row.app.name}
                  app={row.app}
                  status={row.status}
                  canDeploy={canDeploy}
                  onShip={openSheet}
                  approval={row.approval}
                />
              ))}
            </Grid>
          </Section>
        ) : null}

        {status === 'ready' && groups.length > 0 ? (
          <Section
            title="Groups"
            surface="plain"
            description="Apps that deploy together at one SHA. The canary deploys and soaks first; the rest follow with the same images, and any failure stops the group."
          >
            <Grid as="ul" minItemWidth="sm">
              {groups.map((group) => (
                <Card key={group.name} as="li" padding="md">
                  <CardBody>
                    <Stack gap="8">
                      <CardTitle as="h3">{group.name}</CardTitle>
                      <Cluster gap="4">
                        {group.members.map((member) => (
                          <Badge key={member} tone={member === group.canary ? 'attention' : 'neutral'}>
                            {member}
                            {member === group.canary ? ' · canary' : ''}
                          </Badge>
                        ))}
                      </Cluster>
                      {canDeploy ? (
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          onClick={() => {
                            openGroupSheet(group);
                          }}
                        >
                          Deploy group
                        </Button>
                      ) : null}
                    </Stack>
                  </CardBody>
                </Card>
              ))}
            </Grid>
          </Section>
        ) : null}

        {status === 'ready' && rows.length > 0 ? (
          <details className="shp-disclosure">
            <summary>What do these statuses mean?</summary>
            <dl className="shp-glossary">
              {GLOSSARY.map((g) => (
                <div key={g.term}>
                  <dt>{g.term}</dt>
                  <dd>{g.meaning}</dd>
                </div>
              ))}
            </dl>
          </details>
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
