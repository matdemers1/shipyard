import { Badge, Button, Card, CardBody, CardTitle, Cluster, Link, Stack } from '@d3cloud/ui';
import { GitCommitHorizontal } from 'lucide-react';
import { Link as RouterLink } from 'react-router-dom';
import { ageFrom, primaryActionFor, shortSha, waitingCount, type HomeApp } from '../lib/home';
import type { SheetAction } from './DryRunSheet';

/** CI-state tones for the commits-waiting dot, drawn from the newest checked commit. */
function ciTone(app: HomeApp): 'neutral' | 'attention' | 'danger' {
  const entries = app.commits?.commits ?? [];
  if (entries.some((c) => c.ci === 'failure')) return 'danger';
  if (entries.some((c) => c.ci === 'pending')) return 'attention';
  return 'neutral';
}

function lastResultText(app: HomeApp): string {
  if (app.lastDeploy === null) return 'No deploys yet';
  const { state } = app.lastDeploy;
  return state === 'succeeded' ? 'Last: succeeded' : `Last: ${state}`;
}

export interface AppCardProps {
  app: HomeApp;
  /** Hidden for a viewer (SHP-REQ-105). */
  canDeploy: boolean;
  onShip: (action: SheetAction) => void;
}

/** One app, one card (SHP-D-023, SHP-REQ-056, SHP-REQ-059). */
export function AppCard({ app, canDeploy, onShip }: AppCardProps) {
  const action = primaryActionFor(app);
  const waiting = waitingCount(app.commits);

  return (
    <Card as="li" padding="md">
      <CardBody>
        <Stack gap="8">
          <Cluster justify="between" align="center">
            <CardTitle as="h3">
              <Link asChild variant="inline">
                <RouterLink to={`/apps/${app.name}`}>{app.name}</RouterLink>
              </Link>
            </CardTitle>
            <Cluster gap="4">
              {app.drift !== null ? <Badge tone="danger">Drift</Badge> : null}
              {app.approvalPending ? <Badge tone="attention">Approval pending</Badge> : null}
            </Cluster>
          </Cluster>

          <div>
            <code>{shortSha(app.liveSha)}</code> · {ageFrom(app.reportedAt)}
          </div>

          <Cluster gap="4" align="center">
            <GitCommitHorizontal aria-hidden size={14} />
            <Badge tone={ciTone(app)}>{waiting} waiting</Badge>
          </Cluster>

          {app.active !== null ? (
            <div>
              deploying by {app.active.holder}
              {app.active.currentStep !== null ? ` · ${app.active.currentStep}` : ''}
            </div>
          ) : null}

          <div>{lastResultText(app)}</div>

          {canDeploy ? (
            action.kind === 'ship' ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => {
                  onShip({ kind: 'deploy', app: app.name, sha: action.sha });
                }}
              >
                Ship {shortSha(action.sha)}
              </Button>
            ) : (
              <Button type="button" variant="secondary" size="sm" disabled title={action.kind === 'nothing-green' ? action.reason : undefined}>
                {action.kind === 'up-to-date' ? 'Up to date' : 'Nothing green'}
              </Button>
            )
          ) : null}
        </Stack>
      </CardBody>
    </Card>
  );
}
