import { Alert, Badge, Button, DataList, DataListRow, DescriptionItem, DescriptionList, Modal, Spinner } from '@d3cloud/ui';
import type { DeployStatus } from '@shipyard/schema';
import { useEffect, useRef, useState } from 'react';
import { useCan, useMe } from '../lib/auth';
import { RefusalError } from '../lib/api';
import { getCommitsTo } from '../lib/changelog';
import {
  approveDeploy,
  commitsToShip,
  getApp,
  hasContractMigration,
  pollDeployStatus,
  POLL_WAIT_SECONDS,
  startDryRun,
  startReal,
  titleFor,
  type CommitsResponse,
} from '../lib/dryrun';

/**
 * What the sheet is asked to confirm (SHP-D-068). Home and App detail open it; approvals open it
 * from the banner. The contract is fixed by the lead so those screens and the sheet (SHP-T-3.3)
 * are built in parallel against the same props.
 */
export type SheetAction =
  | { kind: 'deploy'; app: string; sha: string }
  | { kind: 'rollback'; app: string; sha: string; toDeployId: string }
  | { kind: 'approve'; app: string; sha: string; deployId: string };

export interface DryRunSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null while closed. */
  action: SheetAction | null;
  /** Called with the deploy ID once a deploy, rollback or approval has been started. */
  onStarted?: (deployId: string) => void;
}

type DryRunPhase =
  | { kind: 'starting' }
  | { kind: 'polling'; deployId: string; status: DeployStatus | null }
  | { kind: 'ready'; deployId: string; status: DeployStatus }
  | { kind: 'error'; error: RefusalError };

type ConfirmPhase = { kind: 'idle' } | { kind: 'confirming' } | { kind: 'refused'; error: RefusalError };

function isTerminal(state: DeployStatus['state']): boolean {
  return ['succeeded', 'failed', 'rolled_back', 'refused', 'cancelled'].includes(state);
}

/** The dry-run sheet (SHP-T-3.3, SHP-REQ-057, SHP-REQ-050, SHP-D-068). */
export function DryRunSheet({ open, onOpenChange, action, onStarted }: DryRunSheetProps) {
  const can = useCan();
  const me = useMe();
  const [phase, setPhase] = useState<DryRunPhase>({ kind: 'starting' });
  const [soakSeconds, setSoakSeconds] = useState<number | null>(null);
  const [commits, setCommits] = useState<CommitsResponse | null | 'loading'>('loading');
  const [confirmPhase, setConfirmPhase] = useState<ConfirmPhase>({ kind: 'idle' });
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    setConfirmPhase({ kind: 'idle' });
    if (!open || action === null) return;

    setPhase({ kind: 'starting' });
    setSoakSeconds(null);
    setCommits('loading');

    const controller = new AbortController();
    const currentAction = action;

    void getApp(action.app)
      .then((app) => {
        if (!stopped.current) setSoakSeconds(app.soakSeconds);
      })
      .catch(() => {
        if (!stopped.current) setSoakSeconds(null);
      });

    void getCommitsTo(action.app, action.sha)
      .then((res) => {
        if (!stopped.current) setCommits(res);
      })
      .catch(() => {
        if (!stopped.current) setCommits(null);
      });

    const isStopped = (): boolean => stopped.current;

    async function run(): Promise<void> {
      try {
        const accepted = await startDryRun(currentAction, controller.signal);
        if (isStopped()) return;
        setPhase({ kind: 'polling', deployId: accepted.deployId, status: null });
        let waitSeconds = 0;
        for (;;) {
          const status = await pollDeployStatus(accepted.deployId, waitSeconds, controller.signal);
          if (isStopped()) return;
          if (isTerminal(status.state)) {
            setPhase({ kind: 'ready', deployId: accepted.deployId, status });
            return;
          }
          setPhase({ kind: 'polling', deployId: accepted.deployId, status });
          waitSeconds = POLL_WAIT_SECONDS;
        }
      } catch (error) {
        if (isStopped()) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setPhase({ kind: 'error', error: error instanceof RefusalError ? error : (error as RefusalError) });
      }
    }
    void run();

    return () => {
      stopped.current = true;
      controller.abort();
    };
  }, [open, action]);

  if (action === null) {
    return <Modal open={open} onOpenChange={onOpenChange} title="Deploy" />;
  }

  const status = phase.kind === 'ready' ? phase.status : phase.kind === 'polling' ? phase.status : null;
  const gates = status?.gates ?? [];
  const failedGate = gates.find((g) => !g.pass);
  const ready = phase.kind === 'ready';
  const nothingToShip = status !== null && status.sha === commitsLive(commits) && action.kind !== 'rollback';
  const contractWarning = status !== null && hasContractMigration(status);
  const shipped = status !== null && commits !== null && commits !== 'loading' ? commitsToShip(commits, status.sha) : [];

  const confirmDisabled =
    !can ||
    !ready ||
    status === null ||
    status.refusal !== null ||
    failedGate !== undefined ||
    confirmPhase.kind === 'confirming';

  async function onConfirm(): Promise<void> {
    if (action === null || phase.kind !== 'ready') return;
    setConfirmPhase({ kind: 'confirming' });
    try {
      const started =
        action.kind === 'approve' ? await approveDeploy(action.deployId) : await startReal(action);
      onStarted?.(started.deployId);
      onOpenChange(false);
    } catch (error) {
      if (error instanceof RefusalError) {
        setConfirmPhase({ kind: 'refused', error });
      } else {
        throw error;
      }
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={titleFor(action)}
      description={`Target: ${action.sha.slice(0, 7)}`}
      size="lg"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          {can ? (
            <Button
              variant="primary"
              loading={confirmPhase.kind === 'confirming'}
              disabled={confirmDisabled}
              onClick={() => void onConfirm()}
            >
              Confirm
            </Button>
          ) : null}
        </>
      }
    >
      <DescriptionList>
        <DescriptionItem term="Target SHA">
          <code>{action.sha}</code>
        </DescriptionItem>
        <DescriptionItem term="Requested by">{me?.displayName ?? me?.email ?? 'you'}</DescriptionItem>
        <DescriptionItem term="Soak duration" numeric>
          {soakSeconds === null ? '—' : `${String(soakSeconds)}s`}
        </DescriptionItem>
      </DescriptionList>

      {phase.kind === 'error' ? (
        <Alert tone="danger" title={phase.error.message} dynamic>
          {phase.error.fix}
        </Alert>
      ) : null}

      {phase.kind === 'starting' || phase.kind === 'polling' ? (
        <p>
          <Spinner size="sm" /> Checking gates…
        </p>
      ) : null}

      {status !== null ? (
        <>
          {status.refusal !== null ? (
            <Alert tone="danger" title={status.refusal.message} dynamic>
              {status.refusal.fix}
            </Alert>
          ) : null}

          {nothingToShip ? <Alert tone="info">Nothing to ship — live is {status.sha.slice(0, 7)}.</Alert> : null}

          {commits === null ? (
            <Alert tone="info">Commits unavailable.</Alert>
          ) : commits === 'loading' ? null : (
            <DataList empty={<span>No commits to show.</span>}>
              {shipped.map((c) => (
                <DataListRow
                  key={c.sha}
                  title={c.message}
                  description={c.sha.slice(0, 7)}
                  meta={c.taskIds.map((id) => (
                    <Badge key={id} size="sm">
                      {id}
                    </Badge>
                  ))}
                />
              ))}
            </DataList>
          )}

          <DataList>
            {gates.map((g) => (
              <DataListRow
                key={g.gate}
                title={g.gate}
                description={g.pass ? undefined : g.reason}
                meta={<Badge tone={g.pass ? 'neutral' : 'danger'}>{g.pass ? 'passed' : 'failed'}</Badge>}
              />
            ))}
          </DataList>

          {contractWarning ? (
            <Alert tone="warning" title="This release includes a data migration">
              A release labelled <code>contract</code> is never auto-rolled back — a failed soak needs a confirmed,
              human-initiated restore.
            </Alert>
          ) : null}

          {confirmPhase.kind === 'refused' ? (
            <Alert tone="danger" title={confirmPhase.error.message} dynamic>
              {confirmPhase.error.fix}
            </Alert>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}

function commitsLive(commits: CommitsResponse | null | 'loading'): string | null {
  return commits === null || commits === 'loading' ? null : commits.live;
}
