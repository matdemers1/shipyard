import { Alert, Button, FormField, Input, Modal, Stack, Textarea } from '@d3cloud/ui';
import { useState, type SyntheticEvent } from 'react';
import { RefusalError } from '../lib/api';
import { FREEZE_REASON_MAX, freeze, freezeReasonIsValid } from '../lib/appdetail';

/**
 * Freeze and unfreeze (SHP-T-5.1, SHP-REQ-077, SHP-D-049). Freezing needs a reason, shown in every
 * deploy refusal while it stands; an optional `until` clears it automatically. Rollbacks and
 * restores stay allowed while frozen — only new deploys are refused. Deployer or admin only; a
 * viewer sees neither action.
 */

interface Problem {
  message: string;
  fix: string;
}

function problemOf(error: unknown): Problem {
  if (error instanceof RefusalError) return { message: error.message, fix: error.fix };
  return { message: 'Shipyard did not answer.', fix: 'Check your connection and try again.' };
}

/** `datetime-local`'s value has no timezone; read as local time, sent to the server as ISO. */
function localToIso(value: string): string | undefined {
  if (value.trim() === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export interface FreezeSheetProps {
  app: string;
  onFrozen: () => void;
}

/** "Freeze" and its form: a reason, and an optional "until" after which the freeze lifts itself. */
export function FreezeSheet({ app, onFrozen }: FreezeSheetProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const valid = freezeReasonIsValid(reason);

  const close = (): void => {
    setOpen(false);
    setReason('');
    setUntil('');
    setProblem(null);
  };

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setProblem(null);
    try {
      await freeze.set(app, reason.trim(), localToIso(until));
      close();
      onFrozen();
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
        <Button type="button" variant="danger">
          Freeze
        </Button>
      }
      title={`Freeze ${app}`}
      description="Refuses new deploys until this is cleared. Rollbacks and restores are still allowed."
    >
      <Stack as="form" gap="16" onSubmit={(e) => void submit(e)} noValidate>
        <FormField
          label="Reason"
          help={`Shown in every deploy refusal while ${app} is frozen. Up to ${String(FREEZE_REASON_MAX)} characters.`}
          {...(problem !== null ? { error: `${problem.message} ${problem.fix}` } : {})}
        >
          <Textarea
            value={reason}
            maxLength={FREEZE_REASON_MAX}
            rows={3}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
        </FormField>
        <FormField label="Until" help="Optional. Leave blank for a freeze that lasts until it is cleared.">
          <Input
            type="datetime-local"
            value={until}
            onChange={(e) => {
              setUntil(e.target.value);
            }}
          />
        </FormField>
        <Stack gap="8" align="end">
          <Button type="submit" variant="danger" disabled={!valid} loading={busy}>
            Freeze {app}
          </Button>
        </Stack>
      </Stack>
    </Modal>
  );
}

export interface UnfreezeButtonProps {
  app: string;
  onCleared: () => void;
}

/** "Unfreeze": clears the active freeze, with confirmation. */
export function UnfreezeButton({ app, onCleared }: UnfreezeButtonProps) {
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
      await freeze.clear(app);
      close();
      onCleared();
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
          Unfreeze
        </Button>
      }
      title={`Unfreeze ${app}`}
      description="Deploys are allowed again once this is cleared."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="button" variant="primary" loading={busy} onClick={() => void confirm()}>
            Unfreeze {app}
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
