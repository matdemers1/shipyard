import { Alert, Badge, Button, DataList, DataListRow, EmptyState, FormActions, Modal, ModalClose, Page, PageHeader, Section, Skeleton, Stack } from '@d3cloud/ui';
import { useCallback, useEffect, useState } from 'react';
import { ScheduleSheet } from '../components/ScheduleSheet';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { sha7, when } from '../lib/appdetail';
import { useCan } from '../lib/auth';
import { approvalLabel, outcomeIsBad, outcomeLabel, schedules, type ScheduleEntry, type ScheduleList } from '../lib/schedules';
import { fetchAppNames } from '../lib/timeline';

/**
 * Schedules (S9), `/schedules` (SHP-T-5.4, SHP-REQ-080/081): upcoming scheduled deploys with the
 * approval each carries, and recently fired or cancelled ones with their outcome — a schedule
 * refused at fire time shows the refusal's reason. A deployer schedules ("Schedule a deploy"),
 * cancels an upcoming one, and approves one a token scheduled for an approval-required app; a
 * viewer reads.
 */

type Load = { status: 'loading' } | { status: 'error'; error: RefusalError } | { status: 'ready'; data: ScheduleList };

type Pending = { action: 'cancel' | 'approve'; entry: ScheduleEntry };

function problemOf(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

interface ConfirmProps {
  pending: Pending | null;
  onClose: () => void;
  onDone: () => void;
}

/** Confirms a cancel or an approval. */
function Confirm({ pending, onClose, onDone }: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<RefusalError | null>(null);

  useEffect(() => {
    setBusy(false);
    setRefused(null);
  }, [pending]);

  async function confirm(): Promise<void> {
    if (pending === null) return;
    setBusy(true);
    setRefused(null);
    try {
      if (pending.action === 'cancel') await schedules.cancel(pending.entry.id);
      else await schedules.approve(pending.entry.deployId);
      onDone();
    } catch (error) {
      setRefused(problemOf(error));
      setBusy(false);
    }
  }

  const entry = pending?.entry;
  const name = entry === undefined ? '' : `${entry.app} at ${sha7(entry.sha)}`;
  const cancel = pending?.action === 'cancel';
  return (
    <Modal
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={cancel ? `Cancel the deploy of ${name}` : `Approve the deploy of ${name}`}
      description={
        entry === undefined
          ? undefined
          : cancel
            ? `It was due ${when(entry.fireAt)}. It will not run; schedule it again if it should.`
            : `It runs ${when(entry.fireAt)} with no further approval. Every gate still re-runs then.`
      }
      {...(cancel ? { destructive: true } : {})}
      footer={
        <FormActions>
          <ModalClose>
            <Button type="button" variant="secondary">
              {cancel ? 'Keep it' : 'Not now'}
            </Button>
          </ModalClose>
          <Button type="button" variant={cancel ? 'danger' : 'primary'} loading={busy} onClick={() => void confirm()}>
            {cancel ? 'Cancel deploy' : 'Approve'}
          </Button>
        </FormActions>
      }
    >
      {refused !== null ? (
        <Alert tone="danger" title={refused.message} dynamic>
          {refused.fix}
        </Alert>
      ) : null}
    </Modal>
  );
}

export function Schedules() {
  const can = useCan();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [apps, setApps] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reloads, setReloads] = useState(0);

  const reload = useCallback(() => {
    setReloads((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    schedules
      .list(controller.signal)
      .then((data) => {
        setLoad({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ status: 'error', error: problemOf(error) });
      });
    return () => {
      controller.abort();
    };
  }, [reloads]);

  useEffect(() => {
    if (!can) return;
    let live = true;
    fetchAppNames()
      .then((names) => {
        if (live) setApps(names);
      })
      .catch(() => {
        if (live) setApps([]);
      });
    return () => {
      live = false;
    };
  }, [can]);

  const header = (
    <PageHeader
      title="Schedules"
      description="Deploys set for later. Every gate re-runs when one fires."
      {...(can ? { actions: <ScheduleSheet apps={apps} onScheduled={reload} /> } : {})}
    />
  );

  if (load.status === 'loading') {
    return (
      <Page aria-busy="true">
        <Stack gap="24">
          {header}
          <Skeleton variant="text" lines={6} />
        </Stack>
      </Page>
    );
  }

  if (load.status === 'error') {
    return (
      <Page>
        <Stack gap="24">
          {header}
          <EmptyState
            kind="error"
            heading={load.error.message}
            headingLevel={2}
            action={
              <Button type="button" onClick={reload}>
                Try again
              </Button>
            }
          >
            {load.error.fix}
          </EmptyState>
        </Stack>
      </Page>
    );
  }

  const { upcoming, past } = load.data;
  return (
    <Page>
      <Stack gap="24">
        {header}
        {!can ? <Alert tone="info">Your role can read schedules but not change them.</Alert> : null}

        <Section title="Upcoming" description="Soonest first, with the approval each one carries.">
          <DataList
            aria-label="Upcoming deploys"
            empty={
              <EmptyState kind="empty" heading="Nothing scheduled" size="inline">
                {can ? 'Schedule a deploy to have it run later, with every gate checked again then.' : 'No deploys are set for later.'}
              </EmptyState>
            }
          >
            {upcoming.map((entry) => (
              <DataListRow
                key={entry.id}
                truncate={false}
                title={`${entry.app} · ${sha7(entry.sha)}`}
                description={`${when(entry.fireAt)} · ${entry.by}`}
                meta={
                  <Badge size="sm" tone={entry.approval.state === 'awaiting' ? 'attention' : 'neutral'}>
                    {approvalLabel(entry)}
                  </Badge>
                }
                {...(can
                  ? {
                      actions: (
                        <>
                          {entry.approval.state === 'awaiting' ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              aria-label={`Approve ${entry.app} at ${sha7(entry.sha)}`}
                              onClick={() => {
                                setPending({ action: 'approve', entry });
                              }}
                            >
                              Approve
                            </Button>
                          ) : null}{' '}
                          <Button
                            type="button"
                            size="sm"
                            variant="danger-ghost"
                            aria-label={`Cancel ${entry.app} at ${sha7(entry.sha)}`}
                            onClick={() => {
                              setPending({ action: 'cancel', entry });
                            }}
                          >
                            Cancel
                          </Button>
                        </>
                      ),
                    }
                  : {})}
              />
            ))}
          </DataList>
        </Section>

        <Section title="Fired and cancelled" description="Most recent first. A deploy refused when it fired says why.">
          <DataList
            aria-label="Fired and cancelled deploys"
            empty={
              <EmptyState kind="empty" heading="None yet" size="inline">
                Scheduled deploys appear here once they fire or are cancelled.
              </EmptyState>
            }
          >
            {past.map((entry) => (
              <DataListRow
                key={entry.id}
                href={`/deploys/${entry.deployId}`}
                truncate={false}
                title={`${entry.app} · ${sha7(entry.sha)}`}
                description={
                  entry.refusal !== null
                    ? `${when(entry.fireAt)} · ${entry.refusal.message} ${entry.refusal.fix}`
                    : `${when(entry.fireAt)} · ${entry.by} · ${approvalLabel(entry)}`
                }
                meta={
                  <Badge size="sm" tone={outcomeIsBad(entry) ? 'danger' : 'neutral'}>
                    {outcomeLabel(entry)}
                  </Badge>
                }
              />
            ))}
          </DataList>
        </Section>
      </Stack>

      {can ? (
        <Confirm
          pending={pending}
          onClose={() => {
            setPending(null);
          }}
          onDone={() => {
            setPending(null);
            reload();
          }}
        />
      ) : null}
    </Page>
  );
}
