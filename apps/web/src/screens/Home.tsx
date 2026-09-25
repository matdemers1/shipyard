import { Alert, EmptyState, Grid, Link, Page, PageHeader, Skeleton, Stack } from '@d3cloud/ui';
import { useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { AppCard } from '../components/AppCard';
import { ApprovalsBanner } from '../components/ApprovalsBanner';
import { DryRunSheet, type SheetAction } from '../components/DryRunSheet';
import { useCan } from '../lib/auth';
import { useHomeData } from '../lib/home';

/** S2 Home: the approvals banner, the stale-agent banner, then one card per app (SHP-D-023). */
export function Home() {
  const { status, apps, approvals, noAgent, noApps, agentStale, error, refresh } = useHomeData();
  const canDeploy = useCan();
  const navigate = useNavigate();
  const [action, setAction] = useState<SheetAction | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const openSheet = (next: SheetAction) => {
    setAction(next);
    setSheetOpen(true);
  };

  return (
    <Page>
      <Stack gap="16">
        <PageHeader title="Home" />

        {status === 'error' ? (
          <Alert tone="danger" title={error?.message ?? 'Shipyard is not answering.'}>
            {error?.fix ?? 'Check that the server is running and reachable, then try again.'}
          </Alert>
        ) : null}

        {status === 'loading' ? (
          <Grid as="ul" minItemWidth="sm">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <Skeleton variant="block" height={140} />
              </li>
            ))}
          </Grid>
        ) : null}

        {status === 'ready' && noAgent ? (
          <EmptyState kind="empty" heading="No agent enrolled yet" headingLevel={2} action={<Link asChild><RouterLink to="/agent">Enrol an agent</RouterLink></Link>}>
            Shipyard has no agent to deploy through. Enrol one from a Docker host to get started.
          </EmptyState>
        ) : null}

        {status === 'ready' && !noAgent && noApps ? (
          <EmptyState kind="empty" heading="Agent reported no apps" headingLevel={2}>
            The agent is enrolled but has not reported any manifests yet. Add a manifest to the agent's host and wait
            for its next report, or see the onboarding runbook.
          </EmptyState>
        ) : null}

        {status === 'ready' && agentStale ? (
          <Alert tone="warning" title="No agent has reported recently">
            The agent has not heartbeated in over 5 minutes. Live SHAs and drift here may be out of date.
          </Alert>
        ) : null}

        {status === 'ready' ? <ApprovalsBanner approvals={approvals} onReview={openSheet} onDenied={refresh} /> : null}

        {status === 'ready' && apps.length > 0 ? (
          <Grid as="ul" minItemWidth="sm">
            {apps.map((app) => (
              <AppCard key={app.name} app={app} canDeploy={canDeploy} onShip={openSheet} />
            ))}
          </Grid>
        ) : null}

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
