import {
  Alert,
  Badge,
  Button,
  Card,
  Cluster,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Link,
  Modal,
  Page,
  PageHeader,
  Section,
  Spinner,
  Stack,
} from '@d3cloud/ui';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import {
  agents as agentApi,
  isHeartbeatStale,
  relativeTime,
  shortDate,
  type AgentSummary,
  type OutOfBandMonth,
} from '../lib/admin';
import { RefusalError, unreachableRefusal } from '../lib/api';
import { system as systemApi } from '../lib/system';
import { useCan, useMe } from '../lib/auth';

/**
 * S12 Agent (SHP-REQ-064, SHP-REQ-068): each agent's enrolment state, key fingerprint, last
 * heartbeat (stale after five minutes) and reported versions; confirming a fingerprint (typed, never
 * pasted from the server's own copy) and, for an admin, revoking. Below, the out-of-band change
 * count per month from drift resolutions that adopted what was running (SHP-D-085).
 *
 * A viewer sees no action at all (SHP-REQ-105), whatever the route guard does.
 */

/** Installing the server and the agent on a Docker host (docs/runbooks/install.md). */
const INSTALL_RUNBOOK_URL = 'https://github.com/matdemers1/shipyard/blob/main/docs/runbooks/install.md';

function asRefusal(error: unknown): RefusalError {
  return error instanceof RefusalError ? error : unreachableRefusal();
}

function monthLabel(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? month
    : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** A fingerprint: monospace, and wrapping anywhere so it never pushes a 375 px page sideways. */
function Fingerprint({ value }: { value: string }) {
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
      {refusal === null ? null : (
        <Alert tone="danger" title={refusal.message} dynamic>
          {refusal.fix}
        </Alert>
      )}
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

interface PatInfo {
  fingerprint: string;
  patExpiresAt: string | null;
  patWarning: 'none' | 'expiring' | 'expired';
}

function AgentCard({
  agent,
  can,
  isAdmin,
  now,
  onChanged,
  pat,
}: {
  agent: AgentSummary;
  can: boolean;
  isAdmin: boolean;
  now: number;
  onChanged: (a: AgentSummary) => void;
  pat: PatInfo | null;
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
    <Card as="article">
      <Stack gap="16">
        <Cluster gap="8">
          {agent.confirmed ? <Badge tone="neutral">Enrolled</Badge> : <Badge tone="attention">Awaiting confirmation</Badge>}
          {stale ? <Badge tone="danger">Stale</Badge> : null}
        </Cluster>
        {refusal === null ? null : (
          <Alert tone="danger" title={refusal.message} dynamic>
            {refusal.fix}
          </Alert>
        )}
        <DescriptionList>
          <DescriptionItem term="Fingerprint">
            <Fingerprint value={agent.fingerprint} />
          </DescriptionItem>
          <DescriptionItem term="Last heartbeat">
            {agent.lastHeartbeatAt === null ? 'Never' : relativeTime(agent.lastHeartbeatAt, now)}
          </DescriptionItem>
          <DescriptionItem term="Enrolled">
            {shortDate(agent.enrolledAt)}
            {agent.confirmedBy === null ? '' : `, confirmed by ${agent.confirmedBy.displayName}`}
          </DescriptionItem>
          <DescriptionItem term="Agent">{agent.agentVersion ?? 'Not reported'}</DescriptionItem>
          <DescriptionItem term="Compose">{agent.composeVersion ?? 'Not reported'}</DescriptionItem>
          <DescriptionItem term="Engine API">{agent.engineApiVersion ?? 'Not reported'}</DescriptionItem>
          {pat === null ? null : (
            <DescriptionItem term="GitHub token expires">
              {pat.patExpiresAt === null ? 'Not reported' : shortDate(pat.patExpiresAt)}{' '}
              {pat.patWarning === 'expiring' ? <Badge tone="attention">Expiring</Badge> : null}
              {pat.patWarning === 'expired' ? <Badge tone="danger">Expired</Badge> : null}
            </DescriptionItem>
          )}
        </DescriptionList>
        {pat?.patWarning === 'expired' ? (
          <Alert tone="danger" title="The agent's GitHub token has expired">
            Replace it on the host; deploys keep running, but changelog and commit checks stop working.
          </Alert>
        ) : null}
        {pat?.patWarning === 'expiring' ? (
          <Alert tone="warning" title="The agent's GitHub token expires within 30 days">
            Replace it on the host before it does.
          </Alert>
        ) : null}
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
    </Card>
  );
}

export function Agent() {
  const can = useCan();
  const isAdmin = useMe()?.role === 'admin';
  const [list, setList] = useState<AgentSummary[] | null>(null);
  const [months, setMonths] = useState<OutOfBandMonth[] | null>(null);
  const [pat, setPat] = useState<PatInfo | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [a, m] = await Promise.all([agentApi.list(), agentApi.outOfBand(6)]);
      setList(a);
      setMonths(m);
      setNow(Date.now());
      setRefusal(null);
    } catch (error) {
      setRefusal(asRefusal(error));
    }
    // The PAT warning comes from /api/system, read separately so its own refusal (a role that
    // cannot see it) never blocks the agent list above.
    try {
      const status = await systemApi.status();
      setPat(
        status.agent === null
          ? null
          : { fingerprint: status.agent.fingerprint, patExpiresAt: status.agent.patExpiresAt, patWarning: status.agent.patWarning },
      );
    } catch {
      setPat(null);
    }
  }, []);

  useEffect(() => {
    void load();
    // Heartbeats move; re-read every half minute so "stale" is never a stale claim itself.
    const timer = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [load]);

  const replace = (a: AgentSummary) => {
    setList((prev) => (prev === null ? prev : prev.map((x) => (x.id === a.id ? a : x))));
  };

  const staleAgents = (list ?? []).filter((a) => isHeartbeatStale(a.lastHeartbeatAt, now));

  return (
    <Page width="narrow">
      <Stack gap="24">
        <PageHeader title="Agent" description="The host-side agent: its key, its heartbeat and what it runs." />
        {refusal === null ? null : (
          <Alert tone="danger" title={refusal.message} dynamic>
            {refusal.fix}
          </Alert>
        )}
        {list === null && refusal === null ? <Spinner label="Loading agents" /> : null}
        {list !== null && list.length === 0 ? (
          <EmptyState
            kind="empty"
            heading="No agent — see the install runbook"
            headingLevel={2}
            action={
              <Link href={INSTALL_RUNBOOK_URL} target="_blank" rel="noreferrer">
                Install runbook
              </Link>
            }
          >
            Install the agent on the host; it enrols on first start and appears here for its fingerprint to be confirmed.
          </EmptyState>
        ) : null}
        {staleAgents.length > 0 ? (
          <Alert tone="warning" title="The agent has not checked in for over five minutes">
            {staleAgents[0]?.lastHeartbeatAt === null || staleAgents[0] === undefined
              ? 'No heartbeat has ever arrived. '
              : `Last heartbeat ${relativeTime(staleAgents[0].lastHeartbeatAt, now)}. `}
            Deploys wait until it is back. Check that the agent container is running and can reach this server.
          </Alert>
        ) : null}
        {(list ?? []).map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            can={can}
            isAdmin={isAdmin}
            now={now}
            onChanged={replace}
            pat={pat?.fingerprint === agent.fingerprint ? pat : null}
          />
        ))}
        {months === null ? null : (
          <Section
            title="Out-of-band changes"
            description="Drift resolutions that adopted what was running instead of redeploying, per month."
          >
            <DescriptionList>
              {months.map((m) => (
                <DescriptionItem key={m.month} term={monthLabel(m.month)} numeric>
                  {m.count}
                </DescriptionItem>
              ))}
            </DescriptionList>
          </Section>
        )}
      </Stack>
    </Page>
  );
}
