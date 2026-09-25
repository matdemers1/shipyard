import { Alert, Button, DescriptionItem, DescriptionList, FormField, Input, Link, Modal, Stack } from '@d3cloud/ui';
import { useState, type SyntheticEvent } from 'react';
import { RefusalError } from '../lib/api';
import { Link as RouterLink } from 'react-router-dom';
import { REASON_MAX, appDetail, reasonIsValid, shortDigest, when, type DriftService, type PendingRedeploy } from '../lib/appdetail';

/**
 * Drift (SHP-D-031): the app is running images that differ from its recorded release, and new
 * deploys are refused until a deployer chooses. Adopting what is running needs a one-line reason
 * (SHP-D-085, SHP-REQ-066); redeploying the recorded release asks for confirmation. Nothing is ever
 * reverted automatically. A viewer sees the banner and no actions.
 */

interface Problem {
  message: string;
  fix: string;
}

function problemOf(error: unknown): Problem {
  if (error instanceof RefusalError) return { message: error.message, fix: error.fix };
  return { message: 'Shipyard did not answer.', fix: 'Check your connection and try again.' };
}

export interface AdoptLiveButtonProps {
  app: string;
  /** The open drift event whose digests the deployer is looking at; absent for an app never deployed. */
  driftEventId?: string;
  /** The consequence, shown in the dialog. */
  description: string;
  onAdopted: () => void;
}

/**
 * "Adopt what's running" and its form. The submit stays disabled until a reason is typed: the
 * server refuses an adopt without one, and the console does not offer what would be refused.
 */
export function AdoptLiveButton({ app, driftEventId, description, onAdopted }: AdoptLiveButtonProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const valid = reasonIsValid(reason);

  const close = (): void => {
    setOpen(false);
    setReason('');
    setProblem(null);
  };

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setProblem(null);
    try {
      await appDetail.adopt(app, reason.trim(), driftEventId);
      close();
      onAdopted();
    } catch (error) {
      setProblem(problemOf(error));
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
        <Button type="button" variant="secondary">
          Adopt what&apos;s running
        </Button>
      }
      title={`Adopt what's running on ${app}`}
      description={description}
    >
      <Stack as="form" gap="16" onSubmit={(e) => void submit(e)} noValidate>
        <FormField
          label="Reason"
          help={`One line, up to ${String(REASON_MAX)} characters. It is kept with the record.`}
          {...(problem !== null ? { error: `${problem.message} ${problem.fix}` } : {})}
        >
          <Input
            value={reason}
            maxLength={REASON_MAX}
            autoComplete="off"
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
        </FormField>
        <Stack gap="8" align="end">
          <Button type="submit" variant="primary" disabled={!valid} loading={busy}>
            Adopt with this reason
          </Button>
        </Stack>
      </Stack>
    </Modal>
  );
}

function RedeployButton({
  app,
  driftEventId,
  onStarted,
}: {
  app: string;
  driftEventId: string;
  onStarted: (deployId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

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
      setProblem(problemOf(error));
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
        <Button type="button" variant="secondary">
          Redeploy recorded release
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

export interface DriftBannerProps {
  app: string;
  /** The open drift event: adopting or redeploying names it, so a stale view is refused. */
  eventId: string;
  detectedAt: string;
  services: DriftService[];
  /** A redeploy of the recorded release already requested for this drift. */
  pending?: PendingRedeploy | null;
  canAct: boolean;
  /** After a resolution; a redeploy passes the deploy it started. */
  onResolved: (deployId?: string) => void;
}

export function DriftBanner({ app, eventId, detectedAt, services, pending = null, canAct, onResolved }: DriftBannerProps) {
  const differing = services.filter((s) => s.differs).map((s) => s.service);
  const named = differing.length > 0 ? differing.join(', ') : 'images';
  return (
    <Alert
      tone="warning"
      title={`${app} is running something other than its recorded release`}
      actions={
        canAct ? (
          <>
            <AdoptLiveButton
              app={app}
              driftEventId={eventId}
              description={`Records the running ${named} as ${app}'s release, so deploys are allowed again. Nothing on the host changes.`}
              onAdopted={() => {
                onResolved();
              }}
            />
            <RedeployButton app={app} driftEventId={eventId} onStarted={onResolved} />
          </>
        ) : undefined
      }
    >
      <Stack gap="8">
        <p>
          Detected {when(detectedAt)}. New deploys are refused until a deployer adopts what is running or redeploys
          the recorded release. Shipyard never reverts it on its own.
        </p>
        {pending !== null ? (
          <p>
            A redeploy of the recorded release was requested{pending.requestedBy !== null ? ` by ${pending.requestedBy}` : ''}. The drift
            is resolved when the agent reports the recorded release running again
            {pending.deployId !== null ? (
              <>
                {': '}
                <Link asChild variant="inline">
                  <RouterLink to={`/deploys/${pending.deployId}`}>see the rollback</RouterLink>
                </Link>
              </>
            ) : null}
            .
          </p>
        ) : null}
        <DescriptionList aria-label="Observed against recorded, per service">
          {services.map((s) => (
            <DescriptionItem key={s.service} term={s.service}>
              <code>{shortDigest(s.observed)}</code> running, <code>{shortDigest(s.recorded)}</code> recorded
              {s.differs ? ' (differs)' : ''}
            </DescriptionItem>
          ))}
        </DescriptionList>
        {canAct ? null : <p>Your role is viewer: a deployer resolves drift.</p>}
      </Stack>
    </Alert>
  );
}
