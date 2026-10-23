import { Alert, Button, Card, FormActions, Link, Modal, ModalClose, Section } from '@d3cloud/ui';
import type { SystemStatus } from '@shipyard/schema';
import type { StackUpdateStatus } from '@shipyard/schema';
import { CircleX, GitCompareArrows, KeyRound, Layers, ServerCrash, UserCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { RefusalError, request } from '../lib/api';
import { newestWithRun, sha7 } from '../lib/appstatus';
import type { HomeApp, PendingApproval } from '../lib/home';
import type { NeedsYouItem } from '../lib/needsyou';
import { requestedChange, stacks as stackApi, type StackNeeds, type StackView } from '../lib/stacks';
import {
  DENY_STACK_CONSEQUENCE,
  FAILED_STACK_FALLBACK,
  HELD_STACK_FALLBACK,
  OPEN_STACK,
  SHEET_WORDS,
  STATUS_WORDS,
  VERBS,
  approveStackLabel,
  approveStackVerb,
  approveVerb,
  denyStackWords,
  failedStackWords,
  heldStackWords,
  openStackOnHostWords,
} from '../lib/words';
import { AdoptLiveButton, RedeployButton } from './DriftBanner';
import type { SheetAction } from './DryRunSheet';
import { agoShort } from './pipeline/stages';

/**
 * Needs you (SHP-T-13.8, SHP-REQ-155, SHP-D-089): everything waiting on a person, first on Apps,
 * each with its action inline — approve or deny a deploy, adopt or redeploy over drift, open the
 * run that failed, renew the token in Settings. The rows are `needsYouItems` itself, the function
 * the nav's Apps badge counts, over the same snapshot, so the badge and this list always agree.
 * A viewer sees every row and no state-changing action (SHP-REQ-105).
 *
 * A stack update held for approval (SHP-T-16.6, SHP-REQ-199) gets Deny and "Approve and update" in
 * the same style as a deploy's; a stack whose newest update failed or was rolled back is a warning
 * row that opens the stack's sheet on Host.
 */

/** "update 17.1.1 → 17.1.2 · asked by …": what a held stack request would do, and who asked. */
export function heldStackLine(update: Pick<StackUpdateStatus, 'kind' | 'digests' | 'requesterLabel'>, stack: StackView | undefined): string {
  const { from, to } = update.kind === 'rollback' ? { from: null, to: null } : requestedChange(update, stack);
  return heldStackWords(update.kind, from, to, update.requesterLabel);
}

/** "update rolled back — <message>": a failed or rolled-back stack update; its fix is the row's second line. */
export function failedStackLine(update: Pick<StackUpdateStatus, 'kind' | 'state' | 'refusal'>): string {
  return failedStackWords(update.kind, update.state, update.refusal?.message ?? null);
}

type Tone = 'attention' | 'warning' | 'danger';

interface Row {
  key: string;
  tone: Tone;
  icon: ReactNode;
  /** The app's name, or null for the host. */
  app: string | null;
  what: string;
  /** A second line, verbatim: a failed stack update's fix (SHP-REQ-200). */
  detail?: string;
  at: string | null;
  actions: ReactNode;
}

export interface NeedsYouProps {
  items: readonly NeedsYouItem[];
  apps: readonly HomeApp[];
  approvals: readonly PendingApproval[];
  system: SystemStatus | null;
  /** Held and failed stack updates (SHP-T-16.6); absent or null from a server without them. */
  stackNeeds?: StackNeeds | null;
  /** The adopted stacks, for the tags a held request moves between. */
  stacks?: readonly StackView[] | null;
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
  stackNeeds = null,
  stacks = null,
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
  const [denyingStack, setDenyingStack] = useState<StackUpdateStatus | null>(null);
  const [stackBusy, setStackBusy] = useState<string | null>(null);
  const [stackError, setStackError] = useState<RefusalError | null>(null);

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

  /** Approve or deny a held stack update; a refusal is shown above the list, verbatim. */
  const decideStack = async (update: StackUpdateStatus, decision: 'approve' | 'deny'): Promise<void> => {
    setStackBusy(update.id);
    setStackError(null);
    try {
      await (decision === 'approve' ? stackApi.approve(update.id) : stackApi.deny(update.id));
      setDenyingStack(null);
      onChanged();
    } catch (err) {
      const error = err instanceof RefusalError ? err : null;
      setStackError(error);
      if (decision === 'deny') setDenyError(error);
    } finally {
      setStackBusy(null);
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
      case 'stack-approval': {
        const held = stackNeeds?.approvals.find((u) => u.id === item.updateId);
        const stack = stacks?.find((st) => st.name === item.stack);
        return {
          key: `stack-approval-${item.updateId}`,
          tone: 'warning',
          icon: <UserCheck />,
          app: item.stack,
          what: held === undefined ? HELD_STACK_FALLBACK : heldStackLine(held, stack),
          at: held?.createdAt ?? null,
          actions:
            canAct && held !== undefined ? (
              <>
                <Button
                  type="button"
                  variant="danger-ghost"
                  size="sm"
                  disabled={stackBusy !== null}
                  aria-label={denyStackWords(item.stack, held.kind)}
                  onClick={() => {
                    setDenyError(null);
                    setDenyingStack(held);
                  }}
                >
                  {VERBS.deny}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  loading={stackBusy === held.id}
                  disabled={stackBusy !== null && stackBusy !== held.id}
                  aria-label={approveStackLabel(held.kind, item.stack)}
                  onClick={() => {
                    void decideStack(held, 'approve');
                  }}
                >
                  {approveStackVerb(held.kind)}
                </Button>
              </>
            ) : null,
        };
      }
      case 'stack-failed': {
        const failed = stackNeeds?.failed.find((u) => u.id === item.updateId);
        return {
          key: `stack-failed-${item.updateId}`,
          tone: failed?.state === 'failed' ? 'danger' : 'warning',
          icon: <Layers />,
          app: item.stack,
          what: failed === undefined ? FAILED_STACK_FALLBACK : failedStackLine(failed),
          ...(failed === undefined || failed.refusal === null ? {} : { detail: failed.refusal.fix }),
          at: failed?.endedAt ?? failed?.createdAt ?? null,
          actions: (
            <Link asChild className="shp-row-link">
              <RouterLink to={`/host?stack=${encodeURIComponent(item.stack)}`} aria-label={openStackOnHostWords(item.stack)}>
                {OPEN_STACK}
              </RouterLink>
            </Link>
          ),
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
              <RedeployButton app={item.app} driftEventId={item.driftId} onStarted={onDeployStarted} label="Redeploy live" size="sm" />
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
      {stackError !== null && denyingStack === null ? (
        <Alert tone="danger" title={stackError.message} dynamic>
          {stackError.fix}
        </Alert>
      ) : null}
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
                {row.detail === undefined ? null : <span className="shp-needs__detail">{row.detail}</span>}
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
      <Modal
        open={denyingStack !== null}
        onOpenChange={(open) => {
          if (!open) setDenyingStack(null);
        }}
        title={denyingStack === null ? VERBS.deny : denyStackWords(denyingStack.stack, denyingStack.kind)}
        description={DENY_STACK_CONSEQUENCE}
        destructive
        footer={
          <FormActions>
            <ModalClose>
              <Button type="button" variant="secondary">
                {SHEET_WORDS.cancel}
              </Button>
            </ModalClose>
            <Button
              type="button"
              variant="danger"
              loading={stackBusy !== null}
              onClick={() => {
                if (denyingStack !== null) void decideStack(denyingStack, 'deny');
              }}
            >
              {VERBS.deny}
            </Button>
          </FormActions>
        }
      >
        {denyError !== null && denyingStack !== null ? (
          <Alert tone="danger" title={denyError.message} dynamic>
            {denyError.fix}
          </Alert>
        ) : null}
      </Modal>
    </Section>
  );
}
