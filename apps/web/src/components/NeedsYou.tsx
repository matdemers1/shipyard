import { Alert, Button, Card, FormActions, Link, Modal, ModalClose, Section } from '@d3cloud/ui';
import type { SystemStatus } from '@shipyard/schema';
import { CircleX, GitCompareArrows, KeyRound, ServerCrash, UserCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { RefusalError, request } from '../lib/api';
import { appDetail } from '../lib/appdetail';
import { newestWithRun, sha7 } from '../lib/appstatus';
import type { HomeApp, PendingApproval } from '../lib/home';
import type { NeedsYouItem } from '../lib/needsyou';
import { STATUS_WORDS, VERBS, approveVerb } from '../lib/words';
import { AdoptLiveButton } from './DriftBanner';
import type { SheetAction } from './DryRunSheet';
import { agoShort } from './pipeline/stages';

/**
 * Needs you (SHP-T-13.8, SHP-REQ-155, SHP-D-089): everything waiting on a person, first on Apps,
 * each with its action inline — approve or deny a deploy, adopt or redeploy over drift, open the
 * run that failed, renew the token in Settings. The rows are `needsYouItems` itself, the function
 * the nav's Apps badge counts, over the same snapshot, so the badge and this list always agree.
 * A viewer sees every row and no state-changing action (SHP-REQ-105).
 */

type Tone = 'attention' | 'warning' | 'danger';

interface Row {
  key: string;
  tone: Tone;
  icon: ReactNode;
  /** The app's name, or null for the host. */
  app: string | null;
  what: string;
  at: string | null;
  actions: ReactNode;
}

export interface NeedsYouProps {
  items: readonly NeedsYouItem[];
  apps: readonly HomeApp[];
  approvals: readonly PendingApproval[];
  system: SystemStatus | null;
  canAct: boolean;
  /** Opens the dry-run sheet: "Approve and deploy" reviews the approval there. */
  onReview: (action: SheetAction) => void;
  /** After a deny or an adopt, to read everything again. */
  onChanged: () => void;
  /** A redeploy over drift started: Apps follows it to its deploy page. */
  onDeployStarted: (deployId: string) => void;
  /** When nothing needs you: how many apps are up to date and how many are ready. */
  upToDate: number;
  ready: number;
  now?: number;
}

/**
 * Redeploys the recorded release over drift, behind a confirm. DriftBanner keeps its own copy of
 * this button private; this one says the same thing with the row's shorter label.
 */
function RedeployLiveButton({ app, driftEventId, onStarted }: { app: string; driftEventId: string; onStarted: (deployId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<RefusalError | null>(null);

  const close = (): void => {
    setOpen(false);
    setProblem(null);
  };

  async function confirm(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const accepted = await appDetail.redeploy(app, driftEventId);
      close();
      onStarted(accepted.deployId);
    } catch (error) {
      setProblem(error instanceof RefusalError ? error : null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else close();
      }}
      trigger={
        <Button type="button" variant="secondary" size="sm">
          Redeploy live
        </Button>
      }
      title={`Redeploy ${app}'s recorded release`}
      description="Starts a rollback to the recorded release, replacing what is running now. The drift is resolved when the agent next reports the recorded release running; until then, and if the rollback fails, it stays open and other deploys are refused."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="button" variant="primary" loading={busy} onClick={() => void confirm()}>
            Redeploy recorded release
          </Button>
        </>
      }
    >
      {problem !== null ? (
        <Alert tone="danger" title={problem.message} dynamic>
          {problem.fix}
        </Alert>
      ) : null}
    </Modal>
  );
}

function SettingsLink({ children }: { children: string }) {
  return (
    <Link asChild className="shp-row-link">
      <RouterLink to="/settings/host">{children}</RouterLink>
    </Link>
  );
}

export function NeedsYou({
  items,
  apps,
  approvals,
  system,
  canAct,
  onReview,
  onChanged,
  onDeployStarted,
  upToDate,
  ready,
  now = Date.now(),
}: NeedsYouProps) {
  const [denying, setDenying] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [denyError, setDenyError] = useState<RefusalError | null>(null);

  if (items.length === 0) {
    return (
      <p className="shp-needs-calm">
        Nothing needs you. {upToDate} up to date, {ready} ready.
      </p>
    );
  }

  const deny = async (approval: PendingApproval): Promise<void> => {
    setBusy(true);
    setDenyError(null);
    try {
      await request(`/api/deploys/${approval.deployId}/deny`, { method: 'POST' });
      setDenying(null);
      onChanged();
    } catch (err) {
      setDenyError(err instanceof RefusalError ? err : null);
    } finally {
      setBusy(false);
    }
  };

  const rows = items.map((item, index): Row => {
    switch (item.kind) {
      case 'approval': {
        const approval = approvals.find((a) => a.deployId === item.deployId);
        const requester = approval?.requester.label ?? 'Someone';
        const fires = approval?.fireAt ?? null;
        return {
          key: `approval-${item.deployId}`,
          tone: 'warning',
          icon: <UserCheck />,
          app: item.app,
          what: `${requester} asked to deploy ${sha7(item.sha)}${fires === null ? '' : ` · fires ${new Date(fires).toLocaleString()}`}`,
          at: approval?.requestedAt ?? null,
          actions:
            canAct && approval !== undefined ? (
              <>
                <Button
                  type="button"
                  variant="danger-ghost"
                  size="sm"
                  onClick={() => {
                    setDenyError(null);
                    setDenying(approval);
                  }}
                >
                  {VERBS.deny}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    onReview({ kind: 'approve', app: item.app, sha: item.sha, deployId: item.deployId, requester });
                  }}
                >
                  {approveVerb(item.sha)}
                </Button>
              </>
            ) : null,
        };
      }
      case 'drift': {
        const app = apps.find((a) => a.name === item.app);
        return {
          key: `drift-${item.driftId}`,
          tone: 'warning',
          icon: <GitCompareArrows />,
          app: item.app,
          what: 'is running something Shipyard did not deploy',
          at: app?.drift?.detectedAt ?? null,
          actions: canAct ? (
            <>
              <AdoptLiveButton
                app={item.app}
                driftEventId={item.driftId}
                description={`Records what is running as ${item.app}'s release, so deploys are allowed again. Nothing on the host changes.`}
                onAdopted={onChanged}
              />
              <RedeployLiveButton app={item.app} driftEventId={item.driftId} onStarted={onDeployStarted} />
            </>
          ) : null,
        };
      }
      case 'ci-failed': {
        const app = apps.find((a) => a.name === item.app);
        const shipyard = app?.commits?.buildSource === 'shipyard';
        const failed = newestWithRun(app?.commits?.commits ?? []);
        const runUrl = shipyard ? null : (failed?.run?.url ?? null);
        const label = `View run for ${item.app}`;
        return {
          key: `ci-${item.app}`,
          tone: 'danger',
          icon: <CircleX />,
          app: item.app,
          what: `${shipyard ? STATUS_WORDS.buildFailed : STATUS_WORDS.ciFailed} on ${failed === undefined ? 'the newest push' : sha7(failed.sha)}`,
          at: failed?.run?.completedAt ?? failed?.run?.startedAt ?? null,
          actions:
            runUrl !== null ? (
              <Link href={runUrl} target="_blank" rel="noreferrer" className="shp-row-link" aria-label={label}>
                View run ↗
              </Link>
            ) : failed !== undefined ? (
              <Link asChild className="shp-row-link">
                <RouterLink to={`/apps/${encodeURIComponent(item.app)}/commits/${failed.sha}`} aria-label={label}>
                  View run
                </RouterLink>
              </Link>
            ) : null,
        };
      }
      case 'agent-stale':
        return {
          key: `host-${String(index)}`,
          tone: 'warning',
          icon: <ServerCrash />,
          app: null,
          what: 'The agent has stopped reporting, so live SHAs and drift may be out of date',
          at: system?.agent?.lastHeartbeatAt ?? null,
          actions: <SettingsLink>Open Settings</SettingsLink>,
        };
      case 'agent-token':
        return {
          key: `host-${String(index)}`,
          tone: item.warning === 'expired' ? 'danger' : 'warning',
          icon: <KeyRound />,
          app: null,
          what: item.warning === 'expired' ? 'The agent’s GitHub token has expired' : 'The agent’s GitHub token expires soon',
          at: null,
          actions: <SettingsLink>Renew in Settings</SettingsLink>,
        };
    }
  });

  return (
    <Section title={`Needs you (${String(items.length)})`} surface="plain">
      <Card padding="sm">
        <ul className="shp-needs" aria-label="Needs you">
          {rows.map((row) => (
            <li key={row.key} className="shp-needs__row" data-tone={row.tone}>
              <span className="shp-needs__icon" data-tone={row.tone} aria-hidden="true">
                {row.icon}
              </span>
              <p className="shp-needs__text">
                {row.app === null ? null : <strong>{row.app} </strong>}
                {row.what}
                {row.at === null ? null : <span className="shp-needs__age">{agoShort(row.at, now)}</span>}
              </p>
              {row.actions === null ? null : <div className="shp-action-row shp-needs__actions">{row.actions}</div>}
            </li>
          ))}
        </ul>
      </Card>
      <Modal
        open={denying !== null}
        onOpenChange={(open) => {
          if (!open) setDenying(null);
        }}
        title={denying === null ? `${VERBS.deny} deploy` : `${VERBS.deny} ${denying.app} at ${sha7(denying.sha)}`}
        description="This deploy will not run. It can be requested again later."
        destructive
        footer={
          <FormActions>
            <ModalClose>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </ModalClose>
            <Button
              type="button"
              variant="danger"
              loading={busy}
              onClick={() => {
                if (denying !== null) void deny(denying);
              }}
            >
              {VERBS.deny}
            </Button>
          </FormActions>
        }
      >
        {denyError !== null ? (
          <Alert tone="danger" title={denyError.message} dynamic>
            {denyError.fix}
          </Alert>
        ) : null}
      </Modal>
    </Section>
  );
}
