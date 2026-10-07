import {
  Badge,
  Button,
  Cluster,
  DescriptionItem,
  DescriptionList,
  FormActions,
  FormField,
  Input,
  Modal,
  Stack,
} from '@d3cloud/ui';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { agents as agentApi, isHeartbeatStale, relativeTime, shortDate, type AgentSummary } from '../../lib/admin';
import type { RefusalError } from '../../lib/api';
import { RefusalAlert, asRefusal } from './shared';

/**
 * One agent's enrolment (SHP-REQ-064, SHP-REQ-068), the part of the old Agent screen that is rarely
 * needed: its key fingerprint, who confirmed it, and the two actions — confirming a fingerprint
 * (typed, never pasted from the server's own copy) and, for an admin, revoking. Its heartbeat, its
 * GitHub token and its versions are on the Host health card, once each.
 *
 * A viewer never reaches this (Host needs a state-changing role), and the props still decide every
 * action, so the component cannot offer what a role cannot do.
 */

/** A fingerprint: monospace, and wrapping anywhere so it never pushes a 375 px page sideways. */
export function Fingerprint({ value }: { value: string }) {
  return <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{value}</code>;
}

function ConfirmForm({ agent, onDone }: { agent: AgentSummary; onDone: (a: AgentSummary) => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || typed.trim() === '') return;
    setBusy(true);
    setRefusal(null);
    agentApi
      .confirm(agent.id, typed.trim())
      .then(onDone)
      .catch((error: unknown) => {
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Stack as="form" gap="12" noValidate onSubmit={submit}>
      <RefusalAlert refusal={refusal} />
      <FormField
        label="Type the fingerprint shown on the host"
        help="Read it from the agent's log on the host and type it here. Confirm only if they match."
      >
        <Input
          name="fingerprint"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
          }}
        />
      </FormField>
      <FormActions align="start">
        <Button type="submit" variant="primary" icon={<ShieldCheck />} loading={busy} disabled={typed.trim() === ''}>
          Confirm agent
        </Button>
      </FormActions>
    </Stack>
  );
}

export function AgentEnrolment({
  agent,
  can,
  isAdmin,
  now,
  onChanged,
}: {
  agent: AgentSummary;
  can: boolean;
  isAdmin: boolean;
  now: number;
  onChanged: (a: AgentSummary) => void;
}) {
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const stale = isHeartbeatStale(agent.lastHeartbeatAt, now);

  const revoke = () => {
    setBusy(true);
    setRefusal(null);
    agentApi
      .revoke(agent.id)
      .then((a) => {
        setRevokeOpen(false);
        onChanged(a);
      })
      .catch((error: unknown) => {
        setRevokeOpen(false);
        setRefusal(asRefusal(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Stack gap="12">
      <Cluster gap="8">
        {agent.confirmed ? <Badge tone="neutral">Enrolled</Badge> : <Badge tone="attention">Awaiting confirmation</Badge>}
        {stale ? <Badge tone="danger">Stale</Badge> : null}
      </Cluster>
      <RefusalAlert refusal={refusal} />
      <DescriptionList>
        <DescriptionItem term="Fingerprint">
          <Fingerprint value={agent.fingerprint} />
        </DescriptionItem>
        <DescriptionItem term="Enrolled">
          {shortDate(agent.enrolledAt)}
          {agent.confirmedBy === null ? '' : `, confirmed by ${agent.confirmedBy.displayName}`}
        </DescriptionItem>
        <DescriptionItem term="Last heartbeat">
          {agent.lastHeartbeatAt === null ? 'Never' : relativeTime(agent.lastHeartbeatAt, now)}
        </DescriptionItem>
      </DescriptionList>
      {can && !agent.confirmed ? <ConfirmForm agent={agent} onDone={onChanged} /> : null}
      {can && isAdmin && agent.confirmed ? (
        <FormActions align="start">
          <Button
            type="button"
            variant="danger-ghost"
            icon={<ShieldOff />}
            onClick={() => {
              setRevokeOpen(true);
            }}
          >
            Revoke agent
          </Button>
        </FormActions>
      ) : null}
      {can && isAdmin ? (
        <Modal
          open={revokeOpen}
          onOpenChange={setRevokeOpen}
          title="Revoke this agent?"
          description="It goes back to awaiting confirmation, and every request it signs is refused until someone confirms its fingerprint again."
          destructive
          footer={
            <FormActions>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setRevokeOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button type="button" variant="danger" loading={busy} onClick={revoke}>
                Revoke
              </Button>
            </FormActions>
          }
        />
      ) : null}
    </Stack>
  );
}
