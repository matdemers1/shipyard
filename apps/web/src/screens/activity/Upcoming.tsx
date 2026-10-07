import { Alert, Badge, Button, Card, CardTitle, FormActions, Modal, ModalClose } from '@d3cloud/ui';
import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { RefusalError, unreachableRefusal } from '../../lib/api';
import { sha7 } from '../../lib/appdetail';
import { approvalLabel, schedules, type ScheduleEntry } from '../../lib/schedules';
import { formatDue } from '../../lib/timeline';

/**
 * The Upcoming card pinned over the feed (SHP-T-13.13, SHP-REQ-164): schedules not yet fired,
 * soonest first, each with the approval it carries. A deployer cancels one — or approves one a token
 * scheduled for an approval-required app (SHP-REQ-080/081); a viewer reads. The card is only there
 * when something is scheduled; "Schedule a deploy" sits in the page header either way.
 */

type Pending = { action: 'cancel' | 'approve'; entry: ScheduleEntry };

function problemOf(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

/** When it is due and who set it, in the card's one sentence: "Scheduled Thu 9:00 AM by Matt · …". */
function dueLine(entry: ScheduleEntry, now: Date): string {
  return `Scheduled ${formatDue(entry.fireAt, now)} by ${entry.by} · checks run again when it fires`;
}

function Confirm({ pending, onClose, onDone }: { pending: Pending | null; onClose: () => void; onDone: () => void }) {
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
            ? `It was due ${formatDue(entry.fireAt)}. It will not run; schedule it again if it should.`
            : `It runs ${formatDue(entry.fireAt)} with no further approval. Every check still runs again then.`
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

export interface UpcomingProps {
  entries: readonly ScheduleEntry[];
  can: boolean;
  now: Date;
  onChanged: () => void;
}

export function Upcoming({ entries, can, now, onChanged }: UpcomingProps) {
  const [pending, setPending] = useState<Pending | null>(null);
  return (
    <Card padding="md" as="section" aria-labelledby="activity-upcoming" className="shp-upcoming">
      <div className="shp-upcoming__head">
        <CardTitle id="activity-upcoming" as="h2">
          Upcoming
        </CardTitle>
      </div>
      <ul className="shp-upcoming__list" aria-label="Upcoming deploys">
        {entries.map((entry) => (
          <li key={entry.id} className="shp-upcoming__row">
            <div className="shp-upcoming__text">
              <RouterLink to={`/deploys/${entry.deployId}`} className="shp-upcoming__what">
                <strong>{entry.app}</strong> <code>{sha7(entry.sha)}</code>
              </RouterLink>
              <span className="shp-feed-row__sub">{dueLine(entry, now)}</span>
              <Badge size="sm" tone={entry.approval.state === 'awaiting' ? 'attention' : 'neutral'}>
                {approvalLabel(entry)}
              </Badge>
            </div>
            {can ? (
              <div className="shp-action-row">
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
                ) : null}
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
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {can ? (
        <Confirm
          pending={pending}
          onClose={() => {
            setPending(null);
          }}
          onDone={() => {
            setPending(null);
            onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}
