import { Alert, Badge, Button, DataList, DataListRow, DescriptionItem, DescriptionList, FormField, Input, Modal, Spinner } from '@d3cloud/ui';
import type { GroupSummary } from '@shipyard/schema';
import { useEffect, useState } from 'react';
import { RefusalError } from '../lib/api';
import { fetchMemberCommits, startGroupDeploy } from '../lib/groups';

/**
 * Confirms and starts a group deploy from Home (SHP-T-5.11, SHP-REQ-078, SHP-REQ-079). A group dry
 * run is refused server-side (`createGroupDeploy` refuses `dryRun: true`), so this sheet cannot
 * poll gates the way {@link import('./DryRunSheet').DryRunSheet} does for a single app — it is a
 * group-aware confirm sheet, patterned on that one's look, that explains the canary-first order and
 * asks for a SHA before it starts the real thing.
 */
export interface GroupDeploySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null while closed. */
  group: GroupSummary | null;
  /** Called with the deploy ID once the group deploy has started. */
  onStarted?: (deployId: string) => void;
}

type Phase = { kind: 'idle' } | { kind: 'starting' } | { kind: 'refused'; error: RefusalError };

/** 40 hex characters — the same shape `Sha40` requires server-side. */
function isSha40(v: string): boolean {
  return /^[0-9a-f]{40}$/i.test(v);
}

export function GroupDeploySheet({ open, onOpenChange, group, onStarted }: GroupDeploySheetProps) {
  const [sha, setSha] = useState('');
  const [defaultSource, setDefaultSource] = useState<'loading' | 'canary' | 'none'>('loading');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    setPhase({ kind: 'idle' });
    setSha('');
    setDefaultSource('loading');
    if (!open || group === null) return;
    const candidate = group.canary ?? group.members[0] ?? null;
    if (candidate === null) {
      setDefaultSource('none');
      return;
    }
    let cancelled = false;
    void fetchMemberCommits(candidate).then((commits) => {
      if (cancelled) return;
      if (commits?.newestGreen !== null && commits?.newestGreen !== undefined) {
        setSha(commits.newestGreen);
        setDefaultSource('canary');
      } else {
        setDefaultSource('none');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, group]);

  if (group === null) {
    return <Modal open={open} onOpenChange={onOpenChange} title="Deploy group" />;
  }

  const shaValid = isSha40(sha);
  const confirmDisabled = !shaValid || phase.kind === 'starting';

  async function onConfirm(): Promise<void> {
    if (group === null || !shaValid) return;
    setPhase({ kind: 'starting' });
    try {
      const started = await startGroupDeploy(group.name, sha);
      onStarted?.(started.deployId);
      onOpenChange(false);
    } catch (error) {
      if (error instanceof RefusalError) {
        setPhase({ kind: 'refused', error });
      } else {
        throw error;
      }
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Deploy group ${group.name}`}
      description="The canary deploys and soaks first; the rest get the same digests. Any failure stops the group."
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
          <Button variant="primary" loading={phase.kind === 'starting'} disabled={confirmDisabled} onClick={() => void onConfirm()}>
            Confirm
          </Button>
        </>
      }
    >
      <DescriptionList>
        <DescriptionItem term="Members" numeric>
          {group.members.length}
        </DescriptionItem>
      </DescriptionList>

      <DataList aria-label={`Members of ${group.name}, in deploy order`}>
        {group.members.map((member) => (
          <DataListRow
            key={member}
            title={member}
            meta={member === group.canary ? <Badge tone="attention">Canary</Badge> : undefined}
          />
        ))}
      </DataList>

      <FormField label="Target SHA" help={defaultSource === 'canary' ? "Defaulted to the canary's newest green commit." : undefined}>
        <Input
          value={sha}
          onChange={(e) => {
            setSha(e.target.value.trim());
          }}
          placeholder="40-character commit SHA"
          invalid={sha !== '' && !shaValid}
        />
      </FormField>

      {defaultSource === 'loading' ? (
        <p>
          <Spinner size="sm" /> Looking up the canary's newest green commit…
        </p>
      ) : null}

      {defaultSource === 'none' && sha === '' ? <Alert tone="info">No candidate SHA found — enter one to deploy the group.</Alert> : null}

      {phase.kind === 'refused' ? (
        <Alert tone="danger" title={phase.error.message} dynamic>
          {phase.error.fix}
        </Alert>
      ) : null}
    </Modal>
  );
}
