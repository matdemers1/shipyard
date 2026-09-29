import { Badge, Button, Card, CardBody, CardTitle, Cluster, Link } from '@d3cloud/ui';
import { Link as RouterLink } from 'react-router-dom';
import { sha7, stateWords, summarizeCommits, type AppStatus } from '../lib/appstatus';
import { ageFrom, type HomeApp, type PendingApproval } from '../lib/home';
import type { SheetAction } from './DryRunSheet';
import { StatusLine } from './StatusLine';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** "12 commits" and, under it, what they are made of: "2 built · 10 without images". */
function waitingFact(app: HomeApp): { value: string; sub: string | null } {
  if (app.commits === null || app.commits.source === 'unavailable') return { value: 'Unknown', sub: null };
  const s = summarizeCommits(app.commits);
  if (s.ahead === 0) return { value: 'None', sub: null };
  const parts: string[] = [];
  if (s.green > 0) parts.push(`${String(s.green)} built`);
  if (s.running > 0) parts.push(`${String(s.running)} building`);
  if (s.failed > 0) parts.push(`${String(s.failed)} failed`);
  if (s.noRun > 0) parts.push(`${String(s.noRun)} without images`);
  if (s.ahead > s.checked) parts.push(`${String(s.ahead - s.checked)} older unchecked`);
  return { value: plural(s.ahead, 'commit'), sub: parts.join(' · ') || null };
}

export interface AppCardProps {
  app: HomeApp;
  status: AppStatus;
  /** Hidden for a viewer (SHP-REQ-105). */
  canDeploy: boolean;
  onShip: (action: SheetAction) => void;
  /** This app's deploy waiting on a deployer's approval, if any: reviewed from the card too. */
  approval?: PendingApproval | undefined;
}

/**
 * One app, one card (SHP-D-023, SHP-REQ-056, SHP-REQ-059, SHP-T-3.10): what it is doing and why
 * first, then the facts behind it, then the one thing you can do about it.
 */
export function AppCard({ app, status, canDeploy, onShip, approval }: AppCardProps) {
  const waiting = waitingFact(app);
  const detailHref = `/apps/${encodeURIComponent(app.name)}`;

  let action: React.ReactNode = null;
  if (canDeploy && approval !== undefined) {
    action = (
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={() => {
          onShip({ kind: 'approve', app: app.name, sha: approval.sha, deployId: approval.deployId });
        }}
      >
        Review approval · {sha7(approval.sha)}
      </Button>
    );
  } else if (canDeploy && status.shipSha !== null) {
    const sha = status.shipSha;
    action = (
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={() => {
          onShip({ kind: 'deploy', app: app.name, sha });
        }}
      >
        Ship {sha7(sha)}
      </Button>
    );
  } else if (app.active !== null) {
    action = (
      <Link asChild>
        <RouterLink to={`/deploys/${app.active.deployId}/live`}>Watch it live</RouterLink>
      </Link>
    );
  }

  return (
    <Card as="li" padding="md" className="shp-card-fill">
      <CardBody>
        <div className="shp-card-stack">
          <Cluster justify="between" align="center" gap="8">
            <CardTitle as="h3">
              <Link asChild variant="inline">
                <RouterLink to={detailHref}>{app.name}</RouterLink>
              </Link>
            </CardTitle>
            <Badge tone={status.tone}>{status.label}</Badge>
          </Cluster>

          <StatusLine status={status} />

          <dl className="shp-facts">
            <div>
              <dt>Live</dt>
              <dd>{app.liveSha === null ? 'Nothing recorded' : <code>{sha7(app.liveSha)}</code>}</dd>
            </div>
            <div>
              <dt>Since live</dt>
              <dd>
                {waiting.value}
                {waiting.sub !== null ? <span className="shp-facts__sub">{waiting.sub}</span> : null}
              </dd>
            </div>
            <div>
              <dt>Last deploy</dt>
              <dd>
                {app.lastDeploy === null ? 'None yet' : stateWords(app.lastDeploy.state)}
                {app.lastDeploy !== null && app.lastDeploy.endedAt !== null ? <span className="shp-facts__sub">{ageFrom(app.lastDeploy.endedAt)}</span> : null}
              </dd>
            </div>
          </dl>

          <div className="shp-card-stack__foot">
            {action ?? <span className="shp-facts__sub">Agent checked {ageFrom(app.reportedAt)}</span>}
            <Link asChild>
              <RouterLink to={detailHref} aria-label={`Details for ${app.name}`}>
                Details
              </RouterLink>
            </Link>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
