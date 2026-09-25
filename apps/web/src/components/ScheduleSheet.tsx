import { Alert, Button, FormField, Input, Modal, Select, Stack } from '@d3cloud/ui';
import { useState, type SyntheticEvent } from 'react';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { fireAtProblem, localToIso, schedules, shaIsValid, type ScheduleEntry } from '../lib/schedules';

/**
 * "Schedule a deploy" (S9, SHP-T-5.4): an app, a full SHA and a local date and time. Nothing is
 * checked against the gates now — every one re-runs when it fires (SHP-D-039). For an app that
 * requires approval, scheduling it here is the approval (SHP-D-051). Deployer or admin only.
 */

export interface ScheduleSheetProps {
  /** The apps the agent has reported, by name. */
  apps: string[];
  onScheduled: (entry: ScheduleEntry) => void;
}

export function ScheduleSheet({ apps, onScheduled }: ScheduleSheetProps) {
  const [open, setOpen] = useState(false);
  const [app, setApp] = useState('');
  const [sha, setSha] = useState('');
  const [at, setAt] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<RefusalError | null>(null);

  const chosenApp = app === '' ? (apps[0] ?? '') : app;
  const trimmedSha = sha.trim().toLowerCase();
  const shaOk = shaIsValid(trimmedSha);
  const iso = localToIso(at);
  const timeProblem = fireAtProblem(iso);
  const valid = chosenApp !== '' && shaOk && timeProblem === null;

  const close = (): void => {
    setOpen(false);
    setApp('');
    setSha('');
    setAt('');
    setTouched(false);
    setRefused(null);
  };

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setTouched(true);
    if (!valid || iso === null) return;
    setBusy(true);
    setRefused(null);
    try {
      const entry = await schedules.create({ app: chosenApp, sha: trimmedSha, fireAt: iso });
      close();
      onScheduled(entry);
    } catch (error) {
      setRefused(error instanceof RefusalError ? error : unreachableRefusal());
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
        <Button type="button" variant="primary" disabled={apps.length === 0}>
          Schedule a deploy
        </Button>
      }
      title="Schedule a deploy"
      description="Every gate re-runs when it fires; if one fails then, the deploy is refused and the reason shown here."
    >
      <Stack as="form" gap="16" onSubmit={(e) => void submit(e)} noValidate>
        <FormField label="App" help="For an app that requires approval, scheduling it is your approval.">
          <Select
            value={chosenApp}
            onValueChange={setApp}
            options={apps.map((name) => ({ value: name, label: name }))}
          />
        </FormField>
        <FormField
          label="Commit SHA"
          help="The full 40-character SHA. A schedule deploys exactly this commit, never the latest."
          {...(touched && !shaOk ? { error: 'Enter the full 40-character commit SHA.' } : {})}
        >
          <Input
            value={sha}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="text"
            onChange={(e) => {
              setSha(e.target.value);
            }}
          />
        </FormField>
        <FormField
          label="When"
          help="Your local time. At most 30 days ahead."
          {...(touched && timeProblem !== null ? { error: timeProblem } : {})}
        >
          <Input
            type="datetime-local"
            value={at}
            onChange={(e) => {
              setAt(e.target.value);
            }}
          />
        </FormField>
        {refused !== null ? (
          <Alert tone="danger" title={refused.message} dynamic>
            {refused.fix}
          </Alert>
        ) : null}
        <Stack gap="8" align="end">
          <Button type="submit" variant="primary" loading={busy}>
            Schedule {chosenApp}
          </Button>
        </Stack>
      </Stack>
    </Modal>
  );
}
