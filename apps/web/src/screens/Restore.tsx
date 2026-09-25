import { Alert, Badge, Button, DataList, DataListRow, EmptyState, FormField, Input, Link, Modal, Page, PageHeader, Section, Skeleton, Stack } from '@d3cloud/ui';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { sha7, when } from '../lib/appdetail';
import { useCan } from '../lib/auth';
import { confirmMatches, formatBytes, lossSentence, restore, type RestoreCandidate, type RestoreCandidates } from '../lib/restore';

/**
 * Restore (S7), `/apps/:app/restore` (SHP-T-5.6, SHP-REQ-083, SHP-D-038): the backups this app's
 * deploys took, each with the writes a restore of it would lose, in plain words. Choosing one opens
 * a sheet that stays disabled until the app's name is typed exactly; confirming starts the restore
 * and follows it on the live progress screen. One restore per app per 24 hours (SHP-REQ-084). A
 * viewer sees the list and no action.
 */

type Load = { status: 'loading' } | { status: 'error'; error: RefusalError } | { status: 'ready'; data: RestoreCandidates };

function kindLabel(kind: RestoreCandidate['backupDeployKind']): string {
  if (kind === 'restore') return 'safety backup of a restore';
  return kind === 'rollback' ? 'rollback' : 'deploy';
}

interface ConfirmProps {
  app: string;
  candidate: RestoreCandidate | null;
  onClose: () => void;
  onStarted: (deployId: string) => void;
}

/** The confirm sheet: the loss window, then the app's name typed exactly. */
function ConfirmRestore({ app, candidate, onClose, onStarted }: ConfirmProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<RefusalError | null>(null);
  const matches = confirmMatches(typed, app);

  useEffect(() => {
    setTyped('');
    setRefused(null);
    setBusy(false);
  }, [candidate]);

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (candidate === null || !matches) return;
    setBusy(true);
    setRefused(null);
    try {
      const accepted = await restore.start(app, candidate.backupDeployId, typed);
      onStarted(accepted.deployId);
    } catch (error) {
      setRefused(error instanceof RefusalError ? error : unreachableRefusal());
      setBusy(false);
    }
  }

  return (
    <Modal
      open={candidate !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Restore ${app}`}
      destructive
      description={
        candidate === null ? undefined : (
          <>
            <p>
              <strong>{lossSentence(candidate)}</strong>
            </p>
            <p>
              {app}&rsquo;s data goes back to the backup taken {when(candidate.createdAt)}
              {candidate.releaseSha === null ? '' : `, and release ${sha7(candidate.releaseSha)} runs with it`}. A safety backup of the data as it is
              now is taken first.
            </p>
          </>
        )
      }
    >
      <Stack as="form" gap="16" onSubmit={(e) => void submit(e)} noValidate>
        <FormField label={`Type ${app} to confirm`} help="Exactly as written: this cannot be undone by Shipyard.">
          <Input
            value={typed}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => {
              setTyped(e.target.value);
            }}
          />
        </FormField>
        {refused !== null ? (
          <Alert tone="danger" title={refused.message} dynamic>
            {refused.fix}
          </Alert>
        ) : null}
        <Stack gap="8" align="end">
          <Button type="submit" variant="danger" disabled={!matches} loading={busy}>
            Restore {app}
          </Button>
        </Stack>
      </Stack>
    </Modal>
  );
}

export function Restore() {
  const { app = '' } = useParams();
  const can = useCan();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [chosen, setChosen] = useState<RestoreCandidate | null>(null);
  const [reloads, setReloads] = useState(0);

  const reload = useCallback(() => {
    setReloads((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    restore
      .candidates(app, controller.signal)
      .then((data) => {
        setLoad({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ status: 'error', error: error instanceof RefusalError ? error : unreachableRefusal() });
      });
    return () => {
      controller.abort();
    };
  }, [app, reloads]);

  const back = (
    <Link asChild>
      <RouterLink to={`/apps/${encodeURIComponent(app)}`}>{app}</RouterLink>
    </Link>
  );

  if (load.status === 'loading') {
    return (
      <Page aria-busy="true">
        <Stack gap="24">
          <PageHeader title={`Restore ${app}`} back={back} description="Reading the backups this app's deploys took." />
          <Skeleton variant="text" lines={6} />
        </Stack>
      </Page>
    );
  }

  if (load.status === 'error') {
    const { error } = load;
    return (
      <Page>
        <Stack gap="24">
          <PageHeader title={`Restore ${app}`} back={back} />
          <EmptyState
            kind={error.status === 404 ? 'no-results' : 'error'}
            heading={error.message}
            headingLevel={2}
            action={
              <Button type="button" onClick={reload}>
                Try again
              </Button>
            }
          >
            {error.fix}
          </EmptyState>
        </Stack>
      </Page>
    );
  }

  const { data } = load;
  return (
    <Page>
      <Stack gap="24">
        <PageHeader
          title={`Restore ${app}`}
          back={back}
          description="Puts the app's data back to a backup one of its deploys took, and runs the release that matched it."
        />

        <Alert tone="warning" title="A restore discards writes">
          Everything written since the chosen backup is lost. Shipyard takes a safety backup first, allows one restore per app every 24
          hours, and never restores on its own.
        </Alert>

        {data.limited !== null ? (
          <Alert tone="info" title={`${app} was restored ${when(data.limited.lastRestoreAt)}`}>
            Another restore is allowed from {when(data.limited.freesAt)}. Fix forward in the meantime.
          </Alert>
        ) : null}

        {!can ? <Alert tone="info">Your role can read backups but not restore them.</Alert> : null}

        <Section title="Backups" description="Newest first. Only backups this app's own deploys took can be restored.">
          <DataList
            aria-label="Backups"
            empty={
              <EmptyState kind="empty" heading="No backups yet" size="inline">
                A backup appears here once a deploy of {app} runs its backup step.
              </EmptyState>
            }
          >
            {data.candidates.map((candidate) => (
              <DataListRow
                key={`${candidate.backupDeployId}-${candidate.path}`}
                truncate={false}
                title={when(candidate.createdAt)}
                description={lossSentence(candidate)}
                meta={
                  <>
                    <Badge size="sm">{formatBytes(candidate.size)}</Badge>{' '}
                    <Badge size="sm">
                      {kindLabel(candidate.backupDeployKind)} {sha7(candidate.backupDeploySha)}
                    </Badge>
                  </>
                }
                {...(can
                  ? {
                      actions: (
                        <Button
                          type="button"
                          size="sm"
                          variant="danger"
                          disabled={!candidate.available}
                          aria-label={`Restore the backup taken ${when(candidate.createdAt)}`}
                          onClick={() => {
                            setChosen(candidate);
                          }}
                        >
                          Restore
                        </Button>
                      ),
                    }
                  : {})}
              />
            ))}
          </DataList>
        </Section>
      </Stack>

      {can ? (
        <ConfirmRestore
          app={app}
          candidate={chosen}
          onClose={() => {
            setChosen(null);
          }}
          onStarted={(deployId) => {
            void navigate(`/deploys/${deployId}/live`);
          }}
        />
      ) : null}
    </Page>
  );
}
