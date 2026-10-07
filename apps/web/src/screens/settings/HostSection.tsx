import {
  Button,
  DataList,
  DataListRow,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  FormActions,
  Link,
  Modal,
  PageHeader,
  Section,
  SettingsRow,
  Spinner,
  Stack,
  StatusDot,
  type StatusDotTone,
} from '@d3cloud/ui';
import type { SystemBackupRun, SystemStatus } from '@shipyard/schema';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  agents as agentApi,
  isHeartbeatStale,
  relativeTime,
  shortDate,
  type AgentSummary,
  type OutOfBandMonth,
} from '../../lib/admin';
import { request, type RefusalError } from '../../lib/api';
import { useCan, useIsAdmin } from '../../lib/auth';
import { AgentEnrolment } from './AgentEnrolment';
import { RefusalAlert, asRefusal, type SystemStatusState } from './shared';

/**
 * Settings › Host (SHP-T-6.5, SHP-REQ-064/068/094/095/106, SHP-ADR-006): one health checklist that
 * holds every fact the old System and Agent screens showed, each once — the agent, its GitHub
 * token, the Foreman outbox, Shipyard's own backup and restore drill, the build cache on disk, and
 * drift. A row that is fine is a quiet dot; one that is not says why and offers the fix. Agent
 * enrolment and versions are rarely needed, so they sit below, collapsed.
 */

const RUNBOOKS = 'https://github.com/matdemers1/shipyard/blob/main/docs/runbooks';
const INSTALL_RUNBOOK_URL = `${RUNBOOKS}/install.md`;
const UPGRADE_RUNBOOK_URL = `${RUNBOOKS}/upgrade-agent.md`;
const BACKUP_RUNBOOK_URL = `${RUNBOOKS}/install.md#8-backups-and-the-restore-drill`;
/** Where to make the agent's token: fine-grained, public repositories, read-only. */
const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `1234567` bytes → `1.2 GB` (decimal, matching how storage is usually quoted). */
export function humanBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 2 : 1);
  return `${rounded} ${units[unit] ?? 'B'}`;
}

function monthLabel(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? month : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function plural(n: number, one: string, other: string): string {
  return `${String(n)} ${n === 1 ? one : other}`;
}

/** What a health row offers when it is not fine. */
export type HealthFix =
  | { kind: 'confirm' }
  | { kind: 'renew' }
  | { kind: 'external'; label: string; href: string }
  | { kind: 'route'; label: string; to: string };

export interface HealthRow {
  key: string;
  name: string;
  tone: StatusDotTone;
  value: string;
  detail?: string;
  fix?: HealthFix;
}

export interface HealthInput {
  status: SystemStatus | null;
  /** `GET /api/agent`, or null when it could not be read. */
  agents: readonly AgentSummary[] | null;
  /** The apps with open drift, or null when the app list could not be read. */
  drifted: readonly string[] | null;
  /** This month's out-of-band count, when known. */
  outOfBandThisMonth: number | null;
  now: number;
}

function agentRow({ status, agents, now }: HealthInput): HealthRow {
  const name = 'Agent';
  if (agents !== null && agents.length === 0) {
    return {
      key: 'agent',
      name,
      tone: 'danger',
      value: 'No agent enrolled',
      detail: 'Install the agent on the host; it enrols on first start and appears below for its fingerprint to be confirmed.',
      fix: { kind: 'external', label: 'Install runbook', href: INSTALL_RUNBOOK_URL },
    };
  }
  const primary = agents?.find((a) => a.confirmed) ?? agents?.[0] ?? null;
  if (primary !== null && !primary.confirmed) {
    return {
      key: 'agent',
      name,
      tone: 'attention',
      value: 'Waiting for its fingerprint to be confirmed',
      detail: 'Until a person confirms it, every request it signs is refused and nothing deploys.',
      fix: { kind: 'confirm' },
    };
  }
  const lastHeartbeatAt = primary?.lastHeartbeatAt ?? status?.agent?.lastHeartbeatAt ?? null;
  const stale = primary !== null ? isHeartbeatStale(primary.lastHeartbeatAt, now) : (status?.agent?.stale ?? false);
  if (stale) {
    return {
      key: 'agent',
      name,
      tone: 'danger',
      value: lastHeartbeatAt === null ? 'No heartbeat has ever arrived' : `Not checked in since ${relativeTime(lastHeartbeatAt, now)}`,
      detail: 'Deploys wait until it is back. Check that the agent container is running and can reach this server.',
    };
  }
  const unstarted = status?.agent?.unstartedTargets ?? 0;
  if (unstarted > 0) {
    return {
      key: 'agent',
      name,
      tone: 'danger',
      value: `Not taking work: ${plural(unstarted, 'deploy or dry run', 'deploys or dry runs')} handed to it never started`,
      detail: 'It is heartbeating, so this usually means the agent is older than the server. Upgrade it on the host and check its log for “poll failed”.',
      fix: { kind: 'external', label: 'Upgrade runbook', href: UPGRADE_RUNBOOK_URL },
    };
  }
  return {
    key: 'agent',
    name,
    tone: 'idle',
    value: lastHeartbeatAt === null ? 'Enrolled' : `Checked in ${relativeTime(lastHeartbeatAt, now)}`,
  };
}

function patRow({ status, now }: HealthInput): HealthRow | null {
  if (status === null) return null;
  const name = "Agent's GitHub token";
  const agent = status.agent;
  if (agent === null) return { key: 'pat', name, tone: 'idle', value: 'Not reported — there is no enrolled agent' };
  if (agent.patExpiresAt === null) return { key: 'pat', name, tone: 'idle', value: 'Expiry not reported' };
  const at = Date.parse(agent.patExpiresAt);
  const days = Math.ceil((at - now) / DAY_MS);
  const date = shortDate(agent.patExpiresAt);
  if (agent.patWarning === 'expired' || days <= 0) {
    return {
      key: 'pat',
      name,
      tone: 'danger',
      value: `Expired · ${date}`,
      detail: 'Deploys cannot read commit history or check runs until it is replaced on the host.',
      fix: { kind: 'renew' },
    };
  }
  const when = `Expires in ${plural(days, 'day', 'days')} · ${date}`;
  if (agent.patWarning === 'expiring') {
    return { key: 'pat', name, tone: 'warning', value: when, detail: 'Replace it on the host before it does.', fix: { kind: 'renew' } };
  }
  return { key: 'pat', name, tone: 'idle', value: when };
}

function outboxRow({ status }: HealthInput): HealthRow | null {
  if (status === null) return null;
  const { unsent, unsentOverHour, oldestUnsentAt, lastError } = status.outbox;
  const name = 'Foreman outbox';
  const errorLine = lastError === null ? undefined : `Last error: ${lastError}`;
  if (unsent === 0) return { key: 'outbox', name, tone: 'idle', value: 'Nothing waiting', ...(errorLine === undefined ? {} : { detail: errorLine }) };
  const oldest = oldestUnsentAt === null ? '' : ` · oldest since ${shortDate(oldestUnsentAt)}`;
  if (unsentOverHour > 0) {
    return {
      key: 'outbox',
      name,
      tone: 'warning',
      value: `${plural(unsentOverHour, 'deploy has', 'deploys have')} waited over an hour to be recorded in Foreman · ${String(unsent)} waiting in all${oldest}`,
      detail: errorLine ?? 'Shipyard keeps retrying; check that Foreman is up and FOREMAN_TOKEN in server.env is still valid.',
    };
  }
  return { key: 'outbox', name, tone: 'idle', value: `${String(unsent)} waiting${oldest}`, ...(errorLine === undefined ? {} : { detail: errorLine }) };
}

function runRow(key: string, name: string, run: SystemBackupRun | null): HealthRow {
  if (run === null) {
    return {
      key,
      name,
      tone: 'warning',
      value: 'Never run',
      detail: 'It runs nightly once BACKUP_DIR is set in server.env.',
      fix: { kind: 'external', label: 'Backup runbook', href: BACKUP_RUNBOOK_URL },
    };
  }
  const where = run.file === null ? '' : ` · ${run.file}`;
  if (!run.ok) {
    return {
      key,
      name,
      tone: 'danger',
      value: `Failed · ${shortDate(run.at)}${where}`,
      ...(run.error === null ? {} : { detail: run.error }),
      fix: { kind: 'external', label: 'Backup runbook', href: BACKUP_RUNBOOK_URL },
    };
  }
  return { key, name, tone: 'idle', value: `Ok · ${shortDate(run.at)}${where}` };
}

function diskRow({ status }: HealthInput): HealthRow | null {
  if (status === null) return null;
  const cache = status.buildCache;
  if (cache === null) return { key: 'disk', name: 'Disk', tone: 'idle', value: 'Build cache not yet reported' };
  const cleaned = cache.lastGcAt === null ? 'never cleaned' : `cleaned ${shortDate(cache.lastGcAt)}`;
  const limits =
    cache.limitsApplied === null
      ? 'limits not yet applied'
      : `limits ${plural(cache.limitsApplied.cpus, 'CPU', 'CPUs')}, ${String(cache.limitsApplied.memoryMb)} MiB`;
  const value = `Build cache ${humanBytes(cache.bytes)} of a ${humanBytes(cache.capBytes)} cap · ${cleaned} · ${limits}`;
  if (cache.bytes > cache.capBytes) {
    return {
      key: 'disk',
      name: 'Disk',
      tone: 'warning',
      value,
      detail: 'The build cache is over its cap; the agent trims it at its next garbage collection.',
    };
  }
  return { key: 'disk', name: 'Disk', tone: 'idle', value };
}

function driftRow({ drifted, outOfBandThisMonth }: HealthInput): HealthRow | null {
  if (drifted === null) return null;
  const oob = outOfBandThisMonth === null ? '' : ` · ${plural(outOfBandThisMonth, 'out-of-band change', 'out-of-band changes')} this month`;
  const first = drifted[0];
  if (first === undefined) return { key: 'drift', name: 'Drift', tone: 'idle', value: `None${oob}` };
  return {
    key: 'drift',
    name: 'Drift',
    tone: 'warning',
    value: `${drifted.length === 1 ? first : `${String(drifted.length)} apps (${drifted.join(', ')})`} running something Shipyard did not deploy${oob}`,
    detail: 'Shipyard refuses the next deploy of a drifted app until someone resolves it on its page.',
    fix: { kind: 'route', label: `Open ${first}`, to: `/apps/${encodeURIComponent(first)}` },
  };
}

/** The checklist, in the order a person reads it. Pure, so each row's wording is tested directly. */
export function healthRows(input: HealthInput): HealthRow[] {
  const status = input.status;
  return [
    agentRow(input),
    patRow(input),
    outboxRow(input),
    status === null ? null : runRow('backup', 'Nightly backup of Shipyard', status.backups.lastBackup),
    status === null ? null : runRow('drill', 'Restore drill', status.backups.lastDrill),
    diskRow(input),
    driftRow(input),
  ].filter((row): row is HealthRow => row !== null);
}

function RenewModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Renew the agent's GitHub token"
      description="The token lives on the host, never in Shipyard, so it is replaced there."
      footer={
        <FormActions>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Close
          </Button>
        </FormActions>
      }
    >
      <ol className="shp-settings__steps">
        <li>
          Make a new fine-grained token at{' '}
          <Link href={NEW_TOKEN_URL} target="_blank" rel="noreferrer" variant="inline">
            GitHub → Fine-grained tokens
          </Link>{' '}
          with read-only access to the repositories Shipyard deploys.
        </li>
        <li>
          On the host, set it as <code>GITHUB_TOKEN_AGENT</code> in <code>agent.env</code> (
          <Link href={INSTALL_RUNBOOK_URL} target="_blank" rel="noreferrer" variant="inline">
            install runbook
          </Link>
          , step 1).
        </li>
        <li>Restart the agent. Its next heartbeat reports the new expiry here.</li>
      </ol>
    </Modal>
  );
}

function FixAction({ fix, can, onConfirm, onRenew }: { fix: HealthFix; can: boolean; onConfirm: () => void; onRenew: () => void }) {
  switch (fix.kind) {
    case 'confirm':
      return can ? (
        <Button type="button" variant="secondary" size="sm" onClick={onConfirm}>
          Confirm…
        </Button>
      ) : null;
    case 'renew':
      return (
        <Button type="button" variant="secondary" size="sm" onClick={onRenew}>
          Renew…
        </Button>
      );
    case 'external':
      return (
        <Link href={fix.href} target="_blank" rel="noreferrer">
          {fix.label}
        </Link>
      );
    case 'route':
      return (
        <Link asChild>
          <RouterLink to={fix.to}>{fix.label}</RouterLink>
        </Link>
      );
  }
}

function HealthDescription({ row }: { row: HealthRow }): ReactNode {
  return (
    <>
      <span className="shp-health__value">{row.value}</span>
      {row.detail === undefined ? null : <span className="shp-health__detail">{row.detail}</span>}
    </>
  );
}

interface AppDrift {
  name: string;
  drift: { id: string } | null;
}

export function HostSection({ system }: { system: SystemStatusState }) {
  const can = useCan();
  const isAdmin = useIsAdmin();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [months, setMonths] = useState<OutOfBandMonth[] | null>(null);
  const [drifted, setDrifted] = useState<string[] | null>(null);
  const [schema, setSchema] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<RefusalError | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [enrolmentOpen, setEnrolmentOpen] = useState<boolean | null>(null);
  const [oobOpen, setOobOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const enrolmentRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [a, m] = await Promise.all([agentApi.list(), agentApi.outOfBand(6)]);
      setAgents(a);
      setMonths(m);
      setNow(Date.now());
      setRefusal(null);
    } catch (error) {
      setRefusal(asRefusal(error));
    }
    // Drift and the schema revision are separate reads so a failure of either never hides the agent.
    try {
      const { apps } = await request<{ apps: AppDrift[] }>('/api/apps');
      setDrifted(apps.filter((app) => app.drift !== null).map((app) => app.name));
    } catch {
      setDrifted(null);
    }
    try {
      const health = await request<{ schemaRevision?: string | null }>('/api/health', { sessionBearing: false });
      setSchema(health.schemaRevision ?? null);
    } catch {
      setSchema(null);
    }
  }, []);

  useEffect(() => {
    void load();
    // Heartbeats move; re-read every half minute so "checked in" is never a stale claim itself.
    const timer = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [load]);

  const replace = (a: AgentSummary) => {
    setAgents((prev) => (prev === null ? prev : prev.map((x) => (x.id === a.id ? a : x))));
    system.reload();
  };

  const status = system.status;
  const currentMonth = new Date(now).toISOString().slice(0, 7);
  const thisMonth = months === null ? null : (months.find((m) => m.month === currentMonth)?.count ?? 0);
  const rows = healthRows({ status, agents, drifted, outOfBandThisMonth: thisMonth, now });
  const loading = (status === null && system.refusal === null) || (agents === null && refusal === null);
  // An agent waiting for its fingerprint is the one thing below that needs a person, so it starts open.
  const awaiting = (agents ?? []).some((a) => !a.confirmed);
  const showEnrolment = enrolmentOpen ?? awaiting;

  const openEnrolment = () => {
    setEnrolmentOpen(true);
    window.setTimeout(() => {
      try {
        enrolmentRef.current?.scrollIntoView({ block: 'start' });
      } catch {
        // Scrolling is a courtesy; a browser (or jsdom) without it still shows the opened row.
      }
    }, 0);
  };

  const versions = status?.versions;
  const enrolledSummary =
    agents === null
      ? 'Not known'
      : agents.length === 0
        ? 'None yet — the agent enrols itself on first start'
        : agents.map((a) => `${a.confirmed ? 'Enrolled' : 'Awaiting confirmation'} · ${a.fingerprint.slice(0, 19)}…`).join('; ');

  return (
    <Stack gap="24">
      <PageHeader title="Host" description="The server, its agent and Shipyard's own backups — what needs a look, and how to fix it." />
      <RefusalAlert refusal={system.refusal} />
      <RefusalAlert refusal={refusal} />
      {loading ? <Spinner label="Loading host health" /> : null}

      <Section title="Health">
        <DataList aria-label="Host health">
          {rows.map((row) => (
            <DataListRow
              key={row.key}
              truncate={false}
              title={
                <StatusDot tone={row.tone} size="sm">
                  {row.name}
                </StatusDot>
              }
              description={<HealthDescription row={row} />}
              actions={
                row.fix === undefined ? undefined : (
                  <FixAction
                    fix={row.fix}
                    can={can}
                    onConfirm={openEnrolment}
                    onRenew={() => {
                      setRenewOpen(true);
                    }}
                  />
                )
              }
            />
          ))}
        </DataList>
      </Section>

      <Section title="Rarely needed">
        <Stack gap="16">
          <div ref={enrolmentRef}>
            <SettingsRow
              title="Agent enrolment"
              description={enrolledSummary}
              control={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={showEnrolment}
                  aria-controls="shp-agent-enrolment"
                  onClick={() => {
                    setEnrolmentOpen(!showEnrolment);
                  }}
                >
                  {showEnrolment ? 'Hide' : 'Show'} enrolment
                </Button>
              }
            />
          </div>
          {showEnrolment ? (
            <div id="shp-agent-enrolment">
              {agents !== null && agents.length === 0 ? (
                <EmptyState
                  kind="empty"
                  size="inline"
                  heading="No agent — see the install runbook"
                  headingLevel={3}
                  action={
                    <Link href={INSTALL_RUNBOOK_URL} target="_blank" rel="noreferrer">
                      Install runbook
                    </Link>
                  }
                >
                  Install the agent on the host; it enrols on first start and appears here for its fingerprint to be confirmed.
                </EmptyState>
              ) : null}
              <Stack gap="24">
                {(agents ?? []).map((agent) => (
                  <AgentEnrolment key={agent.id} agent={agent} can={can} isAdmin={isAdmin} now={now} onChanged={replace} />
                ))}
              </Stack>
            </div>
          ) : null}

          <SettingsRow
            title="Out-of-band changes"
            description="Drift resolutions that adopted what was running instead of redeploying, per month."
            control={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={oobOpen}
                aria-controls="shp-out-of-band"
                onClick={() => {
                  setOobOpen(!oobOpen);
                }}
              >
                {oobOpen ? 'Hide' : 'Show'} months
              </Button>
            }
          />
          {oobOpen ? (
            <div id="shp-out-of-band">
              {months === null ? (
                <p className="shp-status__detail">Not known.</p>
              ) : (
                <DescriptionList>
                  {months.map((m) => (
                    <DescriptionItem key={m.month} term={monthLabel(m.month)} numeric>
                      {m.count}
                    </DescriptionItem>
                  ))}
                </DescriptionList>
              )}
            </div>
          ) : null}

          {versions === undefined ? null : (
            <p className="shp-status__detail">
              Versions: server <code>{versions.server}</code> · agent {versions.agent ?? 'not reported'} · compose{' '}
              {versions.compose ?? 'not reported'} · engine API {versions.engineApi ?? 'not reported'} · schema{' '}
              {schema ?? 'not reported'}
            </p>
          )}
        </Stack>
      </Section>
      <RenewModal open={renewOpen} onOpenChange={setRenewOpen} />
    </Stack>
  );
}
