import { Alert, Badge, DescriptionItem, DescriptionList, Page, PageHeader, Section, Spinner, Stack } from '@d3cloud/ui';
import type { SystemBackupRun, SystemStatus } from '@shipyard/schema';
import { useCallback, useEffect, useState } from 'react';
import { system as systemApi } from '../lib/system';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { shortDate } from '../lib/admin';

/**
 * S15 System (SHP-T-6.5, SHP-REQ-094/095/106): Shipyard's own versions, the confirmed agent's
 * heartbeat and PAT expiry, the Foreman outbox backlog, and Shipyard's own backups. Deployer-only
 * (a viewer and a token are refused by the server before this ever loads).
 */

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

function BackupRow({ label, run }: { label: string; run: SystemBackupRun | null }) {
  if (run === null) {
    return <DescriptionItem term={label}>Never run</DescriptionItem>;
  }
  return (
    <DescriptionItem term={label}>
      <Stack gap="4">
        <span>
          {run.ok ? <Badge tone="neutral">Ok</Badge> : <Badge tone="danger">Failed</Badge>} {shortDate(run.at)}
        </span>
        {run.error !== null ? <span>{run.error}</span> : null}
        {run.file !== null ? <span>{run.file}</span> : null}
      </Stack>
    </DescriptionItem>
  );
}

export function System() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await systemApi.status());
      setRefusal(null);
    } catch (error) {
      setRefusal(asRefusal(error));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [load]);

  return (
    <Page width="narrow">
      <Stack gap="24">
        <PageHeader title="System" description="Versions, the Foreman outbox, and Shipyard's own backups." />
        {refusal === null ? null : (
          <Alert tone="danger" title={refusal.message} dynamic>
            {refusal.fix}
          </Alert>
        )}
        {status === null && refusal === null ? <Spinner label="Loading system status" /> : null}

        {status === null ? null : (
          <>
            {status.outbox.unsentOverHour > 0 ? (
              <Alert tone="warning" title="Deploys not yet recorded in Foreman">
                {status.outbox.unsentOverHour} deploy{status.outbox.unsentOverHour === 1 ? '' : 's'} have been waiting to post to Foreman for
                over an hour.
              </Alert>
            ) : null}
            {status.agent?.patWarning === 'expired' ? (
              <Alert tone="danger" title="The agent's GitHub token has expired">
                Deploys will refuse to read commit history and check runs until it is replaced.
              </Alert>
            ) : null}
            {status.agent?.patWarning === 'expiring' ? (
              <Alert tone="warning" title="The agent's GitHub token expires soon">
                Replace it within 30 days to avoid an interruption.
              </Alert>
            ) : null}

            <Section title="Versions">
              <DescriptionList>
                <DescriptionItem term="Server">{status.versions.server}</DescriptionItem>
                <DescriptionItem term="Agent">{status.versions.agent ?? 'Not reported'}</DescriptionItem>
                <DescriptionItem term="Compose">{status.versions.compose ?? 'Not reported'}</DescriptionItem>
                <DescriptionItem term="Engine API">{status.versions.engineApi ?? 'Not reported'}</DescriptionItem>
              </DescriptionList>
            </Section>

            <Section title="Foreman outbox">
              <DescriptionList>
                <DescriptionItem term="Unsent" numeric>
                  {status.outbox.unsent}
                </DescriptionItem>
                <DescriptionItem term="Unsent over an hour" numeric>
                  {status.outbox.unsentOverHour}
                </DescriptionItem>
                <DescriptionItem term="Oldest unsent">
                  {status.outbox.oldestUnsentAt === null ? 'None' : shortDate(status.outbox.oldestUnsentAt)}
                </DescriptionItem>
                {status.outbox.lastError === null ? null : (
                  <DescriptionItem term="Last error">{status.outbox.lastError}</DescriptionItem>
                )}
              </DescriptionList>
            </Section>

            <Section title="Shipyard's own backups">
              <DescriptionList>
                <BackupRow label="Last backup" run={status.backups.lastBackup} />
                <BackupRow label="Last restore drill" run={status.backups.lastDrill} />
              </DescriptionList>
            </Section>

            <Section title="Agent PAT">
              {status.agent === null ? (
                <DescriptionList>
                  <DescriptionItem term="Status">No agent enrolled</DescriptionItem>
                </DescriptionList>
              ) : (
                <DescriptionList>
                  <DescriptionItem term="Expires">
                    {status.agent.patExpiresAt === null ? 'Not reported' : shortDate(status.agent.patExpiresAt)}
                  </DescriptionItem>
                  <DescriptionItem term="Status">
                    {status.agent.patWarning === 'none' ? (
                      <Badge tone="neutral">Ok</Badge>
                    ) : status.agent.patWarning === 'expiring' ? (
                      <Badge tone="attention">Expiring soon</Badge>
                    ) : (
                      <Badge tone="danger">Expired</Badge>
                    )}
                  </DescriptionItem>
                </DescriptionList>
              )}
            </Section>
          </>
        )}
      </Stack>
    </Page>
  );
}
