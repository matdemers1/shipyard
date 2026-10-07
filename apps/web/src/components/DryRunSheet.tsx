import {
  Alert,
  Badge,
  Button,
  Cluster,
  DataList,
  DataListRow,
  DescriptionItem,
  DescriptionList,
  Modal,
  Section,
  Spinner,
  Stack,
  StatusDot,
} from '@d3cloud/ui';
import type { DeployStatus } from '@shipyard/schema';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useCan, useMe } from '../lib/auth';
import { RefusalError } from '../lib/api';
import { getCommitsTo } from '../lib/changelog';
import { shortSha } from '../lib/home';
import { checkName, deployVerb } from '../lib/words';
import { PLANNED_BY_KIND } from './pipeline/stages';
import {
  approveDeploy,
  askedWords,
  checksSummary,
  commitCi,
  commitsToShip,
  DRY_RUN_DEADLINE_SECONDS,
  dryRunTimeout,
  failedFirst,
  getApp,
  hasContractMigration,
  newestGreenInstead,
  pollDeployStatus,
  primaryLabelFor,
  POLL_WAIT_SECONDS,
  rideAlongWarnings,
  startDryRun,
  startReal,
  subtitleFor,
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
  | { kind: 'approve'; app: string; sha: string; deployId: string; requester: string };

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
export function DryRunSheet({ open, onOpenChange, action: requested, onStarted }: DryRunSheetProps) {
  // The sheet can move to another SHA on its own ("Deploy <newest green> instead"), so it holds the
  // action it is showing. A new action from the caller, or closing the sheet, puts it back.
  const [action, setAction] = useState<SheetAction | null>(requested);
  const [seenRequested, setSeenRequested] = useState<SheetAction | null>(requested);
  if (requested !== seenRequested) {
    setSeenRequested(requested);
    setAction(requested);
  } else if (!open && action !== requested) {
    setAction(requested);
  }
  const can = useCan();
  const me = useMe();
  const [phase, setPhase] = useState<DryRunPhase>({ kind: 'starting' });
  const [soakSeconds, setSoakSeconds] = useState<number | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [commits, setCommits] = useState<CommitsResponse | null | 'loading'>('loading');
  const [confirmPhase, setConfirmPhase] = useState<ConfirmPhase>({ kind: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    setConfirmPhase({ kind: 'idle' });
    if (!open || action === null) return;

    setPhase({ kind: 'starting' });
    setSoakSeconds(null);
    setBranch(null);
    setCommits('loading');
    setElapsed(0);

    const controller = new AbortController();
    const currentAction = action;
    const startedAt = Date.now();
    const tick = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    // A dry run that never finishes — a stale agent, or a server that does not answer — stops here
    // with the reason, instead of spinning with the primary button disabled (SHP-DA-014).
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DRY_RUN_DEADLINE_SECONDS * 1000);

    void getApp(action.app)
      .then((app) => {
        if (!stopped.current) {
          setSoakSeconds(app.soakSeconds);
          setBranch(app.defaultBranch ?? null);
        }
      })
      .catch(() => {
        if (!stopped.current) {
          setSoakSeconds(null);
          setBranch(null);
        }
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
            clearTimeout(deadline);
            clearInterval(tick);
            setPhase({ kind: 'ready', deployId: accepted.deployId, status });
            return;
          }
          setPhase({ kind: 'polling', deployId: accepted.deployId, status });
          waitSeconds = POLL_WAIT_SECONDS;
        }
      } catch (error) {
        if (isStopped()) return;
        clearTimeout(deadline);
        clearInterval(tick);
        if (timedOut) {
          const reason = await dryRunTimeout();
          if (!isStopped()) setPhase({ kind: 'error', error: reason });
          return;
        }
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setPhase({ kind: 'error', error: error instanceof RefusalError ? error : (error as RefusalError) });
      }
    }
    void run();

    return () => {
      stopped.current = true;
      clearTimeout(deadline);
      clearInterval(tick);
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
  // The status once the agent has answered; null while it is still working.
  const answered = phase.kind === 'ready' ? phase.status : null;
  // The checks are one result, shown when the agent has answered — not row by row as it works.
  const refused = answered !== null && (answered.refusal !== null || failedGate !== undefined);
  const nothingToShip = status !== null && status.sha === commitsLive(commits) && action.kind !== 'rollback';
  const contractWarning = status !== null && hasContractMigration(status);
  const shipped = commits !== null && commits !== 'loading' ? commitsToShip(commits, action.sha) : [];
  const rideAlong = rideAlongWarnings(shipped, action.sha);
  const greenInstead = newestGreenInstead(commits, action, answered);
  // An approval runs the same steps as the deploy it releases.
  const steps = PLANNED_BY_KIND[action.kind === 'rollback' ? 'rollback' : 'deploy'];

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
      description={subtitleFor(commits, action.sha, shipped.length)}
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
              {primaryLabelFor(action)}
            </Button>
          ) : null}
        </>
      }
    >
      <Stack gap="16">
        {action.kind === 'approve' ? (
          <DescriptionList>
            <DescriptionItem term="Requested by">{action.requester}</DescriptionItem>
            <DescriptionItem term="Approving as">{me?.displayName ?? me?.email ?? 'you'}</DescriptionItem>
          </DescriptionList>
        ) : null}

        {commits !== 'loading' && commits !== null
          ? rideAlong.map((warning) => (
              <Alert key={warning} tone="warning">
                {warning}
              </Alert>
            ))
          : null}

        {commits === null ? (
          <Alert tone="info">Commits unavailable.</Alert>
        ) : commits === 'loading' ? null : (
          <Section title="What ships" surface="plain" headingLevel={3}>
            <DataList empty={<span>No commits to show.</span>}>
              {shipped.map((c) => {
                const ci = commitCi(c.ci, commits.source);
                return (
                  <DataListRow
                    key={c.sha}
                    leading={<code style={CODE_STYLE}>{shortSha(c.sha)}</code>}
                    title={c.message}
                    meta={
                      <>
                        {c.taskIds.map((id) => (
                          <Badge key={id} size="sm">
                            {id}
                          </Badge>
                        ))}
                        <StatusDot tone={ci.tone} size="sm">
                          {ci.words}
                        </StatusDot>
                      </>
                    }
                  />
                );
              })}
            </DataList>
          </Section>
        )}

        {phase.kind === 'error' ? (
          <Alert tone="danger" title={phase.error.message} dynamic>
            {phase.error.fix}
          </Alert>
        ) : null}

        {phase.kind === 'starting' || phase.kind === 'polling' ? (
          <p>
            <Spinner size="sm" /> {checkingWords(phase)} · {String(elapsed)}s
          </p>
        ) : null}

        {answered !== null ? (
          <>
            {answered.refusal !== null ? (
              <Alert
                tone="danger"
                title={answered.refusal.message}
                dynamic
                actions={
                  greenInstead !== null ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setAction({ kind: 'deploy', app: action.app, sha: greenInstead });
                      }}
                    >
                      {`${deployVerb(greenInstead)} instead`}
                    </Button>
                  ) : undefined
                }
              >
                {answered.refusal.fix}
              </Alert>
            ) : null}

            {nothingToShip ? <Alert tone="info">Nothing to deploy — live is {answered.sha.slice(0, 7)}.</Alert> : null}

            {gates.length > 0 ? (
              <Section
                title="Checks"
                surface="plain"
                headingLevel={3}
                description={`${checksSummary(gates) ?? ''} · Asked the agent · ${askedWords(answered.endedAt ?? answered.createdAt)}`}
              >
                <DataList>
                  {failedFirst(gates).map((g) => (
                    <DataListRow
                      key={g.gate}
                      title={checkName(g.gate, { branch })}
                      description={g.reason}
                      truncate={false}
                      meta={
                        <>
                          <code style={CODE_STYLE}>{g.gate}</code>
                          <StatusDot tone={g.pass ? 'neutral' : 'danger'} size="sm">
                            {g.pass ? 'Passed' : 'Failed'}
                          </StatusDot>
                        </>
                      }
                    />
                  ))}
                </DataList>
              </Section>
            ) : null}
          </>
        ) : null}

        {!refused ? (
          <Section title="What happens" surface="plain" headingLevel={3}>
            <Stack gap="8">
              <Cluster as="ol" gap="8">
                {steps.map((step, i) => (
                  <li key={step.key}>
                    {i > 0 ? <span aria-hidden="true">→ </span> : null}
                    {step.key === 'soak' && soakSeconds !== null ? `${step.label} ${String(soakSeconds)}s` : step.label}
                  </li>
                ))}
              </Cluster>
              <span style={CODE_STYLE}>
                {action.kind === 'rollback'
                  ? 'Only the images change. Data is not restored.'
                  : 'If check or soak fails, Shipyard rolls the images back. Data is not restored automatically.'}
              </span>
            </Stack>
          </Section>
        ) : null}

        {answered !== null && contractWarning ? (
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
      </Stack>
    </Modal>
  );
}

/** Small, muted and monospace: the gate code and the short SHA, secondary to the words beside them. */
const CODE_STYLE: CSSProperties = {
  color: 'var(--color-fg-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-13)',
};

/** What the sheet is waiting on, so a slow agent reads differently from a busy one. */
function checkingWords(phase: DryRunPhase): string {
  if (phase.kind === 'starting') return 'Starting the checks';
  if (phase.kind === 'polling' && (phase.status === null || phase.status.state === 'queued')) {
    return 'Waiting for the agent to pick this up';
  }
  return 'The agent is running the checks';
}

function commitsLive(commits: CommitsResponse | null | 'loading'): string | null {
  return commits === null || commits === 'loading' ? null : commits.live;
}
